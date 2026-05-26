// GET /api/orders — list orders + status history (filtered to real rows).

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { readSheet, workbookItemId } = require("../shared/graph");

app.http("ordersGet", {
  route: "orders",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      await requireUser(req);
      const itemId = await workbookItemId();
      const [orders, history] = await Promise.all([
        readSheet(itemId, "Orders"),
        readSheet(itemId, "StatusHistory"),
      ]);
      const isReal = (o) => o && o.OrderID && String(o.OrderID).trim();
      return {
        status: 200,
        jsonBody: {
          orders: orders.filter(isReal),
          statusHistory: history.filter(isReal),
        },
      };
    } catch (e) {
      ctx.error("ordersGet failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message, code: e.code || null, graph: e.graph || null },
      };
    }
  },
});
