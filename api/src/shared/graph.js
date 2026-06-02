// Microsoft Graph calls executed AS THE OWNER. Pulls the stored
// refresh token, mints a fresh access token, calls Graph. Anyone in
// the org can hit our /api/* endpoints (after caller auth) and we
// proxy through the owner's identity here — so no per-user .All
// scopes needed.

const tokenStore = require("./tokenStore");
const msal = require("./msal");

let _cached = null; // { accessToken, expiresOn }

async function getOwnerAccessToken() {
  const now = Date.now();
  // 60s safety margin against clock skew.
  if (_cached && _cached.expiresOn - 60_000 > now) return _cached.accessToken;

  const stored = await tokenStore.load();
  if (!stored || !stored.refreshToken) {
    const e = new Error(
      "Owner has not completed /api/auth/setup yet. The app cannot reach OneDrive until that one-time setup runs."
    );
    e.status = 503;
    e.code = "OWNER_NOT_AUTHED";
    throw e;
  }
  let res;
  try {
    res = await msal.acquireFromRefresh(stored.refreshToken);
  } catch (e) {
    const wrapped = new Error(
      `Owner refresh-token grant failed: ${e.errorMessage || e.message}. ` +
      `Owner must re-run /api/auth/setup.`
    );
    wrapped.status = 503;
    wrapped.code = "OWNER_REFRESH_FAILED";
    throw wrapped;
  }
  _cached = {
    accessToken: res.accessToken,
    expiresOn: (res.expiresOn ? new Date(res.expiresOn).getTime() : now + 50 * 60 * 1000),
  };
  return _cached.accessToken;
}

// Generic fetch wrapper: prepends owner's bearer + base URL when given
// a relative path. Returns the raw Response for the caller to handle.
// 2026-05-25 hardening: retries on transient 429 / 5xx responses with
// exponential backoff. Honours the Retry-After header when present.
async function graphFetch(pathOrUrl, init, attempt = 0) {
  const accessToken = await getOwnerAccessToken();
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
  const headers = Object.assign({}, (init && init.headers) || {}, {
    Authorization: `Bearer ${accessToken}`,
  });
  let r;
  try {
    r = await fetch(url, Object.assign({}, init || {}, { headers }));
  } catch (netErr) {
    // Network failure: retry up to 3 times with backoff.
    if (attempt < 3) {
      await sleep(250 * Math.pow(2, attempt));
      return graphFetch(pathOrUrl, init, attempt + 1);
    }
    throw netErr;
  }
  // Retry once on 429 / 5xx (except 501 Not Implemented).
  if ((r.status === 429 || (r.status >= 500 && r.status !== 501)) && attempt < 3) {
    const ra = parseInt(r.headers.get("retry-after") || "", 10);
    const wait = Number.isFinite(ra) && ra > 0 && ra < 60 ? ra * 1000 : (500 * Math.pow(2, attempt));
    await sleep(wait);
    return graphFetch(pathOrUrl, init, attempt + 1);
  }
  return r;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function graphJson(pathOrUrl, init) {
  const r = await graphFetch(pathOrUrl, init);
  const txt = await r.text();
  let body;
  try { body = txt ? JSON.parse(txt) : {}; } catch (_) { body = { raw: txt }; }
  if (!r.ok) {
    const e = new Error(`Graph ${r.status} ${(body.error && body.error.code) || ""}: ${(body.error && body.error.message) || txt.slice(0, 200)}`);
    e.status = r.status;
    e.graph = body.error || null;
    throw e;
  }
  return body;
}

// Resolve the workbook itemId by filename inside the ASP-CallUp folder.
// Cached for the lifetime of the function instance (cheap).
let _workbookItemId = null;
async function workbookItemId(filename) {
  if (_workbookItemId) return _workbookItemId;
  const fname = filename || "CallUpForm_Data.xlsx";
  const meta = await graphJson(
    `/me/drive/root:/ASP-CallUp/${encodeURIComponent(fname)}`
  );
  _workbookItemId = meta.id;
  return _workbookItemId;
}

// Spreadsheet helpers — used by the orders endpoints.

const ORDERS_HEADERS = [
  "OrderID","Event","StartDate","EndDate","StartTime","EndTime",
  "Days","Coverage","NumGuards","Location","SiteContact",
  "ContactNumber","PPERequired","Duties","Status",
  "UpdatedBy","LastUpdated","Archived","PDFFilename","Version",
];
const HISTORY_HEADERS = ["OrderID","Status","ChangedBy","Timestamp","Notes"];

function colLetter(zeroBased) {
  let n = zeroBased + 1, s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel returns date-formatted cells as numeric serials (days since
// 1900-01-01, with the 1900 leap-year bug). Convert known date columns
// back to ISO strings so the frontend doesn't render "45851" as a date.
const DATE_ONLY_COLS = new Set(["StartDate", "EndDate"]);
const DATE_TIME_COLS = new Set(["LastUpdated", "Timestamp"]);

function excelSerialToISO(serial, dateOnly) {
  const ms = (Number(serial) - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return String(serial);
  if (dateOnly) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return d.toISOString();
}

async function readSheet(itemId, sheetName) {
  const body = await graphJson(
    `/me/drive/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')/usedRange?$select=values`
  ).catch((e) => {
    // empty / missing → return null so caller can treat as empty.
    if (e.status === 404 || (e.graph && e.graph.code === "ItemNotFound")) return null;
    throw e;
  });
  if (!body) return [];
  const values = body.values || [];
  if (values.length < 1) return [];
  const headers = values[0].map((h) => String(h));
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      let v = row[c] !== undefined && row[c] !== null ? row[c] : "";
      if (typeof v === "number" && (DATE_ONLY_COLS.has(headers[c]) || DATE_TIME_COLS.has(headers[c]))) {
        v = excelSerialToISO(v, DATE_ONLY_COLS.has(headers[c]));
      }
      obj[headers[c]] = v;
    }
    rows.push(obj);
  }
  return rows;
}

// Backup worksheet copy. Used pre-write to ensure we never destroy
// data. Best-effort: if the copy fails we still proceed (we'd rather
// risk losing yesterday's snapshot than refuse a save).
async function snapshotSheet(itemId, srcSheet, prefix) {
  try {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `${prefix}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const r = await graphFetch(
      `/me/drive/items/${itemId}/workbook/worksheets('${encodeURIComponent(srcSheet)}')/copy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }
    );
    return r.ok;
  } catch (_) {
    return false;
  }
}

