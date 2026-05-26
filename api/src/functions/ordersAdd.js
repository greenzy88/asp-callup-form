// POST /api/orders — append a new order to the Orders sheet + add a
// row to StatusHistory. Body: { order: {...}, historyNote?: string }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canEdit } = require("../shared/roles");
const {
  readSheet, writeSheet, workbookItemId,
  ORDERS_HEADERS, HISTORY_HEADERS,
} = require("../shared/graph");

app.http("ordersAdd", {
  route: "orders",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      if (!canEdit(upn)) {
        return { status: 403, jsonBody: { error: "Not authorised to create orders" } };
      }
      const body = await req.json();
      if (!body || !body.order || typeof body.order !== "object") {
        return { status: 400, jsonBody: { error: "Body must contain `order` object" } };
      }

      const itemId = await workbookItemId();
      const [orders, history] = await Promise.all([
        readSheet(itemId, "Orders"),
        readSheet(itemId, "StatusHistory"),
      ]);
      const isReal = (o) => o && o.OrderID && String(o.OrderID).trim();
      const orderRows = orders.filter(isReal);
      const histRows = history.filter(isReal);

      const ts = new Date();
      const newId = `TPO-${ts.getFullYear()}-${String(orderRows.length + 1).padStart(3, "0")}`;
      const order = Object.assign(
        {
          OrderID: newId,
          Status: "Pending",
          UpdatedBy: `${upn} (PDF Upload)`,
          LastUpdated: ts.toLocaleString(),
          Archived: "No",
        },
        body.order,
        { OrderID: newId }  // never let client override the generated ID
      );
      orderRows.push(order);
      histRows.push({
        OrderID: newId,
        Status: order.Status,
        ChangedBy: `${upn} (PDF Upload)`,
        Timestamp: ts.toLocaleString(),
        Notes: body.historyNote || "Order created from PDF upload",
      });

      await writeSheet(itemId, "Orders", orderRows, ORDERS_HEADERS);
      await writeSheet(itemId, "StatusHistory", histRows, HISTORY_HEADERS);

      return { status: 200, jsonBody: { ok: true, order } };
    } catch (e) {
      ctx.error("ordersAdd failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message, code: e.code || null, graph: e.graph || null },
      };
    }
  },
});
