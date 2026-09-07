// GET /api/token-diag — WHY IS THE REFRESH TOKEN NOT ROTATING?  (2026-09-06)
//
// THE QUESTION
// Commit 2b9043f (2026-08-24) was written to persist the rotated refresh token
// Microsoft hands back on every use, after the un-rotated one died at exactly
// 90 days of inactivity and took the app down in front of the client. It writes
// `capturedAt` every time it saves.
//
// That timestamp has not moved since. The owner credential shows 2026-08-24
// after 13 days of constant use, and the notification credential captured at
// 01:56 today was unchanged after an hour and seven sends. Either Entra is not
// rotating, or MSAL is not caching what it returns, or our code is not finding
// it. Those need different fixes, and guessing between them is how the original
// bug survived: two comments asserted rotation worked and nobody checked.
//
// WHAT THIS DOES
// Performs one refresh per credential and REPORTS WHAT IT SAW. It is strictly
// read-only: it never calls tokenStore.save(), so it cannot change, corrupt or
// consume either credential. A refresh is what every ordinary request already
// does many times a day, so this adds no risk that normal traffic does not.
//
// It runs the question two ways and compares them:
//   probe   — a self-contained MSAL client, isolating "what did Entra and the
//             library actually do" from our wiring
//   wired   — the real msal.acquireFromRefresh(), which is read-only by design
//             (graph.js owns the saving), reporting what OUR code concludes
// If probe finds a rotated token and wired does not, the bug is our matching
// logic. If neither finds one, Entra is not returning one and the 2b9043f fix
// cannot work as written, whatever the code says.
//
// NO SECRETS ARE RETURNED. Tokens appear only as a SHA-256 prefix, which is
// enough to tell "same" from "different" and useless for anything else.
//
// Guarded exactly like /api/email-selftest: it does not exist unless the
// SELFTEST_KEY app setting is present, and the caller must present it. Set the
// key, read the answer, delete the key.

const { app } = require("@azure/functions");
const crypto = require("crypto");
const msalNode = require("@azure/msal-node");
const msal = require("../shared/msal");
const tokenStore = require("../shared/tokenStore");
const config = require("../shared/config");

const fp = (s) =>
  s ? crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12) : null;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readHeader(req, name) {
  if (!req || !req.headers) return "";
  if (typeof req.headers.get === "function") return req.headers.get(name) || "";
  return req.headers[name] || req.headers[name.toLowerCase()] || "";
}

// A fresh client per probe, so one credential's cache cannot be mistaken for
// the other's — the exact confusion this endpoint exists to rule out.
function freshClient() {
  return new msalNode.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId(),
      clientSecret: config.clientSecret(),
      authority: config.authority(),
    },
  });
}

async function probe(stored, scopes) {
  if (!stored || !stored.refreshToken) return { stored: false };
  const out = {
    stored: true,
    storedFingerprint: fp(stored.refreshToken),
    storedCapturedAt: stored.capturedAt,
    scopesRequested: scopes,
  };
  const cca = freshClient();
  let res;
  try {
    res = await cca.acquireTokenByRefreshToken({ refreshToken: stored.refreshToken, scopes });
  } catch (e) {
    out.refreshError = (e && (e.errorCode || e.errorMessage || e.message)) || String(e);
    return out;
  }
  out.gotAccessToken = !!(res && res.accessToken);
  out.scopesGranted = (res && res.scopes) || null;
  // Does the result carry an account? Our matching logic keys off this, and it
  // is only populated when the response included an id_token.
  out.hasAccount = !!(res && res.account);
  out.homeAccountId = res && res.account ? fp(res.account.homeAccountId) : null;
  out.hasIdToken = !!(res && res.idToken);

  // What actually landed in the cache?
  try {
    const cacheStr = await cca.getTokenCache().serialize();
    const parsed = JSON.parse(cacheStr || "{}");
    const rts = parsed.RefreshToken || {};
    const entries = Object.values(rts).filter((r) => r && r.secret);
    out.cacheRefreshTokenCount = entries.length;
    out.cacheAccessTokenCount = Object.keys(parsed.AccessToken || {}).length;
    out.cacheIdTokenCount = Object.keys(parsed.IdToken || {}).length;
    out.cacheAccountCount = Object.keys(parsed.Account || {}).length;
    out.cachedRefreshTokens = entries.map((r) => ({
      fingerprint: fp(r.secret),
      homeAccountIdFingerprint: fp(r.home_account_id),
      homeAccountIdEmpty: !r.home_account_id,
      differsFromStored: r.secret !== stored.refreshToken,
    }));
    // THE ANSWER: did Entra hand back a refresh token we are not keeping?
    out.entraReturnedARotatedToken = entries.some((r) => r.secret !== stored.refreshToken);
  } catch (e) {
    out.cacheError = e.message;
  }
  return out;
}

app.http("tokenDiag", {
  route: "token-diag",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const key = config.selftestKey();
      if (!key) return { status: 404, jsonBody: { error: "Not found" } };
      const presented = readHeader(req, "x-selftest-key");
      if (!presented || !timingSafeEqual(presented, key)) {
        ctx.warn("token-diag: rejected a call with a bad or missing key");
        return { status: 404, jsonBody: { error: "Not found" } };
      }

      const ownerStored = await tokenStore.load().catch((e) => ({ error: e.message }));
      const notifyStored = await tokenStore.loadNotify().catch((e) => ({ error: e.message }));

      const result = {
        note: "READ-ONLY. No token is saved, replaced or revoked by this endpoint.",
        owner: {
          isolatedProbe: await probe(ownerStored, ["Files.ReadWrite", "Mail.Send"]),
        },
        notify: {
          isolatedProbe: await probe(notifyStored, ["Mail.Send"]),
        },
      };

      // And what does the SHIPPED code conclude? acquireFromRefresh is
      // read-only — graph.js is what persists — so this is safe to call.
      try {
        const wired = await msal.acquireFromRefresh(ownerStored.refreshToken);
        result.owner.wiredVerdict = {
          gotAccessToken: !!(wired.result && wired.result.accessToken),
          hasAccount: !!(wired.result && wired.result.account),
          rotatedTokenFound: !!wired.rotatedRefreshToken,
          rotatedFingerprint: fp(wired.rotatedRefreshToken),
          wouldHaveSaved: !!wired.rotatedRefreshToken,
        };
      } catch (e) {
        result.owner.wiredVerdict = { error: e.message };
      }

      return { status: 200, jsonBody: result };
    } catch (e) {
      ctx.error("token-diag failed:", e);
      return { status: e.status || 500, jsonBody: { error: e.message } };
    }
  },
});
