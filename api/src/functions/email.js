// POST /api/email — send an HTML email as the OWNER (David). Used by
// the SPA's notification on new-order / status-change events.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canEdit } = require("../shared/roles");
const { graphFetch } = require("../shared/graph");

app.http("email", {
  route: "email",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn } = await requireUser(req);
      if (!canEdit(upn)) {
        return { status: 403, jsonBody: { error: "Not authorised to send mail" } };
      }
      const body = await req.json();
      const to = body && body.to;
      const subject = body && body.subject;
      const html = body && body.html;
      if (!to || !subject || !html) {
        return { status: 400, jsonBody: { error: "Body must include to/subject/html" } };
      }

      const payload = {
        message: {
          subject: String(subject),
          body: { contentType: "HTML", content: String(html) },
          toRecipients: (Array.isArray(to) ? to : [to]).map((addr) => ({
            emailAddress: { address: String(addr) },
          })),
        },
        saveToSentItems: true,
      };

      const r = await graphFetch("/me/sendMail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok && r.status !== 202) {
        const txt = await r.text().catch(() => "");
        return { status: r.status, jsonBody: { error: `Graph sendMail ${r.status}`, body: txt.slice(0, 500) } };
      }
      return { status: 200, jsonBody: { ok: true } };
    } catch (e) {
      ctx.error("email failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
