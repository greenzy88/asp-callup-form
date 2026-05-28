// POST /api/submitters/set-initial-pin — pre-seeded names (Holly, Denise,
// Chad) start with no PIN; the first time they pick their name from the
// dropdown, the SPA prompts them to choose a 4-digit PIN, then POSTs here.
// 409 if a PIN is already set (use verify instead, or ask admin to reset).
// Body: { submitter_id, pin }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { setInitialPin } = require("../shared/submitters");

app.http("submittersSetInitialPin", {
  route: "submitters/set-initial-pin",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      const body = await req.json().catch(() => ({}));
      const { submitter_id, pin } = body || {};
      if (!submitter_id) {
        return { status: 400, jsonBody: { error: "submitter_id is required" } };
      }
      const result = await setInitialPin(submitter_id, pin, upn);
      return { status: 200, jsonBody: result };
    } catch (e) {
      ctx.warn(`submittersSetInitialPin rejected: ${e.message}`);
      return { status: e.status || 500, jsonBody: { error: e.message, code: e.code || null } };
    }
  },
});
