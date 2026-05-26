// GET /api/me
// Returns the caller's UPN + resolved role, used by the SPA to render
// the badge + decide which UI to show.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");

app.http("me", {
  route: "me",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn, role } = await requireUser(req);
      return { status: 200, jsonBody: { upn, role } };
    } catch (e) {
      ctx.warn(`/api/me rejected: ${e.message}`);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
