// GET /api/auth/setup           -> capture the OWNER credential (OneDrive + mail)
// GET /api/auth/setup?as=notify  -> capture the NOTIFICATION SENDER credential
//
// One-time flow: the person visits this URL, gets redirected to Microsoft to
// sign in, MS sends them to /api/auth/callback which captures the
// refresh_token.
//
// 2026-09-06 — the ?as=notify variant. It asks for Mail.Send only (no Files,
// no Sites) and is expected to be completed by the shared notification mailbox
// (NOTIFY_SENDER_UPN, default atraining@security-asp.com). The callback
// enforces WHICH account may complete WHICH flow, so a wrong sign-in here
// cannot overwrite the owner's credential — it is rejected with a 403.

const { app } = require("@azure/functions");
const msal = require("../shared/msal");
const notifyMailer = require("../shared/notifyMailer");
const crypto = require("crypto");

// Prefix on the OAuth `state` that tells the callback which credential is
// being captured. It travels through Microsoft and comes back verbatim, and it
// is cross-checked against the state cookie exactly as before.
const NOTIFY_STATE_PREFIX = "notify:";

app.http("authSetup", {
  route: "auth/setup",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      // Random state so the callback can confirm this came from us.
      // Stored in a short-lived cookie.
      const url = new URL(req.url);
      const asNotify = String(url.searchParams.get("as") || "").toLowerCase() === "notify";
      const state = (asNotify ? NOTIFY_STATE_PREFIX : "") +
        crypto.randomBytes(16).toString("hex");
      const authUrl = asNotify
        ? await notifyMailer.buildAuthCodeUrl(state)
        : await msal.buildAuthCodeUrl(state);
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
