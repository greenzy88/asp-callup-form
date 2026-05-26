// POST /api/pdf/{filename} — upload a PDF body to the owner's
// ASP-CallUp folder. Body is the raw PDF bytes.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canEdit } = require("../shared/roles");
const { graphFetch } = require("../shared/graph");

const SAFE_NAME = /^[\w\-. ]{1,200}\.pdf$/i;

app.http("pdfUpload", {
  route: "pdf/{filename}",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      if (!canEdit(upn)) {
        return { status: 403, jsonBody: { error: "Not authorised to upload" } };
      }
      const filename = req.params.filename;
      if (!SAFE_NAME.test(filename)) {
        return { status: 400, jsonBody: { error: "Bad filename — alphanumerics/dots/dashes only, .pdf suffix required" } };
      }
      const bytes = Buffer.from(await req.arrayBuffer());
      if (!bytes.length) {
        return { status: 400, jsonBody: { error: "Empty body" } };
      }

      const r = await graphFetch(
        `/me/drive/root:/ASP-CallUp/${encodeURIComponent(filename)}:/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/pdf" },
          body: bytes,
        }
      );
      if (!r.ok) {
        const txt = await r.text();
        return { status: r.status, jsonBody: { error: `Graph upload ${r.status}`, body: txt.slice(0, 500) } };
      }
      const meta = await r.json();
      return { status: 200, jsonBody: { ok: true, filename: meta.name, id: meta.id } };
    } catch (e) {
      ctx.error("pdfUpload failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
