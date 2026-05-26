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
async function graphFetch(pathOrUrl, init) {
  const accessToken = await getOwnerAccessToken();
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
  const headers = Object.assign({}, (init && init.headers) || {}, {
    Authorization: `Bearer ${accessToken}`,
  });
  return fetch(url, Object.assign({}, init || {}, { headers }));
}

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
  "UpdatedBy","LastUpdated","Archived","PDFFilename",
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
      obj[headers[c]] = row[c] !== undefined && row[c] !== null ? row[c] : "";
    }
    rows.push(obj);
  }
  return rows;
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

module.exports = {
  getOwnerAccessToken, graphFetch, graphJson, workbookItemId,
  readSheet, writeSheet, ORDERS_HEADERS, HISTORY_HEADERS,
};
