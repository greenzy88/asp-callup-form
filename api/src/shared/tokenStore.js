// Persistent storage for the owner's refresh token. Backed by Azure
// Table Storage (the same storage account SWA provisioned for its
// managed Functions). Single row keyed by RowKey="owner".
//
// Tokens are stored opaque; rotated automatically on refresh.

const { TableClient } = require("@azure/data-tables");
const config = require("./config");

let _client = null;

async function client() {
  if (_client) return _client;
  const tbl = TableClient.fromConnectionString(
    config.storageConn(),
    config.tokenTableName()
  );
  try {
    await tbl.createTable();
  } catch (e) {
    // 409 / TableAlreadyExists is fine — anything else is a real error.
    if (e.statusCode !== 409 && !/already exists/i.test(String(e.message))) {
      throw e;
    }
  }
  _client = tbl;
  return tbl;
}

async function load() {
  const tbl = await client();
  try {
    const row = await tbl.getEntity("owner", "owner");
    return {
      refreshToken: row.refreshToken,
      capturedAt: row.capturedAt,
      capturedBy: row.capturedBy,
    };
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function save(refreshToken, capturedBy) {
  const tbl = await client();
  await tbl.upsertEntity(
    {
      partitionKey: "owner",
      rowKey: "owner",
      refreshToken,
      capturedBy: String(capturedBy || ""),
      capturedAt: new Date().toISOString(),
    },
    "Replace"
  );
}

async function clear() {
  const tbl = await client();
  try {
    await tbl.deleteEntity("owner", "owner");
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

module.exports = { load, save, clear };
