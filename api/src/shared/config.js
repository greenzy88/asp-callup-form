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
  // Storage table connection: SWA's managed API auto-provisions
  // AzureWebJobsStorage; we reuse it for the token table.
  storageConn: () => required("AzureWebJobsStorage"),
  tokenTableName: () => optional("TOKEN_TABLE_NAME", "OwnerTokens"),
};
