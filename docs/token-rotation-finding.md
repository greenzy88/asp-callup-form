# The refresh token has never rotated

**Status: CONFIRMED, NOT FIXED. Measured 2026-09-06 against the live app.**

**If nothing changes, the owner credential dies on or about 2026-11-22T19:11 UTC**
and every client loses orders at the same moment, exactly as on 2026-08-24.

---

## What was measured

Both stored credentials were refreshed and the results inspected
(`GET /api/token-diag`, read-only, nothing saved):

| | Owner | Notification sender |
|---|---|---|
| Refresh succeeds | yes | yes |
| Response carries an `id_token` / account | yes | yes |
| **Entra returns a refresh token** | **yes** | **yes** |
| **That token differs from the stored one** | **yes** | **yes** |
| Refresh tokens in the serialized MSAL cache | **0** | **0** |
| Access tokens / accounts in that cache | **0 / 0** | **0 / 0** |
| What our code concludes | `rotatedTokenFound: false` | same |

So Entra rotates on **every** refresh. The app receives a brand-new refresh
token many times a day, and discards every one of them, because the place it
looks — `getTokenCache().serialize()` — is empty. Not "missing the refresh
token": empty of everything, access tokens and accounts included.

`capturedAt` is therefore still the moment of the last interactive sign-in:
`2026-08-24T19:11:15Z` for the owner, after 13 days of constant use. The
notification credential, captured at 01:56 on 2026-09-07 and used for seven
sends within the hour, was likewise unchanged.

## Why the 2026-08-24 fix did not work

`2b9043f` correctly diagnosed the outage and correctly decided to persist the
rotated token. Its one wrong assumption was *where to find it*: the technique
was copied from `authCallback.js`, where reading the MSAL cache genuinely does
work — that is the auth-code flow, and the cache is populated there.

`acquireTokenByRefreshToken` does not populate it. So `msal.acquireFromRefresh`
searches an empty object, finds nothing, reports `rotatedRefreshToken: null`,
and `graph.js` — whose persistence logic is correct — is simply never asked to
save anything.

Two things were ruled out first, from the library source, before any live call:
MSAL *does* cache refresh tokens returned in a response (`ResponseHandler`), and
it *does* add `offline_access` to refresh requests automatically
(`RefreshTokenClient` → `addScopes` with `addOidcScopes = true`). Neither is the
problem. `test/token_rotation.js` passes 10/10 because it asserts the *wiring*
against a fake MSAL that behaves as assumed — it cannot see that the real
library does not behave that way.

This is the same failure shape as the outage itself: a mechanism believed to be
working, never measured. It survived a fix, a test suite and a code review.

## The fix, not yet applied

Stop reading the MSAL cache. Take the refresh token from the token response
itself — a plain OAuth2 `refresh_token` grant against
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, which is what
the probe used and what returned a rotated token every time.

Recommended shape:

1. Refresh via the token endpoint directly; persist `refresh_token` from the
   response before returning the access token.
2. Keep the **previous** refresh token in storage as a fallback, and retry with
   it once on `invalid_grant`. Entra keeps the prior token briefly valid, so
   this survives the race where two Function instances refresh at once and the
   last write wins.
3. Fall back to today's MSAL path on any unexpected failure, so the worst case
   is current behaviour.
4. Ship it behind a setting defaulting to today's behaviour, flip it, and
   confirm `capturedAt` starts moving — the check this whole finding is built on.

Do **not** consider it fixed until `ageDays` has been observed resetting on the
live app. That is the only evidence that counts here; a green test suite has
already proved insufficient once.

## An unrelated correction

The refresh response shows the notification credential's granted scopes as
`openid profile email Files.ReadWrite Mail.Send User.Read` — not `Mail.Send`
alone. `atraining@` had already consented to `Files.ReadWrite` for this app
before it was ever used as a sender, and a refresh returns everything the user
has consented to, regardless of what we ask for.

The app only ever calls `sendMail` with it, but the token is capable of reading
that mailbox's OneDrive. Anywhere the docs say the sender credential is
"Mail.Send only", read that as *"Mail.Send only by use, not by grant"*.
Narrowing it for real would mean a separate app registration.
