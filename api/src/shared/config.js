// Centralised reads of SWA app settings. Throws clearly if a required
// setting is missing so the function returns a useful 500 instead of
// crashing on undefined.

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required app setting: ${name}`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

module.exports = {
  clientId: () => required("AAD_CLIENT_ID"),
  clientSecret: () => required("AAD_CLIENT_SECRET"),
  tenantId: () => required("AAD_TENANT_ID"),
  ownerUpn: () => required("OWNER_UPN").toLowerCase(),
  authority: () => `https://login.microsoftonline.com/${required("AAD_TENANT_ID")}`,
  redirectUri: () => optional(
    "AAD_REDIRECT_URI",
    "https://delightful-bay-0e217b31e.7.azurestaticapps.net/api/auth/callback"
  ),
  // Storage table connection. NOTE: SWA reserves names starting with
  // AzureWebJobs*/WEBSITE_*/FUNCTIONS_* so we cannot use the default
  // AzureWebJobsStorage as an app setting. Falls back to it if the
  // runtime injects it, but the SWA setup uses STORAGE_CONNECTION.
  storageConn: () => {
    const v = process.env.STORAGE_CONNECTION || process.env.AzureWebJobsStorage;
    if (!v || !v.trim()) throw new Error("Missing required app setting: STORAGE_CONNECTION");
    return v.trim();
  },
  tokenTableName: () => optional("TOKEN_TABLE_NAME", "OwnerTokens"),
  // HMAC secret for X-Submitter-Token JWTs (HS256). At least 32 random bytes
  // in production. Set via SWA app settings; throws clearly if missing so a
  // misconfigured deploy doesn't silently issue tokens with an empty secret.
  submitterTokenSecret: () => required("SUBMITTER_TOKEN_SECRET"),
  // Optional TTL override for issued submitter tokens (default 12h = workday).
  submitterTokenTtlSeconds: () => parseInt(optional("SUBMITTER_TOKEN_TTL_SECONDS", "43200"), 10),
  // Set to "1" to make dramlagan@ see the Name+PIN dialog (temporary UX test).
  adminPinTest: () => optional("ADMIN_PIN_TEST", "0") === "1",
  // Display name shown in the recipient's mail client for outgoing
  // notification emails. The underlying address stays the authenticated
  // owner (David), but the name field masks it visually. Configurable
  // via SWA app setting so wording tweaks don't need a code push.
  senderDisplayName: () => optional("SENDER_DISPLAY_NAME", "ASP Call-Up Notifications (Do Not Reply)"),
  // Recipient allowlist for /api/email (2026-05-28). Comma-separated list
  // of exact addresses (e.g. "ops@x.com") and/or whole domains prefixed
  // with "@" (e.g. "@security-asp.com"). Empty/unset => no domain
  // restriction (format + count caps still apply), and a warning is logged.
  // Set this app setting to the real BBTCA notification recipients to close
  // the "send arbitrary mail as the owner" relay risk.
  emailRecipientAllowlist: () =>
    optional("EMAIL_RECIPIENT_ALLOWLIST", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  // ── Notification SENDER identity (2026-09-06) ─────────────────────────
  // Business continuity: notifications used to leave as David personally.
  // "owner"  = send as OWNER_UPN via the owner's stored token (the original
  //            behaviour, and still the default so a deploy alone changes
  //            nothing). "notify" = send as NOTIFY_SENDER_UPN using a SECOND,
  //            independently stored refresh token captured by
  //            /api/auth/setup?as=notify. Flipping this app setting is the
  //            activation AND the rollback — no code push either way.
  notifySenderMode: () =>
    optional("NOTIFY_SENDER_MODE", "owner").toLowerCase() === "notify" ? "notify" : "owner",
  // The mailbox notifications are sent AS in "notify" mode. Defaults to the
  // shared client account so activation is a single setting flip. This is the
  // account BBTCA staff already sign into the form with, so it outlives any
  // one employee — which is the whole point of the change.
  notifySenderUpn: () => optional("NOTIFY_SENDER_UPN", "atraining@security-asp.com").toLowerCase(),
  // If the notify identity ever fails (password changed on the shared account,
  // token revoked, Graph outage), fall back to the owner send rather than drop
  // the notification. A wrong-looking From address is recoverable; a call-up
  // that nobody at the airport hears about is not. Set to "0" to make failures
  // hard instead.
  notifyFallbackToOwner: () => optional("NOTIFY_FALLBACK_TO_OWNER", "1") !== "0",
  // Shared secret enabling POST /api/email-selftest, which mails the OWNER and
  // only the owner. Unset (the normal state) => the endpoint does not exist.
  // Set it for the duration of a verification, then delete it again.
  selftestKey: () => optional("SELFTEST_KEY", ""),
  // Hard cap on recipients per send — defends against mass-mail abuse even
  // when no allowlist is configured.
  emailMaxRecipients: () => parseInt(optional("EMAIL_MAX_RECIPIENTS", "15"), 10),
};
