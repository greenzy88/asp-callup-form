// ONE PLACE THAT DECIDES WHO A NOTIFICATION IS FROM  (2026-09-06)
//
// Both /api/email (the real notifications) and /api/email-selftest (the
// owner-only verification send) go through sendConfigured(). That is
// deliberate: a self-test that exercises a different code path than production
// proves nothing.
//
// MODES
//   NOTIFY_SENDER_MODE unset / "owner"  -> exactly the behaviour that shipped
//        before this change: /me/sendMail on the owner's token, From =
//        OWNER_UPN with the SENDER_DISPLAY_NAME mask. Deploying this file
//        changes nothing until the app setting is flipped.
//   NOTIFY_SENDER_MODE = "notify"       -> sent by the notification identity
//        (NOTIFY_SENDER_UPN, default atraining@security-asp.com) on its own
//        stored credential. From = that mailbox, so replies land there too.
//
// FALLBACK
// If the notify identity fails for any reason — the shared account's password
// was changed, the token was revoked, Graph is having a bad day — we log the
// failure and send as the owner instead, unless NOTIFY_FALLBACK_TO_OWNER=0.
// The airport hearing about a call-up matters more than the From address on
// the email that tells them.
//
// WHAT DOES NOT CHANGE IN EITHER MODE
// The PDF attachment is still read from the OWNER's OneDrive with the OWNER's
// token (email.js does that before calling here). Only the envelope moves.

const { graphFetch } = require("./graph");
const notifyMailer = require("./notifyMailer");
const config = require("./config");

// message: a Graph message resource WITHOUT `from` — this module owns the
// From address, because that is the whole point of it.
// Returns { sentAs, mode, fellBack, notifyError }.
async function sendConfigured(ctx, message, opts) {
  const options = opts || {};
  const saveToSentItems = options.saveToSentItems !== false;
  const mode = config.notifySenderMode();
  const displayName = config.senderDisplayName();

  if (mode === "notify") {
    const senderUpn = config.notifySenderUpn();
    try {
      await notifyMailer.sendMail(
        Object.assign({}, message, {
          from: { emailAddress: { name: displayName, address: senderUpn } },
        }),
        saveToSentItems
      );
      return { sentAs: senderUpn, mode, fellBack: false, notifyError: null };
    } catch (e) {
      const detail = (e && (e.code || "")) + " " + (e && e.message ? e.message : String(e));
      if (!config.notifyFallbackToOwner()) {
        // Hard-fail mode: surface it to the caller rather than quietly
        // reverting to the owner's address.
        if (ctx && ctx.error) ctx.error("mailSend: notify sender failed, fallback DISABLED:", detail);
        const err = new Error("Notification sender failed: " + detail);
        err.status = e && e.status ? e.status : 502;
        err.code = (e && e.code) || "NOTIFY_SEND_FAILED";
        throw err;
      }
      if (ctx && ctx.error) {
        ctx.error(
          "mailSend: notify sender (" + senderUpn + ") FAILED — falling back to owner. " +
            "The From address on this notification is the owner's, not the shared account's. " +
            "Check /api/auth/status -> notify. Detail: " + detail
        );
      }
      const res = await sendAsOwner(message, displayName, saveToSentItems);
      return Object.assign(res, { mode, fellBack: true, notifyError: detail });
    }
  }

  const res = await sendAsOwner(message, displayName, saveToSentItems);
  return Object.assign(res, { mode, fellBack: false, notifyError: null });
}

// The original path, unchanged in behaviour: Graph requires from.address to be
// the authenticated mailbox, so this is always the owner. The display name is
// a visual mask only.
async function sendAsOwner(message, displayName, saveToSentItems) {
  const ownerUpn = config.ownerUpn();
  const payload = {
    message: Object.assign({}, message, {
      from: { emailAddress: { name: displayName, address: ownerUpn } },
    }),
    saveToSentItems: saveToSentItems !== false,
  };
  const r = await graphFetch("/me/sendMail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok && r.status !== 202) {
    const txt = await r.text().catch(() => "");
    const e = new Error("Graph sendMail " + r.status);
    e.status = r.status;
    e.graphBody = txt.slice(0, 500);
    throw e;
  }
  return { sentAs: ownerUpn };
}

module.exports = { sendConfigured };
