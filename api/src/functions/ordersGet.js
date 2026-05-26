// GET /api/orders
// Returns the Orders + StatusHistory worksheets as JSON.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { graphJson, workbookItemId } = require("../shared/graph");

async function readSheet(itemId, sheetName) {
  const body = await graphJson(
    `/me/drive/items/${itemId}/workbook/worksheets('${encodeURIComponent(sheetName)}')/usedRange?$select=values`
  );
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
