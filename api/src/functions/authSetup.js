// GET /api/auth/setup
// One-time flow: the owner visits this URL, gets redirected to
// Microsoft to consent + sign in, MS sends them to /api/auth/callback
// which captures the refresh_token.

const { app } = require("@azure/functions");
const msal = require("../shared/msal");
const crypto = require("crypto");

app.http("authSetup", {
  route: "auth/setup",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      // Random state so the callback can confirm this came from us.
      // Stored in a short-lived cookie.
      const state = crypto.randomBytes(16).toString("hex");
      const authUrl = await msal.buildAuthCodeUrl(state);
      return {
        status: 302,
        headers: {
          Location: authUrl,
          "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      };
    } catch (e) {
      ctx.error("authSetup failed:", e);
      return { status: 500, jsonBody: { error: e.message } };
    }
  },
});
