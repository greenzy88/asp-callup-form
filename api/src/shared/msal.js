// MSAL Node client. Confidential-client flow (client_secret) for the
// server-side auth-code + refresh-token dance. Only the owner ever
// goes through the interactive flow; everyone else's data ops use
// the owner's persisted refresh token.

const msal = require("@azure/msal-node");
const config = require("./config");

// Scopes the owner consents to once during /api/auth/setup. offline_access
// is the magic word that asks Microsoft to return a refresh_token.
const OWNER_CONSENT_SCOPES = [
  "Files.ReadWrite",
  "Mail.Send",
  "User.Read",
  "offline_access",
];

let _cca = null;
function cca() {
  if (_cca) return _cca;
  _cca = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId(),
      clientSecret: config.clientSecret(),
      authority: config.authority(),
    },
  });
  return _cca;
}

// Build the URL the owner gets redirected to during /api/auth/setup.
async function buildAuthCodeUrl(state) {
  return cca().getAuthCodeUrl({
    scopes: OWNER_CONSENT_SCOPES,
    redirectUri: config.redirectUri(),
    state,
    prompt: "consent",
  });
}

// Exchange the auth code that MS posted to /api/auth/callback for an
// access_token + refresh_token. The refresh_token is what we persist.
async function exchangeCodeForToken(code) {
  return cca().acquireTokenByCode({
    code,
    scopes: OWNER_CONSENT_SCOPES,
    redirectUri: config.redirectUri(),
  });
}

// Trade a stored refresh_token for a fresh access_token (and possibly
// a rotated refresh_token, which MSAL exposes only via the cache).
async function acquireFromRefresh(refreshToken) {
  // 2026-08-24 OUTAGE. The comment that used to sit here read:
  //
  //   "Microsoft generally extends the refresh-token's lifetime on each use,
  //    so active apps stay live without rotation."
  //
  // That was an assumption, never a measurement, and it is what took the app
  // down in front of clients. AADSTS700082: "The token was issued on
  // 2026-05-26T02:51:42Z and was inactive for 90.00:00:00." The credential in
  // use on 2026-08-24 was still the byte-for-byte token minted at setup three
  // months earlier — tokenStore.save() is called from exactly ONE place,
  // authCallback.js:95, and nothing ever replaced it.
  //
  // So the rotated token IS read now, by the same technique authCallback.js
  // already uses to capture the first one: MSAL-node keeps it in its token
  // cache, not on the response object.
  //
  // RETURN SHAPE CHANGED to { result, rotatedRefreshToken }. The caller decides
  // whether to persist, because this module does not own storage — and every
  // caller must be updated with it, which is the whole of graph.js:28.
  const result = await cca().acquireTokenByRefreshToken({
    refreshToken,
    scopes: ["Files.ReadWrite", "Mail.Send"],
  });
  let rotatedRefreshToken = null;
  try {
    const cacheStr = await cca().getTokenCache().serialize();
    const rts = (JSON.parse(cacheStr || "{}").RefreshToken) || {};
    const home = result && result.account && result.account.homeAccountId;
    const match = Object.values(rts).find(
      (rt) => rt && rt.secret && (!home || rt.home_account_id === home)
    );
    // Only report a token that is genuinely DIFFERENT. Reporting the same
    // bytes back would make every call a storage write for nothing, and would
    // hide a broken rotation behind constant churn.
    if (match && match.secret !== refreshToken) rotatedRefreshToken = match.secret;
  } catch (_e) {
    // A cache read that fails must NEVER break a working access token. The app
    // keeps running on the existing refresh token exactly as it does today —
    // this fix may extend the credential's life, never shorten it.
    rotatedRefreshToken = null;
  }
  return { result, rotatedRefreshToken };
}

module.exports = {
  OWNER_CONSENT_SCOPES,
  buildAuthCodeUrl,
  exchangeCodeForToken,
  acquireFromRefresh,
  // Exposed only for token-cache introspection in authCallback. Do not
  // call this for normal auth operations — use the typed wrappers above.
  _client: () => cca(),
};
