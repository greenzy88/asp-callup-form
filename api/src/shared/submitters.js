// Submitters module — name + 4-digit PIN identity layer that sits on top
// of the existing M365 MSAL auth.
//
// Why this exists: BBTCA has ~8 humans sharing a single M365 mailbox
// (atraining@security-asp.com). M365 auth alone can't distinguish who
// is submitting. Council 2026-05-27 approved a name+PIN model with
// server-side HMAC token + revocation check on every protected endpoint.
// David 2026-05-28 scoped it to the simpler form: all atraining@ sessions
// (and dramlagan@ when ADMIN_PIN_TEST=1) get a name+PIN dialog after MSAL.
// Pre-seeded names (Holly, Denise, Chad) get a "set your PIN" prompt the
// first time; airport-planning users self-register a name + PIN.
//
// Stored at: OneDrive `ASP-CallUp/CallUpForm_Data.xlsx` sheet `Submitters`.
// Schema below. Pin is HMAC-SHA256(pin, per-row salt) — bcrypt would be
// stronger but bcrypt is overkill for a 4-digit PIN and adds an unwanted
// native dep to the Azure Functions runtime.

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const {
  readSheet, writeSheet, workbookItemId,
  snapshotSheet, pruneSnapshots, ensureSheetExists,
} = require("./graph");
const config = require("./config");

const SHEET_NAME = "Submitters";
const SUBMITTERS_HEADERS = [
  "SubmitterID",       // UUID v4 (string)
  "DisplayName",       // free text, unique within ParentAccount
  "ParentAccount",     // UPN that owns this submitter (atraining@ | dramlagan@)
  "PinHash",           // hex SHA256-HMAC of PIN, empty if not set yet
  "Salt",              // hex 16 random bytes, per row
  "Status",            // "active" | "revoked"
  "RegisteredAt",      // ISO timestamp
  "LastSeenAt",        // ISO timestamp (updated on each successful verify)
  "PinSetAt",          // ISO timestamp (empty if PIN never set)
];

// Pre-seed rows created on first read of the Submitters sheet. PINs are
// blank — user sets their own on first login.
const PRE_SEED = [
  { DisplayName: "Holly Campbell",  ParentAccount: "atraining@security-asp.com" },
  { DisplayName: "Denise Roy",      ParentAccount: "atraining@security-asp.com" },
  { DisplayName: "Chad Martin",     ParentAccount: "atraining@security-asp.com" },
];

// 60s revocation-cache to spare OneDrive Graph IO on every protected call.
// Map<submitterId, { status, displayName, parentAccount, expiresAt }>
const _revocationCache = new Map();
const REVOCATION_CACHE_TTL_MS = 60 * 1000;

function _now() { return new Date().toISOString(); }
function _newSalt() { return crypto.randomBytes(16).toString("hex"); }
function _newId() { return crypto.randomUUID(); }

function _hashPin(pin, salt) {
  // HMAC-SHA256(salt || pin || serverSecret) — server secret prevents an
  // attacker who lifts the salt+hash from a OneDrive backup from running
  // a 10,000-PIN brute force offline. Without the secret, 4-digit PINs
  // crack in milliseconds; with it, they're effectively useless without
  // the SWA env.
  const secret = config.submitterTokenSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(`${salt}|${pin}`)
    .digest("hex");
}

function _validatePinFormat(pin) {
  if (typeof pin !== "string") throw _err(400, "PIN must be a string");
  if (!/^\d{4}$/.test(pin)) throw _err(400, "PIN must be exactly 4 digits");
}

function _validateDisplayName(name) {
  if (typeof name !== "string") throw _err(400, "display_name must be a string");
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    throw _err(400, "display_name must be 2-60 characters");
  }
  // Conservative whitelist — letters, digits, spaces, hyphens, apostrophes, periods.
  if (!/^[\p{L}\p{N}\s.'-]+$/u.test(trimmed)) {
    throw _err(400, "display_name contains unsupported characters");
  }
  return trimmed;
}

function _err(status, msg, code) {
  const e = new Error(msg);
  e.status = status;
  if (code) e.code = code;
  return e;
}

