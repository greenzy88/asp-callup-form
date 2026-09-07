// POST /api/email — send an HTML notification email. Used by the SPA on
// new-order / status-change events.
//
// 2026-09-06: WHO the mail comes from is no longer decided here. It is decided
// by shared/mailSend.js from the NOTIFY_SENDER_MODE app setting — "owner"
// (the original: as David) or "notify" (as the shared atraining@ mailbox, for
// business continuity). Everything else in this file — the caller auth, the
// submitter check, the recipient allowlist, the attachment fetch from the
// OWNER's OneDrive — is unchanged and applies identically in both modes.

const { app } = require("@azure/functions");
const { requireUser } = require("../shared/auth");
const { canEdit } = require("../shared/roles");
const { requireSubmitterIfClient } = require("../shared/submitters");
const { graphFetch } = require("../shared/graph");
const { sendConfigured } = require("../shared/mailSend");
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

      // 2026-05-28 — recipient hardening. /api/email sends AS THE OWNER, so
      // an unconstrained `to` makes the owner's mailbox an open relay for
      // phishing. Enforce: valid email format, a per-send count cap, and
      // (when configured) an allowlist of exact addresses / @domains.
      const recipients = (Array.isArray(to) ? to : [to])
        .map((a) => String(a || "").trim().toLowerCase())
        .filter(Boolean);
      if (!recipients.length) {
        return { status: 400, jsonBody: { error: "No valid recipient in `to`" } };
      }
      const maxRecipients = config.emailMaxRecipients();
      if (recipients.length > maxRecipients) {
        return { status: 400, jsonBody: { error: `Too many recipients (max ${maxRecipients})` } };
      }
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const badFormat = recipients.filter((a) => !EMAIL_RE.test(a));
      if (badFormat.length) {
        return { status: 400, jsonBody: { error: `Malformed recipient(s): ${badFormat.join(", ")}` } };
      }
      const allowlist = config.emailRecipientAllowlist();
      if (allowlist.length) {
        const allowed = (addr) =>
          allowlist.some((rule) =>
            rule.startsWith("@") ? addr.endsWith(rule) : addr === rule
          );
        const blocked = recipients.filter((a) => !allowed(a));
        if (blocked.length) {
          ctx.warn(`email: blocked non-allowlisted recipient(s): ${blocked.join(", ")}`);
          return { status: 403, jsonBody: { error: `Recipient(s) not permitted: ${blocked.join(", ")}` } };
        }
      } else {
        ctx.warn("email: EMAIL_RECIPIENT_ALLOWLIST not configured — sending without domain restriction");
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

      // The message itself is identical whichever identity sends it. The
      // display-name mask ("ASP Call-Up Notifications (Do Not Reply)") is
      // applied by mailSend.js alongside the From address, so the two can
      // never disagree.
      const message = {
        subject: String(subject),
        body: { contentType: "HTML", content: String(html) },
        toRecipients: recipients.map((addr) => ({
          emailAddress: { address: addr },
        })),
        ...(attachments.length ? { attachments } : {}),
      };

      let sent;
      try {
        sent = await sendConfigured(ctx, message);
      } catch (sendErr) {
        // Same response shape the owner-only version returned, so the SPA and
        // anything reading these logs see no change.
        return {
          status: sendErr.status || 502,
          jsonBody: {
            error: sendErr.message,
            body: sendErr.graphBody || undefined,
          },
        };
      }
      if (sent.fellBack) {
        ctx.warn(`email: sent as OWNER after the notify sender failed — ${sent.notifyError}`);
      }
      return { status: 200, jsonBody: { ok: true, sentAs: sent.sentAs } };
    } catch (e) {
      ctx.error("email failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message },
      };
    }
  },
});
