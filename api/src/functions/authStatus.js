// GET /api/auth/status
// Returns whether the owner has completed /api/auth/setup. Used by
// the frontend to show a "needs owner re-auth" banner.

const { app } = require("@azure/functions");
const tokenStore = require("../shared/tokenStore");

app.http("authStatus", {
  route: "auth/status",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (_req, ctx) => {
    try {
      const t = await tokenStore.load();
      return {
        status: 200,
        jsonBody: {
          ready: !!(t && t.refreshToken),
          capturedBy: t ? t.capturedBy : null,
          capturedAt: t ? t.capturedAt : null,
        },
      };
    } catch (e) {
      ctx.error("authStatus failed:", e);
      return { status: 500, jsonBody: { error: e.message } };
    }
  },
});
