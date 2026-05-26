// GET /api/pdf/{filename} — stream a PDF from the owner's ASP-CallUp
// folder back to the caller. The function proxies the bytes so we
// avoid CORS issues with the @microsoft.graph.downloadUrl pre-signed
// link (and avoid leaking the URL).

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { graphFetch } = require("../shared/graph");

const SAFE_NAME = /^[\w\-. ]{1,200}\.pdf$/i;

app.http("pdfDownload", {
  route: "pdf/{filename}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      await requireUser(req);
      const filename = req.params.filename;
      if (!SAFE_NAME.test(filename)) {
        return { status: 400, jsonBody: { error: "Bad filename" } };
      }
      const r = await graphFetch(
        `/me/drive/root:/ASP-CallUp/${encodeURIComponent(filename)}:/content`,
        { method: "GET", redirect: "follow" }
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return { status: r.status, jsonBody: { error: `Graph fetch ${r.status}`, body: txt.slice(0, 500) } };
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${filename.replace(/[^\w\-. ]/g, "_")}"`,
          "Cache-Control": "private, max-age=60",
        },
        body: buf,
      };
    } catch (e) {
      ctx.error("pdfDownload failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
