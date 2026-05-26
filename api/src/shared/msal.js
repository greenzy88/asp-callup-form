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
  // MSAL-node v2: refresh-token grant goes through acquireTokenByRefreshToken,
  // but that path doesn't surface refresh-token rotation. We use it anyway —
  // Microsoft generally extends the refresh-token's lifetime on each use, so
  // active apps stay live without rotation.
  return cca().acquireTokenByRefreshToken({
    refreshToken,
    scopes: ["Files.ReadWrite", "Mail.Send"],
  });
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
