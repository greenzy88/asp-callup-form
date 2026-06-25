// PATCH /api/orders/{orderId} — update status (or any subset of fields)
// + append a row to StatusHistory. Body: { fields: {...}, note?: string }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canManageStatus, canEdit } = require("../shared/roles");
const { requireSubmitterIfClient, auditLabel } = require("../shared/submitters");
const {
  readSheet, writeSheet, workbookItemId,
  ORDERS_HEADERS, HISTORY_HEADERS,
  snapshotSheet, pruneSnapshots, antiWipeOrThrow,
} = require("../shared/graph");

app.http("orderUpdate", {
  route: "orders/{orderId}",
  methods: ["PATCH"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn, role } = await requireUser(req);
      const submitter = await requireSubmitterIfClient(req, { upn, role });
      const actor = auditLabel(upn, submitter);
      const orderId = req.params.orderId;
      const body = await req.json().catch(() => ({}));
      const fields = (body && body.fields) || {};
      if (!fields || typeof fields !== "object") {
        return { status: 400, jsonBody: { error: "Body.fields must be an object" } };
      }
      // 2026-06-09 — reject prototype-pollution keys outright. writeSheet is
      // header-bound so these never persist, but rejecting is unambiguous and
      // keeps Object.assign(after, fields) from touching the prototype chain.
      if (Object.keys(fields).some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) {
        return { status: 400, jsonBody: { error: "Invalid field key" } };
      }
      const itemId = await workbookItemId();
      const [orders, history] = await Promise.all([
        readSheet(itemId, "Orders"),
        readSheet(itemId, "StatusHistory"),
      ]);
      const isReal = (o) => o && o.OrderID && String(o.OrderID).trim();
      const orderRows = orders.filter(isReal);
      const histRows = history.filter(isReal);

      const idx = orderRows.findIndex((o) => String(o.OrderID) === String(orderId));
      if (idx < 0) return { status: 404, jsonBody: { error: `OrderID ${orderId} not found` } };

      const ts = new Date();
      const before = orderRows[idx];

      // # council-verified:panel-council_callup_autostatus_engine-1780981731
      // 2026-06-09 — Clients (canEdit but not canManageStatus) may edit CONTENT
      // fields, add notes, and upload a revised PDF — but may NOT set ANY status
      // (Completed included; setting status is a manager-only action via the
      // status dropdown). Reject any status key, case-insensitive. A client
      // revision can still send a Scheduled order back to Pending, but that is
      // applied SERVER-SIDE by the re-review bump below, never from a client value.
      if (!canManageStatus(upn)) {
        if (!canEdit(upn)) {
          return { status: 403, jsonBody: { error: "Not authorised to edit this order" } };
        }
        if (Object.keys(fields).some((k) => k.toLowerCase() === "status")) {
          return { status: 403, jsonBody: { error: "Only managers can set the order status" } };
        }
      }
      const after = Object.assign({}, before, fields, {
        OrderID: before.OrderID,
        UpdatedBy: actor,
        LastUpdated: ts.toLocaleString("en-US", { timeZone: "America/Toronto" }),
      });
      orderRows[idx] = after;

      // Detect a post-order revision (Version bump) so the history row can be
      // labelled "Revised (Vn)" rather than the generic "Edited".
      const verBefore = Number(before.Version) || 1;
      const verAfter = Number(after.Version) || verBefore;
      const isRevision = verAfter > verBefore;

      // Diff every non-meta field so non-status edits (Days, EndTime, ...)
      // also leave an audit trail in StatusHistory. PDFFilename + Version are
      // treated as meta so a revision doesn't emit noisy raw-string diff lines
      // (the "Revised (Vn)" label + the real field diffs carry the meaning).
      const META_FIELDS = new Set(["UpdatedBy", "LastUpdated", "OrderID", "PDFFilename", "Version"]);
      const norm = (v) => (v === undefined || v === null ? "" : String(v));
      const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
      // Canonicalise date/time fields before diffing so a value that only
      // CHANGED FORMAT does not log a spurious StatusHistory entry. Excel coerces
      // stored strings on round-trip — a time "6:00 AM" -> day-fraction 0.25 (or
      // "0900" -> int 900), a date "Mar 21, 2026" -> ISO "2026-03-21" — so the
      // stored `before` value and the re-extracted `fields` value differ only in
      // representation. Mirror the frontend _canonTime / toISODate so the audit
      // trail matches the (already-canonical) email diff. (Stress test 2026-06-16.)
      const _canonTime = (v) => {
        if (v === null || v === undefined || v === "") return "";
        const num = Number(v);
        if (!isNaN(num) && num > 0 && num < 1) {
          const mins = Math.round(num * 24 * 60);
          return String(Math.floor(mins / 60) % 24).padStart(2, "0") + String(mins % 60).padStart(2, "0");
        }
        const s = String(v).trim();
        let m = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
        if (m) { let hh = parseInt(m[1], 10) % 12; if (/[Pp]/.test(m[3])) hh += 12;
                 return String(hh).padStart(2, "0") + m[2]; }
        m = s.match(/^(\d{1,2}):?(\d{2})$/);
        return m ? m[1].padStart(2, "0") + m[2] : s;
      };
      const _MO = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      const _moIdx = (w) => _MO.indexOf(String(w).slice(0, 3).toLowerCase());
      const _canonDate = (v) => {
        if (v === null || v === undefined || v === "") return "";
        const s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        let m = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,9})[\s\-\/]+(\d{4})$/);   // 04 March 2026 / 02-Mar-2026
        if (m) { const i = _moIdx(m[2]); if (i >= 0) return `${m[3]}-${String(i+1).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`; }
        m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*,?\s*(\d{4})$/);            // Mar 21, 2026
        if (m) { const i = _moIdx(m[1]); if (i >= 0) return `${m[3]}-${String(i+1).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`; }
        return s;  // numeric DD/MM/YYYY stays verbatim (ambiguous) — compares verbatim==verbatim
      };
      const TIME_FIELDS = new Set(["StartTime", "EndTime"]);
      const DATE_FIELDS = new Set(["StartDate", "EndDate"]);
      const canon = (k, v) => TIME_FIELDS.has(k) ? _canonTime(v)
                            : DATE_FIELDS.has(k) ? _canonDate(v)
                            : norm(v);
      const changes = [];
      for (const k of Object.keys(fields)) {
        if (META_FIELDS.has(k)) continue;
        const a = canon(k, before[k]);
        const b = canon(k, fields[k]);
        if (a !== b) changes.push({ field: k, from: truncate(a, 80), to: truncate(b, 80) });
      }
      const statusChange = changes.find((c) => c.field === "Status");
      const nonStatusChanges = changes.filter((c) => c.field !== "Status");
      // 2026-05-27 — a note alone (with no field changes) should still
      // produce a StatusHistory row. Prior condition only fired when a
      // field actually changed, so "add a note without changing status"
      // dropped silently.
      const hasNote = !!(body.note && String(body.note).trim());

      // 2026-06-09 / updated 2026-06-25 (David) — Re-review bump. When a SCHEDULED
      // order gets a CONTENT change (a field edit OR a PDF/version revision — NOT a
      // pure status change), reset it to Pending so the change is re-reviewed and
      // re-approved. This now fires for EVERY actor, owner/manager included
      // (David, 2026-06-25 stress test: "owner edits bump, client too" — only an
      // explicit Scheduled/Completed status pick leaves the status as chosen).
      // Completed orders are excluded (only before.Status === "Scheduled" triggers
      // it). Applied server-side.
      // NOTE (accepted, pre-existing): this handler is read-modify-write on the
      // workbook with only a row-count anti-wipe guard, so a bump racing a
      // simultaneous manager approval is theoretically possible. Probability is
      // negligible for this small internal app; true fix = optimistic locking
      // (rowVersion CAS), a separate architectural change.
      const isContentRevision = nonStatusChanges.length > 0 || isRevision;
      let revertedToPending = false;
      if (isContentRevision && !statusChange && before.Status === "Scheduled") {
        after.Status = "Pending";
        revertedToPending = true;
      }

      if (statusChange || nonStatusChanges.length || hasNote) {
        const noteParts = [];
        // 2026-06-08 — record the order's status at the time of this edit so the
        // history shows what state the order was in when it was revised/edited.
        // For a pure status change the label already names the new status, so skip.
        if (!statusChange) noteParts.push(revertedToPending
          ? `Status reset for re-review: ${before.Status} → Pending`
          : `Status at edit: ${after.Status || before.Status || "—"}`);
        if (body.note) noteParts.push(body.note);
        if (nonStatusChanges.length) {
          noteParts.push(
            nonStatusChanges.map((c) => `${c.field}: "${c.from}" → "${c.to}"`).join("; ")
          );
        }
        histRows.push({
          OrderID: before.OrderID,
          Status: statusChange
            ? statusChange.to
            : isRevision
              ? `Submission Revised (V${verAfter})`
              : (nonStatusChanges.length ? "Submission Revised" : before.Status),
          ChangedBy: actor,
          Timestamp: ts.toLocaleString("en-US", { timeZone: "America/Toronto" }),
          Notes: noteParts.join(" | "),
        });
      }

      // Row count should equal baseline (update, not add/delete).
      antiWipeOrThrow("Orders", orderRows.length, orders.filter(isReal).length, false);
      await snapshotSheet(itemId, "Orders", "Orders_Backup");
      await snapshotSheet(itemId, "StatusHistory", "History_Backup");
      await writeSheet(itemId, "Orders", orderRows, ORDERS_HEADERS);
      await writeSheet(itemId, "StatusHistory", histRows, HISTORY_HEADERS);
      pruneSnapshots(itemId, "Orders_Backup").catch(() => {});
      pruneSnapshots(itemId, "History_Backup").catch(() => {});

      return { status: 200, jsonBody: { ok: true, order: after } };
    } catch (e) {
      ctx.error("orderUpdate failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message, code: e.code || null, graph: e.graph || null },
      };
    }
  },
});
