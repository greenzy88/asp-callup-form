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
| Permissions | Files.ReadWrite, Mail.Send | **Mail.Send only** |
| Used for | spreadsheet, PDFs, submitters | sending notification email |
| Stored at | table `OwnerTokens`, partition `owner` | table `OwnerTokens`, partition `sender` |
| MSAL client | `api/src/shared/msal.js` | `api/src/shared/notifyMailer.js` |
| Captured by | `/api/auth/setup` | `/api/auth/setup?as=notify` |

Different partitions, different MSAL instances, different token caches. Nothing
in the notification path can reach or corrupt the credential the app needs to
read the spreadsheet. The worst thing a failure here can do is send a
notification as David — which is where we started.

`api/src/shared/mailSend.js` is the single place that decides which one sends.

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

Takes effect within a minute, no deploy, no code change. Notifications go back
to being sent as David.

## Verifying without emailing the airport

Submitting a real call-up emails eight people at the Toronto Port Authority and
ASP. Don't test that way. Instead:

```bash
az staticwebapp appsettings set -n asp-callup-form -g asp-callup-form_group \
   --setting-names SELFTEST_KEY=<a long random string>

curl -s -X POST https://delightful-bay-0e217b31e.7.azurestaticapps.net/api/email-selftest \
     -H "X-Selftest-Key: <the same string>"

# then remove it again — with the setting gone the endpoint returns 404
az staticwebapp appsettings delete -n asp-callup-form -g asp-callup-form_group \
   --setting-names SELFTEST_KEY --yes
```

It sends one email, to `OWNER_UPN` and nobody else (the recipient is hardcoded;
there is no `to` parameter), through the same code path production uses. Check
the From address on what arrives.

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

Note that `ageDays` resets on every successful send, because the rotated refresh
token Microsoft hands back is persisted each time — the fix from the 2026-08-24
outage, carried into this path from the start rather than learned again.

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