// Prune snapshots older than the most recent N per prefix.
const BACKUP_KEEP = 10;
async function pruneSnapshots(itemId, prefix) {
  try {
    const list = await graphJson(`/me/drive/items/${itemId}/workbook/worksheets`);
    const matches = (list.value || [])
      .filter((s) => s.name && s.name.startsWith(prefix + "_"))
      .sort((a, b) => a.name < b.name ? 1 : -1);
    const toDelete = matches.slice(BACKUP_KEEP);
    for (const sheet of toDelete) {
      await graphFetch(
        `/me/drive/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheet.name)}')`,
        { method: "DELETE" }
      ).catch(() => {});
    }
  } catch (_) {
    // Pruning is best-effort, never blocks.
  }
}

// Server-side anti-wipe sanity. If proposed rows < 50% of baseline AND
// baseline had >2 rows, refuse the save. Caller must explicitly opt
// out (e.g., orderDelete passes allowShrink=true).
function antiWipeOrThrow(label, proposedCount, baselineCount, allowShrink) {
  if (allowShrink) return;
  if (baselineCount <= 2) return;
  if (proposedCount >= baselineCount * 0.5) return;
  const e = new Error(
    `Anti-wipe guard refused write to ${label}: ` +
    `would shrink rows from ${baselineCount} to ${proposedCount}. ` +
    `Pass allowShrink=true to override.`
  );
  e.status = 409;
  e.code = "ANTI_WIPE_REFUSED";
  throw e;
}

// Write rows to a worksheet by clearing then re-writing the used range.
async function writeSheet(itemId, sheetName, rows, headerOrder) {
  const base = `/me/drive/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')`;
  // 1) Clear current used range (no-op if empty).
  try {
    await graphFetch(`${base}/usedRange/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applyTo: "contents" }),
    }).then(async (r) => {
      if (!r.ok && r.status !== 404) {
        const txt = await r.text();
        throw new Error(`clear used range failed: ${r.status} ${txt.slice(0, 200)}`);
      }
    });
  } catch (e) {
    // benign on empty sheet
  }

  // 2) Build a values matrix and PATCH a single rectangular range.
  const values = [headerOrder.slice()];
  for (const row of rows) {
    const r = [];
    for (const h of headerOrder) {
      const v = row[h];
      r.push(v !== undefined && v !== null ? v : "");
    }
    values.push(r);
  }
  const lastCol = colLetter(headerOrder.length - 1);
  const lastRow = values.length;
  const addr = `A1:${lastCol}${lastRow}`;
  const r = await graphFetch(
    `${base}/range(address='${addr}')`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`writeSheet PATCH failed: ${r.status} ${txt.slice(0, 200)}`);
  }
}

// Idempotently create a worksheet in the workbook. Returns true if the
// sheet now exists (whether we created it or it already existed). Used by
// modules that add new sheets (e.g., Submitters) so they don't have to
// hardcode a pre-deploy step. Cheap when the sheet already exists (Graph
// 409 on duplicate is caught and treated as success).
async function ensureSheetExists(itemId, sheetName) {
  try {
    const r = await graphFetch(
      `/me/drive/items/${itemId}/workbook/worksheets/add`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sheetName }),
      }
    );
    if (r.ok) return true;
    // Graph returns 400 InvalidArgument when the sheet name already exists.
    // Treat that as success; surface anything else.
    const txt = await r.text();
    if (txt && txt.toLowerCase().includes("already exist")) return true;
    if (r.status === 400) return true;  // most "already exists" variants land here
    throw new Error(`ensureSheetExists ${sheetName} failed: ${r.status} ${txt.slice(0, 200)}`);
  } catch (e) {
    // If the error message itself tells us the sheet exists, that's fine.
    if (String(e.message || "").toLowerCase().includes("already exist")) return true;
    throw e;
  }
}

module.exports = {
  getOwnerAccessToken, graphFetch, graphJson, workbookItemId,
  readSheet, writeSheet, ORDERS_HEADERS, HISTORY_HEADERS,
  snapshotSheet, pruneSnapshots, antiWipeOrThrow,
  ensureSheetExists,
};