// Read the Submitters sheet, seeding pre-defined rows on first access.
// Caller is responsible for filtering by ParentAccount as needed.
async function readAll() {
  const itemId = await workbookItemId();
  await ensureSheetExists(itemId, SHEET_NAME);
  let rows = await readSheet(itemId, SHEET_NAME);
  // Filter blank rows (Excel can return trailing empties).
  rows = rows.filter((r) => r && r.SubmitterID && String(r.SubmitterID).trim());

  // First-run seed. Idempotent: only seed names that aren't already present.
  const haveByKey = new Set(
    rows.map((r) => `${String(r.ParentAccount).toLowerCase()}|${String(r.DisplayName).trim().toLowerCase()}`)
  );
  const needed = PRE_SEED.filter(
    (s) => !haveByKey.has(`${s.ParentAccount.toLowerCase()}|${s.DisplayName.trim().toLowerCase()}`)
  );
  if (needed.length) {
    const ts = _now();
    for (const s of needed) {
      rows.push({
        SubmitterID: _newId(),
        DisplayName: s.DisplayName,
        ParentAccount: s.ParentAccount,
        PinHash: "",
        Salt: _newSalt(),
        Status: "active",
        RegisteredAt: ts,
        LastSeenAt: "",
        PinSetAt: "",
      });
    }
    await snapshotSheet(itemId, SHEET_NAME, "Submitters_Backup").catch(() => {});
    await writeSheet(itemId, SHEET_NAME, rows, SUBMITTERS_HEADERS);
    pruneSnapshots(itemId, "Submitters_Backup").catch(() => {});
  }
  return { itemId, rows };
}

// Public-safe view of a submitter row (no secrets).
function _publicRow(r) {
  return {
    submitter_id: r.SubmitterID,
    display_name: r.DisplayName,
    parent_account: r.ParentAccount,
    status: r.Status,
    has_pin: !!(r.PinHash && r.PinHash.trim()),
    registered_at: r.RegisteredAt,
    last_seen_at: r.LastSeenAt || "",
    pin_set_at: r.PinSetAt || "",
  };
}

// GET — list submitters for a parent account. Pre-seeded names show up
// even if they haven't set a PIN yet so the dropdown is populated.
async function listForParent(parentAccount) {
  const { rows } = await readAll();
  const parent = String(parentAccount).toLowerCase();
  return rows
    .filter((r) => String(r.ParentAccount).toLowerCase() === parent && r.Status !== "revoked")
    .map(_publicRow);
}

// Admin view: list everything, including revoked.
async function listAll() {
  const { rows } = await readAll();
  return rows.map(_publicRow);
}

// Find by ID. Returns the raw row (caller must not leak PinHash/Salt).
async function findById(submitterId) {
  const { rows } = await readAll();
  return rows.find((r) => String(r.SubmitterID) === String(submitterId)) || null;
}

// Find by (parent, display_name) — used to detect "this name already exists"
// during register, and to look up a returning user when the SPA passes a
// human-typed name.
async function findByName(parentAccount, displayName) {
  const { rows } = await readAll();
  const parent = String(parentAccount).toLowerCase();
  const name = String(displayName).trim().toLowerCase();
  return rows.find((r) =>
    String(r.ParentAccount).toLowerCase() === parent &&
    String(r.DisplayName).trim().toLowerCase() === name
  ) || null;
}

// Register a brand-new submitter (display_name not yet in the sheet under
// this parent). Sets a PIN immediately. Returns the public row + token.
async function register(parentAccount, displayName, pin) {
  const cleanName = _validateDisplayName(displayName);
  _validatePinFormat(pin);

  const { itemId, rows } = await readAll();
  const parent = String(parentAccount).toLowerCase();
  const collision = rows.find((r) =>
    String(r.ParentAccount).toLowerCase() === parent &&
    String(r.DisplayName).trim().toLowerCase() === cleanName.toLowerCase()
  );
  if (collision) {
    throw _err(409, "A submitter with that name is already registered. Pick it from the dropdown instead.", "NAME_TAKEN");
  }

  const salt = _newSalt();
  const ts = _now();
  const row = {
    SubmitterID: _newId(),
    DisplayName: cleanName,
    ParentAccount: parentAccount,
    PinHash: _hashPin(pin, salt),
    Salt: salt,
    Status: "active",
    RegisteredAt: ts,
    LastSeenAt: ts,
    PinSetAt: ts,
  };
  rows.push(row);
  await snapshotSheet(itemId, SHEET_NAME, "Submitters_Backup").catch(() => {});
  await writeSheet(itemId, SHEET_NAME, rows, SUBMITTERS_HEADERS);
  pruneSnapshots(itemId, "Submitters_Backup").catch(() => {});
  _invalidateCache(row.SubmitterID);
  return { row: _publicRow(row), token: _signToken(row) };
}

