// POST /api/email-selftest  —  send ONE notification to the owner and nobody else.
//
// WHY THIS EXISTS (2026-09-06)
// The only other way to see what a real notification looks like is to submit a
// real call-up, which emails eight people at the Toronto Port Authority and
// ASP. That is not a test, that is an incident. This sends a single message,
// through the SAME code path production uses (shared/mailSend.js), to
// OWNER_UPN — an address that is hardcoded here and cannot be supplied by the
// caller.
//
// HOW IT IS GUARDED
//   1. It does not exist unless the SELFTEST_KEY app setting is set. Unset —
//      which is the normal state — returns 404, the same as a route that was
//      never deployed. Delete the setting after a verification and the
//      endpoint is gone again, with no code push.
//   2. When it does exist, the caller must present that secret in the
//      X-Selftest-Key header, compared in constant time.
//   3. The recipient is config.ownerUpn(). There is no `to` parameter.
//   4. It sends one message. It writes nothing, and touches no stored
//      credential except to use it.
//
// OPTIONAL ATTACHMENT: POST {"attach": true} makes it pick the newest PDF in
// the owner's ASP-CallUp folder and attach it. That verifies the one
// combination the switch to the shared sender actually creates and which
// nothing else exercises: a file read from the OWNER's OneDrive, on the
// OWNER's credential, sent out of a DIFFERENT mailbox. Real "new" and
// "completed" notifications do exactly that. The folder is only READ.
//
// The attach step is duplicated here rather than shared with email.js on
// purpose: email.js is the live notification path and this change had no
// business editing it a second time to make a test more elegant.

const { app } = require("@azure/functions");
const crypto = require("crypto");
const { sendConfigured } = require("../shared/mailSend");
const { graphFetch } = require("../shared/graph");
const config = require("../shared/config");

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readHeader(req, name) {
  if (!req || !req.headers) return "";
  if (typeof req.headers.get === "function") return req.headers.get(name) || "";
  return req.headers[name] || req.headers[name.toLowerCase()] || "";
}

app.http("emailSelftest", {
  route: "email-selftest",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const key = config.selftestKey();
      if (!key) {
        // Not enabled. Indistinguishable from "no such endpoint".
        return { status: 404, jsonBody: { error: "Not found" } };
      }
      const presented = readHeader(req, "x-selftest-key");
      if (!presented || !timingSafeEqual(presented, key)) {
        ctx.warn("email-selftest: rejected a call with a bad or missing key");
        return { status: 404, jsonBody: { error: "Not found" } };
      }

      const to = config.ownerUpn(); // hardcoded destination — not caller-supplied
      const stamp = new Date().toISOString();

      // Optional: attach the newest PDF from the owner's ASP-CallUp folder.
      let body = null;
      try { body = await req.json(); } catch (_) { body = null; }
      const attachments = [];
      let attachedName = null;
      if (body && body.attach) {
        const listing = await graphFetch(
          "/me/drive/root:/ASP-CallUp:/children?$select=name,size,lastModifiedDateTime&$top=200"
        );
        if (!listing.ok) {
          return {
            status: 502,
            jsonBody: { error: "Could not list ASP-CallUp: Graph " + listing.status },
          };
        }
        const items = (await listing.json()).value || [];
        const pdfs = items
          .filter((i) => /\.pdf$/i.test(i.name || "") && (i.size || 0) < 4 * 1024 * 1024)
          .sort((a, b) =>
            String(b.lastModifiedDateTime || "").localeCompare(String(a.lastModifiedDateTime || ""))
          );
        if (!pdfs.length) {
          return { status: 404, jsonBody: { error: "No PDF under 4 MB in ASP-CallUp" } };
        }
        attachedName = pdfs[0].name;
        const r = await graphFetch(
          "/me/drive/root:/ASP-CallUp/" + encodeURIComponent(attachedName) + ":/content",
          { method: "GET", redirect: "follow" }
        );
        if (!r.ok) {
          return {
            status: 502,
            jsonBody: { error: "Could not read " + attachedName + ": Graph " + r.status },
          };
        }
        const pdfBuf = Buffer.from(await r.arrayBuffer());
        attachments.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachedName,
          contentType: "application/pdf",
          contentBytes: pdfBuf.toString("base64"),
        });
      }
      const message = {
        subject: "Call-Up notification sender self-test (" + stamp + ")",
        body: {
          contentType: "HTML",
          content:
            "<h2>Call-Up notification sender self-test</h2>" +
            "<p>This message was sent through the same code path that sends real " +
            "call-up notifications. Check the <b>From</b> address at the top of it.</p>" +
            "<ul>" +
            "<li><b>Mode:</b> " + config.notifySenderMode() + "</li>" +
            "<li><b>Configured sender:</b> " + config.notifySenderUpn() + "</li>" +
            "<li><b>Display name:</b> " + config.senderDisplayName() + "</li>" +
            "<li><b>Sent at:</b> " + stamp + "</li>" +
            (attachedName
              ? "<li><b>Attachment:</b> " + attachedName + " — read from the owner's " +
                "OneDrive on the owner's credential, sent from the address above</li>"
              : "") +
            "</ul>" +
            "<p>No order was created, changed or notified. Nobody else received this.</p>",
        },
        toRecipients: [{ emailAddress: { address: to } }],
        ...(attachments.length ? { attachments } : {}),
      };

      const sent = await sendConfigured(ctx, message);
      return {
        status: 200,
        jsonBody: {
          ok: true,
          to,
          mode: sent.mode,
          sentAs: sent.sentAs,
          fellBackToOwner: sent.fellBack,
          notifyError: sent.notifyError,
          attached: attachedName,
        },
      };
    } catch (e) {
      ctx.error("email-selftest failed:", e);
      return {
        status: e.status || 500,
        jsonBody: { error: e.message, body: e.graphBody || undefined },
      };
    }
  },
});
