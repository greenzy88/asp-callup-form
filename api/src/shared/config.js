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
};
