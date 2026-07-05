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

// Cancellation is available to managers/owner AND to three named client
// submitters — Denise, Chad, Holly (David 2026-07-05). They share the client
// login and are told apart by their Name+PIN display_name, so this matches on
// the submitter's display name (first-name, case-insensitive: "Denise" or
// "Denise Roy" both match). Update this list if their registered names change.
const CANCEL_SUBMITTER_FIRSTNAMES = ["denise", "chad", "holly"];
// Recognise each person by FIRST NAME in whatever format they registered — first
// name alone ("Denise"), first + last initial ("Denise R"), or full name ("Denise
// Roy"), any capitalisation, any separator (space/hyphen/period/comma). A longer
// DIFFERENT name ("Deniser", "Chadwick") is rejected: the char right after the
// first name must not be another letter. (David 2026-07-05: "recognise it's Holly,
// Denise or Chad spelled in any which way … shouldn't be too strict.")
function isCancelSubmitter(submitter) {
  if (!submitter || !submitter.display_name) return false;
  const n = String(submitter.display_name).trim().toLowerCase();
  return CANCEL_SUBMITTER_FIRSTNAMES.some(
    (f) => n === f || (n.startsWith(f) && !/[a-z]/.test(n.charAt(f.length)))
  );
}
function canCancel(upn, submitter) {
  return canManageStatus(upn) || isCancelSubmitter(submitter);
}

module.exports = {
  OWNER, MANAGER, CLIENT,
  roleFor, isAuthorised, canEdit, canManageStatus,
  canCancel, isCancelSubmitter, CANCEL_SUBMITTER_FIRSTNAMES,
};
