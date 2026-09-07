// Persistent storage for the owner's refresh token. Backed by Azure
// Table Storage (the same storage account SWA provisioned for its
// managed Functions). Single row keyed by RowKey="owner".
//
// Tokens are stored opaque. Rotation on refresh became TRUE on 2026-08-24 —
// until that day this comment claimed it and save() had exactly one caller,
// authCallback.js:95, the one-time setup. graph.js used the refresh token on
// every request and threw away the rotated one Microsoft returned, so the
// stored bytes never changed after 2026-05-26 and Entra killed them at exactly
// 90 days of inactivity (AADSTS700082) with clients on the app. A comment
// describing behaviour nobody had implemented is worse than no comment: it is
// the reason nobody went looking.

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

// 2026-09-06 — the table now holds MORE THAN ONE identity. The owner row
// ("owner"/"owner") is unchanged and still the only credential that touches
// OneDrive. A second row ("sender"/"notify") holds the mail-sending identity
// (atraining@) introduced when notifications stopped leaving as David
// personally. They are kept in DIFFERENT PARTITIONS on purpose: no query,
// upsert or delete against one can ever reach the other, so a mistake in the
// new code cannot cost the app its OneDrive connection.
const OWNER_KEY = { partitionKey: "owner", rowKey: "owner" };
const NOTIFY_KEY = { partitionKey: "sender", rowKey: "notify" };

async function loadKey(partitionKey, rowKey) {
  const tbl = await client();
  try {
    const row = await tbl.getEntity(partitionKey, rowKey);
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

async function saveKey(partitionKey, rowKey, refreshToken, capturedBy) {
  const tbl = await client();
  await tbl.upsertEntity(
    {
      partitionKey,
      rowKey,
      refreshToken,
      capturedBy: String(capturedBy || ""),
      capturedAt: new Date().toISOString(),
    },
    "Replace"
  );
}

async function clearKey(partitionKey, rowKey) {
  const tbl = await client();
  try {
    await tbl.deleteEntity(partitionKey, rowKey);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

// Owner credential — byte-for-byte the same row, shape and semantics as before.
async function load() { return loadKey(OWNER_KEY.partitionKey, OWNER_KEY.rowKey); }
async function save(refreshToken, capturedBy) {
  return saveKey(OWNER_KEY.partitionKey, OWNER_KEY.rowKey, refreshToken, capturedBy);
}
async function clear() { return clearKey(OWNER_KEY.partitionKey, OWNER_KEY.rowKey); }

// Notification-sender credential.
async function loadNotify() { return loadKey(NOTIFY_KEY.partitionKey, NOTIFY_KEY.rowKey); }
async function saveNotify(refreshToken, capturedBy) {
  return saveKey(NOTIFY_KEY.partitionKey, NOTIFY_KEY.rowKey, refreshToken, capturedBy);
}
async function clearNotify() { return clearKey(NOTIFY_KEY.partitionKey, NOTIFY_KEY.rowKey); }

module.exports = {
  load, save, clear,
  loadNotify, saveNotify, clearNotify,
  OWNER_KEY, NOTIFY_KEY,
};
