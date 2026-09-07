// NOTIFICATION SENDER IDENTITY  (2026-09-06)
//
// WHY THIS FILE EXISTS
// Every call-up notification used to leave as dramlagan@security-asp.com,
// because the backend holds exactly one credential — David's — and Graph will
// not let /me/sendMail claim a From address other than the mailbox it
// authenticated as. That is a business-continuity problem: the airport's
// notifications are tied to one person's account. They now leave as
// atraining@security-asp.com, the shared account BBTCA staff already sign into
// the form with.
//
// WHY IT IS A SEPARATE MODULE, NOT A FLAG IN graph.js/msal.js
// graph.js is the OneDrive path: the spreadsheet, the post-order PDFs, the
// Submitters sheet. If that credential breaks, the app stops working for the
// client. This module never touches it. It has:
//   * its own ConfidentialClientApplication  -> its own MSAL token cache, so a
//     rotated refresh token can never be written into the wrong identity's row
//   * its own Table Storage row, in its own PARTITION (tokenStore.NOTIFY_KEY)
//   * its own scope set: Mail.Send only. No Files, no Sites. This identity is
//     permitted to send mail and to do nothing else.
// The worst failure this file can cause is "notifications went out as David
// again", which is where we started.
//
// THE 2026-08-24 LESSON IS CARRIED OVER, NOT RE-LEARNED
// Entra hands back a NEW refresh token on use and kills the old one after 90
// days of inactivity. graph.js used to discard the rotated token and the app
// died in front of clients (AADSTS700082). getAccessToken() below persists the
// rotation on every refresh, exactly as graph.js:28 now does.

const msalNode = require("@azure/msal-node");
const config = require("./config");
const tokenStore = require("./tokenStore");

// One-time consent capture. offline_access is what asks Microsoft for a
// refresh token; User.Read is what lets the callback confirm WHICH account
// signed in, so a mis-click cannot install the wrong sender.
const CONSENT_SCOPES = ["Mail.Send", "User.Read", "offline_access"];
// Refresh-time scopes. Deliberately narrower than the consent set.
const REFRESH_SCOPES = ["Mail.Send"];

let _cca = null;
function cca() {
  if (_cca) return _cca;
  _cca = new msalNode.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId(),
      clientSecret: config.clientSecret(),
      authority: config.authority(),
    },
  });
  return _cca;
}

// MSAL-node does not expose refresh tokens on the response object; they live in
// the serialised cache. Match STRICTLY on home_account_id — never "take
// whatever is in the cache". With two identities alive in one process, a loose
// match is exactly how the notification account's token would end up written
// into the owner's row.
async function cachedRefreshTokenFor(homeAccountId) {
  if (!homeAccountId) return null;
  try {
    const cacheStr = await cca().getTokenCache().serialize();
    const rts = (JSON.parse(cacheStr || "{}").RefreshToken) || {};
    const match = Object.values(rts).find(
      (rt) => rt && rt.secret && rt.home_account_id === homeAccountId
    );
    return match ? match.secret : null;
  } catch (_) {
    // A cache read that fails must never break a working access token.
    return null;
  }
}

// ── One-time capture (/api/auth/setup?as=notify) ────────────────────────────

async function buildAuthCodeUrl(state) {
  return cca().getAuthCodeUrl({
    scopes: CONSENT_SCOPES,
    redirectUri: config.redirectUri(),
    state,
    // "login", not "consent": the browser doing this is usually already signed
    // in as the owner, and silently reusing that session would capture the
    // WRONG mailbox. Force credentials for the account we actually want.
    prompt: "login",
  });
}

async function exchangeCodeForToken(code) {
  const result = await cca().acquireTokenByCode({
    code,
    scopes: CONSENT_SCOPES,
    redirectUri: config.redirectUri(),
  });
  const home = result && result.account && result.account.homeAccountId;
  let refreshToken = await cachedRefreshTokenFor(home);
  if (!refreshToken && result && result.refreshToken) refreshToken = result.refreshToken;
  return {
    refreshToken: refreshToken || null,
    capturedBy: (result && result.account && result.account.username) || "",
  };
}

// ── Access token, with rotation persisted ───────────────────────────────────

let _cached = null; // { accessToken, expiresOn }

function notReady(msg, code) {
  const e = new Error(msg);
  e.status = 503;
  e.code = code;
  return e;
}

