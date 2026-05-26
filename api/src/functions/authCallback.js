// GET /api/auth/callback
// Microsoft redirects here with ?code=... after the owner consents.
// Exchange the code for tokens, persist the refresh_token, then bounce
// the browser back to the app root with a success flag.

const { app } = require("@azure/functions");
const msal = require("../shared/msal");
const tokenStore = require("../shared/tokenStore");
const config = require("../shared/config");

app.http("authCallback", {
  route: "auth/callback",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const errDesc = url.searchParams.get("error_description");
      if (err) {
        return {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: `<h2>Setup failed</h2><p><b>${err}</b></p><pre>${errDesc || ""}</pre>`,
        };
      }
      if (!code) {
        return {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: `<h2>Missing auth code</h2>`,
        };
      }

      // State check — best effort; cookie path needs to match. Skip if no cookie.
      const cookieHeader = (req.headers.get ? req.headers.get("cookie") : req.headers.cookie) || "";
      const cookieState = (/(?:^|;\s*)oauth_state=([^;]+)/.exec(cookieHeader) || [])[1];
      if (cookieState && state && cookieState !== state) {
        return { status: 400, jsonBody: { error: "state_mismatch" } };
      }

      const tokenResponse = await msal.exchangeCodeForToken(code);

      // MSAL doesn't surface refresh_token on the response object by
      // default — it lives in the token cache. Pull it from there.
      // (Microsoft's MSAL-node serialises the cache as JSON; we parse
      // the RefreshToken entry whose home_account_id matches the
      // returned account.)
      let refreshToken = null;
      try {
        const msalClient = msal._client();
        const cacheStr = await msalClient.getTokenCache().serialize();
        const cacheObj = JSON.parse(cacheStr || "{}");
        const rts = cacheObj.RefreshToken || {};
        const match = Object.values(rts).find(
          (rt) => rt && rt.home_account_id === tokenResponse.account.homeAccountId
        );
        if (match) refreshToken = match.secret;
      } catch (e) {
        ctx.warn("cache parse failed:", e.message);
      }

      // Fallback: some MSAL versions expose `refreshToken` directly on the response.
      if (!refreshToken && tokenResponse.refreshToken) {
        refreshToken = tokenResponse.refreshToken;
      }

      if (!refreshToken) {
        return {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: `<h2>Setup partially completed</h2>
                 <p>Got an access token but no refresh token. Check that
                 <code>offline_access</code> is in the API permissions on the
                 app registration, then re-run /api/auth/setup.</p>`,
        };
      }

      const capturedBy = (tokenResponse.account && tokenResponse.account.username) || "";
      // Sanity: only let the configured OWNER's account capture the token.
      const owner = config.ownerUpn();
      if (capturedBy && owner && capturedBy.toLowerCase() !== owner) {
        return {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: `<h2>Wrong account</h2>
                 <p>This setup must be completed by the owner (<code>${owner}</code>),
                 not <code>${capturedBy}</code>. Sign out of Microsoft, retry
                 /api/auth/setup as the owner.</p>`,
        };
      }

      await tokenStore.save(refreshToken, capturedBy);

      return {
        status: 302,
        headers: {
          Location: "/?setup=ok",
          "Set-Cookie": `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      };
    } catch (e) {
      ctx.error("authCallback failed:", e);
      return {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: `<h2>Setup failed</h2><pre>${e.message}</pre>`,
      };
    }
  },
});
