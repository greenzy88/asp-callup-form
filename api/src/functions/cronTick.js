// GET/POST /api/cron — time-based auto-status engine. Pinged on a schedule by
// an EXTERNAL scheduler (GitHub Actions) because Azure SWA managed functions are
// HTTP-only (no timer triggers). Gated by a shared secret (x-cron-secret ==
// env CRON_SECRET). Sends mail + reads/writes the workbook AS THE OWNER via the
// stored refresh token (graph.js), so no logged-in user is required.
//
// For each order it computes the action via the pure logic in shared/autoStatus
// (start = StartDate + StartTime in America/Toronto):
//   WARN     8h before start, still Pending  -> advisory to Farhad + Pat
//   EXPIRE   at start, Scheduled             -> "auto-completes in 8h" to Farhad + Pat
//   COMPLETE 8h after start, Scheduled       -> set Completed + standard completion email
// Idempotent via the NotifiedStartingSoon / NotifiedExpiry flags + the Completed
// status. The email is sent BEFORE the flag/status is set, so a failed send
// simply retries next tick rather than being silently marked done.

const { app } = require("@azure/functions");
const crypto = require("crypto");
const config = require("../shared/config");
const {
  graphFetch, readSheet, writeSheet, workbookItemId,
  ORDERS_HEADERS, HISTORY_HEADERS, snapshotSheet, pruneSnapshots, antiWipeOrThrow,
} = require("../shared/graph");
const { decideAction } = require("../shared/autoStatus");

// Recipients (mirror index.html / roles.js).
const FARHAD = "fmohammad@security-asp.com";
const PAT = "pdeal@security-asp.com";
const ADMIN = "dramlagan@security-asp.com";
const ORDERS_BASKET = "orders@security-asp.com";

const _MONTHS = ["January","February","March","April","May","June","July",
                 "August","September","October","November","December"];
function fmtDate(s) {
  if (!s) return "";
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) { const mo = Number(m[2]); return (mo >= 1 && mo <= 12) ? `${m[3]} ${_MONTHS[mo-1]} ${m[1]}` : str; }
  return str;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function dutiesHtml(duties) {
  if (!duties || !String(duties).trim()) return "";
  const items = String(duties).split(/\r?\n+|(?=•)/).map((s) => s.replace(/^[\s•\-*]+/, "").trim()).filter(Boolean);
  if (!items.length) return "";
  return '<p style="margin:6px 0 2px"><strong>Duties:</strong></p><ul style="margin-top:0;padding-left:20px">'
    + items.map((s) => `<li>${esc(s)}</li>`).join("") + "</ul>";
}
// Full call-up details table (every email includes this).
function detailsHtml(o) {
  const TD = "padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;";
  const row = (label, val) => `<tr><td style="${TD}"><strong>${esc(label)}:</strong> ${esc(val || "")}</td></tr>`;
  const endDate = o.EndDate && o.EndDate !== o.StartDate ? fmtDate(o.EndDate) : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;max-width:640px;margin:8px 0;">`
    + row("Order ID", o.OrderID)
    + row("Event", o.Event)
    + row("Start Date", fmtDate(o.StartDate))
    + (endDate ? row("End Date", endDate) : "")
    + row("Start Time", o.StartTime)
    + row("End Time", o.EndTime)
    + row("Days", o.Days)
    + row("Coverage", o.Coverage)
    + row("Guards", o.NumGuards)
    + row("Meeting Location", o.Location)
    + row("Site Contact", o.SiteContact)
    + row("Phone", o.ContactNumber)
    + `<tr><td style="${TD}">${dutiesHtml(o.Duties)}</td></tr>`
    + `</table>`;
}
function warnBody(o) {
  return `<h2 style="font-family:Arial,Helvetica,sans-serif;">Call-Up Starting Soon — still Pending</h2>`
    + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#444;">`
    + `Heads-up: the call-up below is scheduled to <strong>start in about 8 hours</strong> and is still <strong>Pending</strong> — it has not been set to Scheduled. `
    + `The client and our scheduling department may be unaware that it has not yet been confirmed/covered. `
    + `Please review and schedule it if appropriate.</p>`
    + detailsHtml(o);
}
function expireBody(o) {
  return `<h2 style="font-family:Arial,Helvetica,sans-serif;">Call-Up Reached Start Time</h2>`
    + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#444;">`
    + `The Scheduled call-up below has reached its start date/time. It will be <strong>automatically set to Completed in 8 hours</strong> unless its status is changed before then. `
    + `When it auto-completes, the completion notice is sent to ${esc(ADMIN)} and ${esc(ORDERS_BASKET)}.</p>`
    + detailsHtml(o);
}
function completeBody(o) {
  return `<h2 style="font-family:Arial,Helvetica,sans-serif;">Call Up Request Completed</h2>`
    + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#444;">`
    + `This temporary post order was <strong>automatically marked Completed</strong> (8 hours after its start time).</p>`
    + detailsHtml(o);
}