// Set the initial PIN for a pre-seeded row that doesn't have one yet.
// Distinct from register() because the row already exists (Holly/Denise/Chad
// pre-seed) and we don't want a "name taken" 409.
async function setInitialPin(submitterId, pin, parentAccount) {
  _validatePinFormat(pin);
  const { itemId, rows } = await readAll();
  const idx = rows.findIndex((r) => String(r.SubmitterID) === String(submitterId));
  if (idx < 0) throw _err(404, "Submitter not found", "NOT_FOUND");
  const row = rows[idx];
  if (String(row.ParentAccount).toLowerCase() !== String(parentAccount).toLowerCase()) {
    // Belt-and-braces: never let one parent_account set another's PIN even
    // by passing the submitter_id directly. The SPA only ever lists
    // submitters scoped to the caller's parent, so this should never fire
    // organically; it's here to defend against a forged client request.
    throw _err(403, "This submitter belongs to a different login account", "WRONG_PARENT");
  }
  if (row.Status === "revoked") {
    throw _err(403, "This submitter has been revoked. Ask an admin to restore.", "REVOKED");
  }
  if (row.PinHash && row.PinHash.trim()) {
    throw _err(409, "A PIN is already set. Use verify, or ask an admin to reset.", "ALREADY_SET");
  }
  const salt = _newSalt();
  rows[idx] = Object.assign({}, row, {
    Salt: salt,
    PinHash: _hashPin(pin, salt),
    PinSetAt: _now(),
    LastSeenAt: _now(),
  });
  await snapshotSheet(itemId, SHEET_NAME, "Submitters_Backup").catch(() => {});
  await writeSheet(itemId, SHEET_NAME, rows, SUBMITTERS_HEADERS);
  pruneSnapshots(itemId, "Submitters_Backup").catch(() => {});
  _invalidateCache(rows[idx].SubmitterID);
  return { row: _publicRow(rows[idx]), token: _signToken(rows[idx]) };
}

// Verify a returning user's PIN. Constant-time comparison on the hash.
// On success, bump LastSeenAt and return a fresh token.
async function verifyPin(submitterId, pin, parentAccount) {
  _validatePinFormat(pin);
  const { itemId, rows } = await readAll();
  const idx = rows.findIndex((r) => String(r.SubmitterID) === String(submitterId));
  if (idx < 0) throw _err(404, "Submitter not found", "NOT_FOUND");
  const row = rows[idx];
  if (String(row.ParentAccount).toLowerCase() !== String(parentAccount).toLowerCase()) {
    throw _err(403, "This submitter belongs to a different login account", "WRONG_PARENT");
  }
  if (row.Status === "revoked") {
    throw _err(403, "This submitter has been revoked. Ask an admin to restore.", "REVOKED");
  }
  if (!row.PinHash || !row.PinHash.trim()) {
    throw _err(409, "This account has no PIN yet. Use set-initial-pin instead.", "PIN_NOT_SET");
  }
  const computed = _hashPin(pin, row.Salt);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(row.PinHash, "hex");
  // timingSafeEqual throws if lengths differ; same-length is guaranteed
  // by hex of fixed-output HMAC, but defend anyway.
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) throw _err(401, "PIN incorrect", "BAD_PIN");

  rows[idx] = Object.assign({}, row, { LastSeenAt: _now() });
  await writeSheet(itemId, SHEET_NAME, rows, SUBMITTERS_HEADERS);
  _invalidateCache(rows[idx].SubmitterID);
  return { row: _publicRow(rows[idx]), token: _signToken(rows[idx]) };
}

