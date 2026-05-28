// GET /api/submitters — list submitters visible to the caller.
//
// Scope: a caller signed in as atraining@ sees submitters whose
// parent_account=atraining@. A caller signed in as dramlagan@ sees
// submitters whose parent_account=dramlagan@ (their own test pool) — and
// when ?admin=1 is passed AND the caller is the owner, sees ALL submitters
// (across every parent_account) for the Manage Submitters panel.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { listForParent, listAll } = require("../shared/submitters");

app.http("submittersList", {
  route: "submitters",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn, role } = await requireUser(req);
      const adminMode = req.query.get("admin") === "1";
      if (adminMode) {
        if (role !== "owner") {
          return { status: 403, jsonBody: { error: "Only the owner can list all submitters" } };
        }
        const rows = await listAll();
        return { status: 200, jsonBody: { submitters: rows } };
      }
      const rows = await listForParent(upn);
      return { status: 200, jsonBody: { submitters: rows } };
    } catch (e) {
      ctx.error("submittersList failed:", e);
      return { status: e.status || 500, jsonBody: { error: e.message, code: e.code || null } };
    }
  },
});
