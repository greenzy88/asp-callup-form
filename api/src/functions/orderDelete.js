// DELETE /api/orders/{orderId} — remove from Orders + StatusHistory.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canManageStatus } = require("../shared/roles");
const {
  readSheet, writeSheet, workbookItemId,
  ORDERS_HEADERS, HISTORY_HEADERS,
} = require("../shared/graph");

app.http("orderDelete", {
  route: "orders/{orderId}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      if (!canManageStatus(upn)) {
        return { status: 403, jsonBody: { error: "Only managers can delete orders" } };
      }
      const orderId = req.params.orderId;

      const itemId = await workbookItemId();
      const [orders, history] = await Promise.all([
        readSheet(itemId, "Orders"),
        readSheet(itemId, "StatusHistory"),
      ]);
      const isReal = (o) => o && o.OrderID && String(o.OrderID).trim();
      const keptOrders = orders.filter(isReal).filter((o) => String(o.OrderID) !== String(orderId));
      const keptHist = history.filter(isReal).filter((h) => String(h.OrderID) !== String(orderId));

      await writeSheet(itemId, "Orders", keptOrders, ORDERS_HEADERS);
      await writeSheet(itemId, "StatusHistory", keptHist, HISTORY_HEADERS);

      return { status: 200, jsonBody: { ok: true, removed: orderId } };
    } catch (e) {
      ctx.error("orderDelete failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message, code: e.code || null, graph: e.graph || null },
      };
    }
  },
});
