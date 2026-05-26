// Role map for the app. UPN → role. Single source of truth on the
// backend; the frontend should treat it as advisory and let the
// backend enforce on every mutation.

const OWNER = "owner";
const MANAGER = "manager";
const CLIENT = "client";

// Hardcoded for now (mirrors the legacy index.html constants). Move to
// app settings or a table when the list grows beyond ~10.
const MANAGER_UPNS = new Set([
  "fmohammad@security-asp.com",
  "pdeal@security-asp.com",
]);
const CLIENT_UPNS = new Set([
  "atraining@security-asp.com",
]);

function roleFor(upn) {
  if (!upn) return null;
  const u = String(upn).toLowerCase();
  const owner = (process.env.OWNER_UPN || "").trim().toLowerCase();
  if (u === owner) return OWNER;
  if (MANAGER_UPNS.has(u)) return MANAGER;
  if (CLIENT_UPNS.has(u)) return CLIENT;
  return null;
}

function isAuthorised(upn) {
  return roleFor(upn) !== null;
}

function canEdit(upn) {
  const r = roleFor(upn);
  return r === OWNER || r === MANAGER || r === CLIENT;
}

function canManageStatus(upn) {
  const r = roleFor(upn);
  return r === OWNER || r === MANAGER;
}

module.exports = {
  OWNER, MANAGER, CLIENT,
  roleFor, isAuthorised, canEdit, canManageStatus,
};
