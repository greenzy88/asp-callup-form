// POST /api/submitters/{submitterId}/manage — owner-only admin actions
// from the Manage Submitters panel. action ∈ { reset_pin, revoke, restore,
// delete }. Used both for cleaning up David's ADMIN_PIN_TEST trial users
// and for revoking real airport-planning people when they leave TPA.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { adminAction } = require("../shared/submitters");

app.http("submitterManage", {
  route: "submitters/{submitterId}/manage",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { role } = await requireUser(req);
      if (role !== "owner") {
        return { status: 403, jsonBody: { error: "Only the owner can manage submitters" } };
      }
      const submitterId = req.params.submitterId;
      const body = await req.json().catch(() => ({}));
      const { action } = body || {};
      if (!action) {
        return { status: 400, jsonBody: { error: "action is required" } };
      }
      const result = await adminAction(submitterId, action);
      return { status: 200, jsonBody: result };
    } catch (e) {
      ctx.error("submitterManage failed:", e);
      return { status: e.status || 500, jsonBody: { error: e.message, code: e.code || null } };
    }
  },
});