async function sendOwnerMail(toList, subject, html) {
  const payload = {
    message: {
      subject: String(subject),
      body: { contentType: "HTML", content: String(html) },
      from: { emailAddress: { name: config.senderDisplayName(), address: config.ownerUpn() } },
      toRecipients: toList.map((a) => ({ emailAddress: { address: a } })),
    },
    saveToSentItems: true,
  };
  const r = await graphFetch("/me/sendMail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok && r.status !== 202) {
    const txt = await r.text().catch(() => "");
    throw new Error(`sendMail ${r.status} ${txt.slice(0, 200)}`);
  }
}

function readHeader(req, name) {
  if (!req || !req.headers) return "";
  if (typeof req.headers.get === "function") return req.headers.get(name) || "";
  return req.headers[name] || req.headers[name.toLowerCase()] || "";
}
function secretOk(provided, expected) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

app.http("cronTick", {
  route: "cron",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const expected = (process.env.CRON_SECRET || "").trim();
      if (!expected) {
        return { status: 503, jsonBody: { error: "CRON_SECRET not configured" } };
      }
      const provided = readHeader(req, "x-cron-secret");
      if (!secretOk(provided, expected)) {
        return { status: 401, jsonBody: { error: "unauthorized" } };
      }

      const now = Date.now();
      const tsStr = new Date(now).toLocaleString("en-US", { timeZone: "America/Toronto" });
      const itemId = await workbookItemId();
      const [orders, history] = await Promise.all([
        readSheet(itemId, "Orders"),
        readSheet(itemId, "StatusHistory"),
      ]);
      const isReal = (o) => o && o.OrderID && String(o.OrderID).trim();
      const orderRows = orders.filter(isReal);
      const histRows = history.filter(isReal);

      const summary = { ts: tsStr, scanned: orderRows.length, warned: [], expired: [], completed: [], skipped: 0, errors: 0 };
      let changed = false;

      for (const o of orderRows) {
        // Archived orders are out of the workflow.
        if (o.Archived && String(o.Archived).toLowerCase() !== "no" && String(o.Archived).trim() !== "") continue;
        const d = decideAction(o, now);
        if (d.action === "skip") { summary.skipped++; continue; }
        if (d.action === "none") continue;
        try {
          if (d.action === "warn") {
            await sendOwnerMail([FARHAD, PAT], `Call-Up Starting Soon (still Pending): ${o.OrderID} - ${o.Event || ""}`, warnBody(o));
            o.NotifiedStartingSoon = "true"; changed = true; summary.warned.push(o.OrderID);
          } else if (d.action === "expire") {
            await sendOwnerMail([FARHAD, PAT], `Call-Up Reached Start — Auto-Completes in 8h: ${o.OrderID} - ${o.Event || ""}`, expireBody(o));
            o.NotifiedExpiry = "true"; changed = true; summary.expired.push(o.OrderID);
          } else if (d.action === "complete") {
            await sendOwnerMail([ADMIN, ORDERS_BASKET], `Call Up Request Completed: ${o.OrderID} - ${o.Event || ""}`, completeBody(o));
            o.Status = "Completed";
            o.AutoCompleted = "true";
            o.UpdatedBy = "System (auto-complete)";
            o.LastUpdated = tsStr;
            histRows.push({
              OrderID: o.OrderID, Status: "Completed", ChangedBy: "System (auto-complete)",
              Timestamp: tsStr, Notes: "Auto-completed 8 hours after start time.",
            });
            changed = true; summary.completed.push(o.OrderID);
          }
        } catch (e) {
          // Email/Graph failure: do NOT set the flag — retry next tick.
          ctx.error(`cron ${d.action} failed for ${o.OrderID}: ${e.message}`);
          summary.errors++;
        }
      }

      if (changed) {
        antiWipeOrThrow("Orders", orderRows.length, orders.filter(isReal).length, false);
        await snapshotSheet(itemId, "Orders", "Orders_Backup");
        await snapshotSheet(itemId, "StatusHistory", "History_Backup");
        await writeSheet(itemId, "Orders", orderRows, ORDERS_HEADERS);
        await writeSheet(itemId, "StatusHistory", histRows, HISTORY_HEADERS);
        pruneSnapshots(itemId, "Orders_Backup").catch(() => {});
        pruneSnapshots(itemId, "History_Backup").catch(() => {});
      }

      return { status: 200, jsonBody: { ok: true, ...summary } };
    } catch (e) {
      ctx.error("cronTick failed:", e);
      return { status: e.status || 500, jsonBody: { error: e.message } };
    }
  },
});