// Admin actions: reset a submitter's PIN (next login forces re-set), or
// flip status to revoked (future submits 401), or delete the row entirely.
async function adminAction(submitterId, action) {
  const { itemId, rows } = await readAll();
  const idx = rows.findIndex((r) => String(r.SubmitterID) === String(submitterId));
  if (idx < 0) throw _err(404, "Submitter not found", "NOT_FOUND");
  if (action === "reset_pin") {
    rows[idx] = Object.assign({}, rows[idx], { PinHash: "", PinSetAt: "" });
  } else if (action === "revoke") {
    rows[idx] = Object.assign({}, rows[idx], { Status: "revoked" });
  } else if (action === "restore") {
    rows[idx] = Object.assign({}, rows[idx], { Status: "active" });
  } else if (action === "delete") {
    rows.splice(idx, 1);
  } else {
    throw _err(400, `Unknown action: ${action}`, "BAD_ACTION");
  }
  await snapshotSheet(itemId, SHEET_NAME, "Submitters_Backup").catch(() => {});
  await writeSheet(itemId, SHEET_NAME, rows, SUBMITTERS_HEADERS);
  pruneSnapshots(itemId, "Submitters_Backup").catch(() => {});
  _invalidateCache(submitterId);
  return action === "delete"
    ? { ok: true, deleted: true }
    : { ok: true, row: _publicRow(rows[idx]) };
}

function _signToken(row) {
  return jwt.sign(
    {
      sub: String(row.SubmitterID),
      dn: String(row.DisplayName),
      pa: String(row.ParentAccount),
    },
    config.submitterTokenSecret(),
    { algorithm: "HS256", expiresIn: config.submitterTokenTtlSeconds() }
  );
}

function _readHeader(req, name) {
  if (!req || !req.headers) return "";
  if (typeof req.headers.get === "function") return req.headers.get(name) || "";
  return req.headers[name] || req.headers[name.toLowerCase()] || req.headers[name.toUpperCase()] || "";
}

function _invalidateCache(submitterId) {
  if (submitterId) _revocationCache.delete(String(submitterId));
}

// requireSubmitterToken — middleware-style helper used by the protected
// endpoints (ordersAdd, orderUpdate, pdfUpload, email). Returns the
// payload + display_name on success. Verifies signature, checks the
// Submitters sheet for revocation (60s cache), and rejects expired or
// revoked tokens. Caller passes the SPA-authenticated UPN so we can
// double-check the token's parent_account matches.
async function requireSubmitterToken(req, expectedParentAccount) {
  const raw = _readHeader(req, "x-submitter-token");
  if (!raw) throw _err(401, "Missing X-Submitter-Token header", "MISSING_SUBMITTER_TOKEN");
  let payload;
  try {
    payload = jwt.verify(raw, config.submitterTokenSecret(), { algorithms: ["HS256"] });
  } catch (e) {
    throw _err(401, `Submitter token invalid: ${e.message}`, "BAD_SUBMITTER_TOKEN");
  }
  if (expectedParentAccount &&
      String(payload.pa || "").toLowerCase() !== String(expectedParentAccount).toLowerCase()) {
    throw _err(403, "Submitter token does not match the signed-in account", "PARENT_MISMATCH");
  }

  // Revocation check — try cache first, fall through to OneDrive read.
  const submitterId = String(payload.sub);
  const cached = _revocationCache.get(submitterId);
  const nowMs = Date.now();
  let status, displayName, parentAccount;
  if (cached && cached.expiresAt > nowMs) {
    ({ status, displayName, parentAccount } = cached);
  } else {
    const row = await findById(submitterId);
    if (!row) throw _err(403, "Submitter no longer exists", "SUBMITTER_GONE");
    status = row.Status;
    displayName = row.DisplayName;
    parentAccount = row.ParentAccount;
    _revocationCache.set(submitterId, {
      status, displayName, parentAccount, expiresAt: nowMs + REVOCATION_CACHE_TTL_MS,
    });
  }
  if (status === "revoked") {
    throw _err(403, "This submitter has been revoked by the administrator", "REVOKED");
  }
  return { submitter_id: submitterId, display_name: displayName, parent_account: parentAccount };
}

module.exports = {
  SUBMITTERS_HEADERS,
  listForParent,
  listAll,
  findById,
  findByName,
  register,
  setInitialPin,
  verifyPin,
  adminAction,
  requireSubmitterToken,
};
