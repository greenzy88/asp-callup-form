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

      // Managers + owner can change any status. Clients (canEdit but not
      // canManageStatus) can ONLY (a) mark an order Completed as a single-field
      // Status change, or (b) upload a revised post order — a PATCH that bumps
      // Version and does NOT change Status. Either way a client cannot set an
      // arbitrary status (Pending/Scheduled) or smuggle a status change into a
      // revision. (Order is loaded first so the revision check can read
      // before.Version; auth + submitter token already ran above.)
      if (!canManageStatus(upn)) {
        const fieldKeys = Object.keys(fields);
        const isCompletedOnly = fieldKeys.length === 1 && fields.Status === "Completed";
        const isRevision = !("Status" in fields) &&
          (Number(fields.Version) || 0) > (Number(before.Version) || 1);
        if (!canEdit(upn) || !(isCompletedOnly || isRevision)) {
          return { status: 403, jsonBody: { error: "Only managers can update order status" } };
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
      const changes = [];
      for (const k of Object.keys(fields)) {
        if (META_FIELDS.has(k)) continue;
        const a = norm(before[k]);
        const b = norm(fields[k]);
        if (a !== b) changes.push({ field: k, from: truncate(a, 80), to: truncate(b, 80) });
      }
      const statusChange = changes.find((c) => c.field === "Status");
      const nonStatusChanges = changes.filter((c) => c.field !== "Status");
      // 2026-05-27 — a note alone (with no field changes) should still
      // produce a StatusHistory row. Prior condition only fired when a
      // field actually changed, so "add a note without changing status"
      // dropped silently.
      const hasNote = !!(body.note && String(body.note).trim());

      if (statusChange || nonStatusChanges.length || hasNote) {
        const noteParts = [];
        // 2026-06-08 — record the order's status at the time of this edit so the
        // history shows what state the order was in when it was revised/edited.
        // For a pure status change the label already names the new status, so skip.
        if (!statusChange) noteParts.push(`Status at edit: ${after.Status || before.Status || "—"}`);
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