async function getAccessToken() {
  const now = Date.now();
  // 60s safety margin against clock skew, same as graph.js.
  if (_cached && _cached.expiresOn - 60000 > now) return _cached.accessToken;

  const stored = await tokenStore.loadNotify();
  if (!stored || !stored.refreshToken) {
    throw notReady(
      "Notification sender has not been set up. Visit /api/auth/setup?as=notify " +
        "and sign in as " + config.notifySenderUpn() + ".",
      "NOTIFY_NOT_AUTHED"
    );
  }
  // Guard against a stored credential for the wrong mailbox — e.g. if
  // NOTIFY_SENDER_UPN is edited after a capture. Better to fall back to the
  // owner than to send from an account nobody is expecting.
  const want = config.notifySenderUpn();
  if (stored.capturedBy && want && String(stored.capturedBy).toLowerCase() !== want) {
    throw notReady(
      "Stored notification sender is " + stored.capturedBy + ", but NOTIFY_SENDER_UPN is " +
        want + ". Re-run /api/auth/setup?as=notify as the intended account.",
      "NOTIFY_IDENTITY_MISMATCH"
    );
  }

  let res;
  try {
    res = await cca().acquireTokenByRefreshToken({
      refreshToken: stored.refreshToken,
      scopes: REFRESH_SCOPES,
    });
  } catch (e) {
    throw notReady(
      "Notification sender refresh failed: " + (e.errorMessage || e.message) +
        ". Re-run /api/auth/setup?as=notify.",
      "NOTIFY_REFRESH_FAILED"
    );
  }

  const home = res && res.account && res.account.homeAccountId;
  const rotated = await cachedRefreshTokenFor(home);
  if (rotated && rotated !== stored.refreshToken) {
    // Persist BEFORE returning, and never let a storage failure fail a send
    // that already holds a good access token. A missed save costs the old
    // token's remaining life; the next call retries the rotation.
    try {
      await tokenStore.saveNotify(rotated, stored.capturedBy);
    } catch (_saveErr) {
      /* deliberately swallowed — see the comment above */
    }
  }

  _cached = {
    accessToken: res.accessToken,
    expiresOn: res.expiresOn ? new Date(res.expiresOn).getTime() : now + 50 * 60 * 1000,
  };
  return _cached.accessToken;
}

// ── Send ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// POST /me/sendMail as the notification identity. `message` is a Graph message
// resource already built by the caller — the same object the owner path sends,
// so the two routes cannot drift in content, only in identity.
async function sendMail(message, saveToSentItems, attempt) {
  const n = attempt || 0;
  const accessToken = await getAccessToken();
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      saveToSentItems: saveToSentItems !== false,
    }),
  });
  if ((r.status === 429 || (r.status >= 500 && r.status !== 501)) && n < 3) {
    const ra = parseInt(r.headers.get("retry-after") || "", 10);
    const wait = Number.isFinite(ra) && ra > 0 && ra < 60 ? ra * 1000 : 500 * Math.pow(2, n);
    await sleep(wait);
    return sendMail(message, saveToSentItems, n + 1);
  }
  if (!r.ok && r.status !== 202) {
    const txt = await r.text().catch(() => "");
    const e = new Error("Graph sendMail " + r.status + ": " + txt.slice(0, 300));
    e.status = r.status;
    e.graphBody = txt;
    throw e;
  }
  return true;
}

// ── Health, surfaced by /api/auth/status ────────────────────────────────────

const MAX_INACTIVE_DAYS = 90;
const WARN_AT_DAYS = 60;

async function status() {
  const t = await tokenStore.loadNotify().catch(() => null);
  let ageDays = null;
  if (t && t.capturedAt) {
    const ms = Date.now() - new Date(t.capturedAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) ageDays = +(ms / 86400000).toFixed(2);
  }
  const want = config.notifySenderUpn();
  return {
    mode: config.notifySenderMode(),
    senderUpn: want,
    fallbackToOwner: config.notifyFallbackToOwner(),
    ready: !!(t && t.refreshToken),
    capturedBy: t ? t.capturedBy : null,
    capturedAt: t ? t.capturedAt : null,
    identityMatches: t && t.capturedBy ? String(t.capturedBy).toLowerCase() === want : null,
    ageDays,
    maxInactiveDays: MAX_INACTIVE_DAYS,
    // null must never render as "fine" — that is how 90 days passed unremarked
    // on the owner token in 2026-08.
    stale: ageDays === null ? null : ageDays >= WARN_AT_DAYS,
    expiresInDays: ageDays === null ? null : +(MAX_INACTIVE_DAYS - ageDays).toFixed(2),
  };
}

module.exports = {
  CONSENT_SCOPES,
  buildAuthCodeUrl,
  exchangeCodeForToken,
  getAccessToken,
  sendMail,
  status,
};
