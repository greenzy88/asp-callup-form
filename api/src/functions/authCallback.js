// GET /api/auth/callback
// Microsoft redirects here with ?code=... after the owner consents.
// Exchange the code for tokens, persist the refresh_token, then bounce
// the browser back to the app root with a success flag.
//
// 2026-09-06 — this callback now serves TWO flows, told apart by the `state`
// prefix set in authSetup.js:
//   no prefix  -> the OWNER credential  (OneDrive + mail). Unchanged.
//   "notify:"  -> the NOTIFICATION SENDER credential (Mail.Send only).
// Each flow has its own MSAL client, its own storage partition, and its own
// identity guard below. A notify sign-in can never write the owner's row and
// an owner sign-in can never write the notify row — the guard is the same
// "wrong account" 403 that has protected the owner's row since May, applied
// twice with different expected accounts.

const { app } = require("@azure/functions");
const msal = require("../shared/msal");
const notifyMailer = require("../shared/notifyMailer");
const tokenStore = require("../shared/tokenStore");
const config = require("../shared/config");

const NOTIFY_STATE_PREFIX = "notify:";

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

      const isNotifyFlow = String(state || "").startsWith(NOTIFY_STATE_PREFIX);

      // ── NOTIFICATION SENDER capture ─────────────────────────────────────
      // Kept entirely ahead of the owner path so it shares none of its code.
      if (isNotifyFlow) {
        const want = config.notifySenderUpn();
        const captured = await notifyMailer.exchangeCodeForToken(code);
        const who = String(captured.capturedBy || "").toLowerCase();
        if (!who || who !== want) {
          return {
            status: 403,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: `<h2>Wrong account</h2>
                   <p>The notification sender must be <code>${want}</code>,
                   not <code>${captured.capturedBy || "(unknown)"}</code>.
                   Sign out of Microsoft and retry
                   <code>/api/auth/setup?as=notify</code> as that account.</p>
                   <p><b>Nothing was changed.</b> Notifications are still being
                   sent exactly as they were a moment ago.</p>`,
          };
        }
        if (!captured.refreshToken) {
          return {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: `<h2>Setup partially completed</h2>
                   <p>Signed in as <code>${captured.capturedBy}</code> but got no
                   refresh token, so nothing was saved. Check that
                   <code>offline_access</code> is on the app registration, then
                   retry <code>/api/auth/setup?as=notify</code>.</p>`,
          };
        }
        await tokenStore.saveNotify(captured.refreshToken, captured.capturedBy);
        return {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          },
          body: `<h2>Notification sender ready</h2>
                 <p>Call-up notifications can now be sent as
                 <code>${captured.capturedBy}</code>.</p>
                 <p>They are <b>not</b> switched over yet — that is the
                 <code>NOTIFY_SENDER_MODE</code> app setting. Until it is set to
                 <code>notify</code>, everything continues exactly as before.</p>`,
        };
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
