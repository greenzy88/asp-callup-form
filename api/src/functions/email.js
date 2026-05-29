// POST /api/email — send an HTML email as the OWNER (David). Used by
// the SPA's notification on new-order / status-change events.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canEdit } = require("../shared/roles");
const { requireSubmitterIfClient } = require("../shared/submitters");
const { graphFetch } = require("../shared/graph");
const config = require("../shared/config");

app.http("email", {
  route: "email",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { upn, role } = await requireUser(req);
      if (!canEdit(upn)) {
        return { status: 403, jsonBody: { error: "Not authorised to send mail" } };
      }
      // Require submitter token from clients (and admin in ADMIN_PIN_TEST).
      await requireSubmitterIfClient(req, { upn, role });
      const body = await req.json();
      const to = body && body.to;
      const subject = body && body.subject;
      const html = body && body.html;
      const attachmentFilename = body && body.attachmentFilename;
      if (!to || !subject || !html) {
        return { status: 400, jsonBody: { error: "Body must include to/subject/html" } };
      }

      // 2026-05-27 — optionally attach a PDF from the owner's ASP-CallUp
      // folder. Same filename safety as pdfDownload. Graph sendMail
      // supports file attachments up to 4 MB inline; typical TPO PDFs
      // are ~400 KB so we stay well within. A larger attachment would
      // need createUploadSession; we cap the body to fail fast.
      const attachments = [];
      if (attachmentFilename) {
        const SAFE_NAME = /^[\w\-. ]{1,200}\.pdf$/i;
        if (!SAFE_NAME.test(attachmentFilename)) {
          return { status: 400, jsonBody: { error: "Bad attachmentFilename" } };
        }
        const r = await graphFetch(
          `/me/drive/root:/ASP-CallUp/${encodeURIComponent(attachmentFilename)}:/content`,
          { method: "GET", redirect: "follow" }
        );
        if (!r.ok) {
          ctx.warn(`email: skipping attachment ${attachmentFilename}: Graph ${r.status}`);
        } else {
          const pdfBuf = Buffer.from(await r.arrayBuffer());
          if (pdfBuf.length > 4 * 1024 * 1024) {
            ctx.warn(`email: attachment ${attachmentFilename} > 4 MB, skipping`);
          } else {
            attachments.push({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: attachmentFilename,
              contentType: "application/pdf",
              contentBytes: pdfBuf.toString("base64"),
            });
          }
        }
      }

      // 2026-05-28 — visual sender mask. The underlying address stays the
      // authenticated owner (Graph sendMail requires from.address == auth
      // user OR a SendAs-permitted address). We override the display name
      // so recipients see e.g. "ASP Call-Up Notifications (Do Not Reply)"
      // in the From field instead of "David Ramlagan".
      const payload = {
        message: {
          subject: String(subject),
          body: { contentType: "HTML", content: String(html) },
          from: {
            emailAddress: {
              name: config.senderDisplayName(),
              address: config.ownerUpn(),
            },
          },
          toRecipients: (Array.isArray(to) ? to : [to]).map((addr) => ({
            emailAddress: { address: String(addr) },
          })),
          ...(attachments.length ? { attachments } : {}),
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
