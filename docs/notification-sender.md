# Who call-up notifications come from

**Short version:** notifications leave as `atraining@security-asp.com`, not as
David. Switching that on or off is one app setting. No code push either way.

---

## Why this changed (2026-09-06)

Every call-up notification used to be sent as `dramlagan@security-asp.com`. Not
just the display name — the actual mailbox. The backend holds one credential,
David's, and Microsoft Graph will not let `/me/sendMail` claim a From address
other than the mailbox it authenticated as.

That tied the airport's notifications to one person's account. If that account
were ever disabled, every notification the BBTCA contract depends on would stop.

They now come from `atraining@security-asp.com` — the shared account BBTCA staff
already sign into the form with, and which outlives any one employee.

## What did NOT change

- **The spreadsheet and the `ASP-CallUp` folder stay on David's personal
  OneDrive**, read and written with David's credential exactly as before.
- **The post-order PDF attached to a notification is still fetched from David's
  OneDrive** with David's credential. Only the envelope moved.
- Recipients, the distribution matrix, the gates that trigger each email, the
  display name (`ASP Call-Up Notifications (Do Not Reply)`), sign-in, and every
  other behaviour are untouched. `index.html` was not modified.

Replies to a notification now land in the `atraining@` mailbox rather than
David's, and a copy of each notification is saved in that mailbox's Sent Items
(David 2026-09-06).

## How it works

Two credentials, deliberately kept apart:

| | Owner credential | Notification-sender credential |
|---|---|---|
| Account | `dramlagan@security-asp.com` | `atraining@security-asp.com` |
| Permissions | Files.ReadWrite, Mail.Send | Mail.Send **by use** (see note) |
| Used for | spreadsheet, PDFs, submitters | sending notification email |
| Stored at | table `OwnerTokens`, partition `owner` | table `OwnerTokens`, partition `sender` |
| MSAL client | `api/src/shared/msal.js` | `api/src/shared/notifyMailer.js` |
| Captured by | `/api/auth/setup` | `/api/auth/setup?as=notify` |

Different partitions, different MSAL instances, different token caches. Nothing
in the notification path can reach or corrupt the credential the app needs to
read the spreadsheet. The worst thing a failure here can do is send a
notification as David — which is where we started.

`api/src/shared/mailSend.js` is the single place that decides which one sends.

**Note on the sender's permissions:** the app only ever calls `sendMail` with
that credential, but the token it gets back carries every scope `atraining@` has
consented to for this app — which already included `Files.ReadWrite` before it
was used as a sender (confirmed 2026-09-06). It is Mail.Send-only by use, not by
grant. Genuinely narrowing it would need a separate app registration.

## App settings

| Setting | Default | Meaning |
|---|---|---|
| `NOTIFY_SENDER_MODE` | *(unset)* = `owner` | `notify` switches the From address to the shared account. This is the on/off switch. |
| `NOTIFY_SENDER_UPN` | `atraining@security-asp.com` | Which mailbox sends. |
| `NOTIFY_FALLBACK_TO_OWNER` | `1` | If the shared account's credential fails, send as David rather than drop the notification. Set `0` to fail hard instead. |
| `SELFTEST_KEY` | *(unset)* = endpoint disabled | Enables `POST /api/email-selftest`. Set it to verify, then delete it. |

## Turning it on

```bash
# 1. Capture the credential — open in a browser, sign in AS atraining@:
#    https://delightful-bay-0e217b31e.7.azurestaticapps.net/api/auth/setup?as=notify
#    A wrong account is rejected with a 403 and changes nothing.

# 2. Flip the switch:
az staticwebapp appsettings set -n asp-callup-form -g asp-callup-form_group \
   --setting-names NOTIFY_SENDER_MODE=notify
```

## Turning it off (rollback)

```bash
az staticwebapp appsettings set -n asp-callup-form -g asp-callup-form_group \
   --setting-names NOTIFY_SENDER_MODE=owner
```

No deploy, no code change. Notifications go back to being sent as David.

**It is not instant.** Measured during the 2026-09-06 rollout: an app-setting
change reaches the running instances one at a time and took **~2 minutes** to
converge. During the changeover some sends still use the old value. That is
harmless in both directions — a send that still thinks it is in `notify` mode
uses a credential that still works, and a send that has not yet learned about a
new `NOTIFY_SENDER_UPN` falls back to the owner and still delivers. Poll
`/api/auth/status` until every response agrees before assuming a change is
fully live; a single agreeing response is not enough, because the next request
may land on a different instance.

## Verifying without emailing the airport

Submitting a real call-up emails eight people at the Toronto Port Authority and
ASP. Don't test that way. Instead:

```bash
az staticwebapp appsettings set -n asp-callup-form -g asp-callup-form_group \
   --setting-names SELFTEST_KEY=<a long random string>

curl -s -X POST https://delightful-bay-0e217b31e.7.azurestaticapps.net/api/email-selftest \
     -H "X-Selftest-Key: <the same string>"

# ...and with the post-order PDF, which is what real "new"/"completed" sends do:
curl -s -X POST https://delightful-bay-0e217b31e.7.azurestaticapps.net/api/email-selftest \
     -H "X-Selftest-Key: <the same string>" \
     -H "Content-Type: application/json" -d '{"attach":true}'

# then remove it again — with the setting gone the endpoint returns 404.
# NOTE: there is no --yes flag on this command.
az staticwebapp appsettings delete -n asp-callup-form -g asp-callup-form_group \
   --setting-names SELFTEST_KEY
```

