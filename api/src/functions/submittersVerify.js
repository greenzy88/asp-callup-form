// POST /api/submitters/verify — returning user picks their name from the
// dropdown + enters their PIN. Server checks hash (timing-safe), returns
// a fresh X-Submitter-Token JWT on success.
// Body: { submitter_id, pin }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { verifyPin } = require("../shared/submitters");

app.http("submittersVerify", {
  route: "submitters/verify",
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
      const result = await verifyPin(submitter_id, pin, upn);
      return { status: 200, jsonBody: result };
    } catch (e) {
      ctx.warn(`submittersVerify rejected: ${e.message}`);
      return { status: e.status || 500, jsonBody: { error: e.message, code: e.code || null } };
    }
  },
});
