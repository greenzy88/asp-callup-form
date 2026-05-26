// PATCH /api/orders/{orderId} — update status (or any subset of fields)
// + append a row to StatusHistory. Body: { fields: {...}, note?: string }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canManageStatus } = require("../shared/roles");
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
      const { upn } = await requireUser(req);
      if (!canManageStatus(upn)) {
        return { status: 403, jsonBody: { error: "Only managers can update order status" } };
      }
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
      const after = Object.assign({}, before, fields, {
        OrderID: before.OrderID,
        UpdatedBy: upn,
        LastUpdated: ts.toLocaleString(),
      });
      orderRows[idx] = after;

      // Diff every non-meta field so non-status edits (Days, EndTime, ...)
      // also leave an audit trail in StatusHistory.
      const META_FIELDS = new Set(["UpdatedBy", "LastUpdated", "OrderID"]);
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

      if (statusChange || nonStatusChanges.length) {
        const noteParts = [];
        if (body.note) noteParts.push(body.note);
        if (nonStatusChanges.length) {
          noteParts.push(
            nonStatusChanges.map((c) => `${c.field}: "${c.from}" → "${c.to}"`).join("; ")
          );
        }
        histRows.push({
          OrderID: before.OrderID,
          Status: statusChange ? statusChange.to : (nonStatusChanges.length ? "Edited" : before.Status),
          ChangedBy: upn,
          Timestamp: ts.toLocaleString(),
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
