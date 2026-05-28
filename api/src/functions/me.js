// GET /api/me
// Returns the caller's UPN + resolved role, used by the SPA to render
// the badge + decide which UI to show.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const config = require("../shared/config");

app.http("me", {
  route: "me",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn, role } = await requireUser(req);
      // SPA uses these to decide whether to show the Name+PIN dialog.
      // Clients always see it; owner sees it only when ADMIN_PIN_TEST=1.
      const adminPinTest = config.adminPinTest();
      const submitterDialogRequired =
        role === "client" || (role === "owner" && adminPinTest);
      return {
        status: 200,
        jsonBody: {
          upn,
          role,
          submitter_dialog_required: submitterDialogRequired,
          admin_pin_test_enabled: adminPinTest,
        },
      };
    } catch (e) {
      ctx.warn(`/api/me rejected: ${e.message}`);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
