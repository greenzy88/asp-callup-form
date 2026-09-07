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
//   4. It sends one message. It reads nothing, writes nothing, and touches no
//      stored credential except to use it.

const { app } = require("@azure/functions");
const crypto = require("crypto");
const { sendConfigured } = require("../shared/mailSend");
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
            "</ul>" +
            "<p>No order was created, changed or notified. Nobody else received this.</p>",
        },
        toRecipients: [{ emailAddress: { address: to } }],
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
