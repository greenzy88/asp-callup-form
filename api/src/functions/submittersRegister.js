// POST /api/submitters/register — first-time registration for a NEW name
// not in the dropdown. Caller's UPN becomes the parent_account, so each
// login pool (atraining@ / dramlagan@) maintains its own roster.
// Body: { display_name: string, pin: "1234" }.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { register } = require("../shared/submitters");

app.http("submittersRegister", {
  route: "submitters/register",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      const body = await req.json().catch(() => ({}));
      const { display_name, pin } = body || {};
      const result = await register(upn, display_name, pin);
      return { status: 200, jsonBody: result };
    } catch (e) {
      ctx.warn(`submittersRegister rejected: ${e.message}`);
      return { status: e.status || 500, jsonBody: { error: e.message, code: e.code || null } };
    }
  },
});