It sends one email, to `OWNER_UPN` and nobody else (the recipient is hardcoded;
there is no `to` parameter), through the same code path production uses. Check
the From address on what arrives.

Removing the key also takes a couple of minutes to reach every instance —
confirm the endpoint really is 404 on several consecutive calls before
considering it gone.

## When it breaks

The shared account's password will be changed one day. That revokes the stored
credential, and Entra also kills it after 90 days of complete inactivity.

**What you will see:** notifications keep arriving, but from David again.
Nothing is lost — that is `NOTIFY_FALLBACK_TO_OWNER` doing its job — and a
`mailSend: notify sender ... FAILED` error is logged for every send.

**How to check:** open `/api/auth/status` and look at the `notify` block.

```jsonc
"notify": {
  "mode": "notify",
  "ready": true,               // false => never captured, or the row is gone
  "capturedBy": "atraining@security-asp.com",
  "identityMatches": true,     // false => captured account != NOTIFY_SENDER_UPN
  "ageDays": 3.2,
  "stale": false,              // true at 60 days: re-capture within 30
  "expiresInDays": 86.8        // null means UNKNOWN, never "fine"
}
```

**How to fix:** re-run `/api/auth/setup?as=notify` and sign in as the shared
account again. Nothing else needs doing; the switch stays as it was.

`ageDays` is *designed* to reset on every successful send: Microsoft hands back
a rotated refresh token and `notifyMailer.getAccessToken()` persists it — the
2026-08-24 fix, carried into this path from the start rather than learned again.

**It does not work. Measured 2026-09-06 — see `token-rotation-finding.md`.**
Entra returns a rotated refresh token on every refresh, for both credentials, and
the app discards every one of them: the MSAL cache the code reads is empty. The
owner credential dies ~2026-11-22 unless that is fixed, and this one 90 days
after its own capture. The paragraph below is what led to the measurement.

**Do not assume it is working.** On 2026-09-06 the OWNER credential's
`capturedAt` had not moved in 13 days of constant use, even though commit
`2b9043f` added exactly that persistence to `graph.js`. If rotation is not in
fact persisting, the owner credential dies around **2026-11-22** — 90 days from
its issue date, the same way it died on 2026-08-24 — and this one would follow
90 days after its own capture. Treat that as an open question rather than a
known-good mechanism: watch `ageDays` on both credentials, and read a value that
keeps climbing as the alarm it was built to be.

## The better long-term answer

This still depends on a password on a shared account. The version that never
needs a re-login is an **application permission**: `Mail.Send` granted to the
app itself, with an Exchange `ApplicationAccessPolicy` restricting it to the
`atraining@` mailbox only, so the app cannot send as anyone else in the company.

That needs a Global Administrator (David is not one — as of 2026-09-06 the
admins are PParkinson, NThompson, RAzevedo, NoahThompsonAdmin and Jolera) plus
Exchange Online PowerShell. It is a ticket, not a config change. If it is ever
done, only `mailSend.js` and `notifyMailer.js` need to change; nothing else in
the app knows or cares which credential sent the mail.

## Tests

`node test/notify_sender_test.js` — 15 offline checks, wired into the deploy
gate. They assert the two properties that matter: a deploy alone changes
nothing, and a broken sender still delivers the notification.

The gate is DEPENDENCY-FREE and must stay that way: the runner checks out the
repo and runs `node` with no install step, because `api/node_modules` is
gitignored and a root `package.json` would change what Oryx deploys. Tests that
load the real `tokenStore.js` / `notifyMailer.js` intercept `@azure/data-tables`
and `@azure/msal-node` at the module loader for that reason. Verify any change
to them against a `git archive` checkout with no `node_modules`, not just a dev
machine — otherwise the gate passes locally and blocks the deploy on CI.

## What was verified live on 2026-09-06

Against the deployed app, with a self-test that mails only the owner:

| Check | Result |
| --- | --- |
| Deploy with no settings set | owner status byte-identical, `notify.mode: owner`, self-test endpoint 404 |
| Credential capture as the shared account | `identityMatches: true`, owner credential untouched |
| Send after the switch | `sentAs: atraining@security-asp.com`, no fallback |
| Send **with a post-order PDF** — read from the owner's OneDrive on the owner's credential, sent from the other mailbox | worked; this is what real "new"/"completed" notifications do |
| Fallback, forced by pointing `NOTIFY_SENDER_UPN` at a mailbox with no credential | refused to send as the wrong mailbox, fell back to the owner, **still delivered**, reported `NOTIFY_IDENTITY_MISMATCH` |
| Writing app settings on the live SWA | merges; all 8 pre-existing values byte-identical afterwards (checked by hash) |
| Removing `SELFTEST_KEY` | endpoint returns 404 again on every instance, even with the correct key |
