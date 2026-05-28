# Multi-User Identity & Auto-Revocation — Proposal (2026-05-27)

**Status:** Drafted, Council-reviewed, **awaiting David's decision**.
**Saved here so David can re-read tomorrow before deciding.**

---

## The problem

BBTCA wants 8 client-side users (3 in one team + 5 in another department)
to use this app. Today they all share `atraining@security-asp.com` for
M365 sign-in. That produces three issues:

1. **No identity** — every submission shows "Client" in audit, history, notification emails. David can't tell Alice from Bob.
2. **No revocation** — when someone leaves BBTCA, David won't be told, so he can't manually remove them from a whitelist. The shared password remains, the departed person can still use it from their personal laptop.
3. **No accountability** — if a malicious submission lands, David can't trace which BBTCA user did it.

## Tenant constraints (already verified, can't change)

- ❌ External sharing LOCKED at tenant level → can't B2B-invite BBTCA users as guests
- ❌ David is Application Administrator, NOT User Administrator → can't create new M365 user accounts
- ❌ Conditional Access policies are IT-only → can't tune MFA/sign-in policies per user
- ❌ No budget for paid services (Azure AD B2C, Power Automate Premium)

## Five propositions evaluated

| PRP | Description | Verdict |
|---|---|---|
| **PRP1** | **Two-layer: Submitter Identity dialog + BBTCA-email magic-link verification (90-day TTL) + server-side token validation middleware** | **RECOMMENDED** |
| PRP2 | Identity tracking only, no auto-revocation | Skip — useless against the actual problem |
| PRP3 | Monthly email to designated BBTCA lead for re-attestation | Viable cheap fallback, human-dependent |
| PRP4 | Azure AD B2C separate directory | Significant rework, costs (small but non-zero) |
| PRP5 | Status quo + better activity log | Skip — doesn't solve any of the 3 problems |

## How PRP1 works (recommended path)

### Layer A — Submitter Identity (UI-side, no auth change)

After M365 sign-in, the SPA shows a "Who are you?" dialog:
- Dropdown of David-maintained BBTCA submitter list (8 names initially)
- OR free-text "Other" → flagged for David's review queue
- Selection persists in `localStorage`
- Every order row, history entry, notification email records the selected submitter (display name + their BBTCA email)
- Owner-only admin panel: "Manage Submitters" (add/remove names + emails). Stored as a new tab in `CallUpForm_Data.xlsx`.

### Layer B — BBTCA-Email Magic-Link Verification (auto-revocation)

First-time selection of a BBTCA email:
1. SPA POSTs `/api/auth/issue-link` → backend issues a signed token (HMAC, 90-day TTL), emails the user a one-time link via Graph sendMail
2. User clicks link → backend validates token + flips status to `active` in Submitters sheet
3. SPA stores `submitter_token` in localStorage
4. Every backend write (`ordersAdd`, `orderUpdate`, `pdfUpload`, `email`, `markCompleted`) requires the token via a new `requireSubmitterToken(req)` middleware
5. Middleware extracts token from request header, HMAC-verifies signature, checks revocation in the Submitters sheet (60s cache), rejects if expired/revoked

When the 90-day token expires: SPA re-prompts → email re-sent → if the user has left BBTCA their mailbox is dead → they can't click the link → access auto-revokes.

## Council 3-round review findings (2026-05-27, $0.05)

5 reviewers (deepseek, minimax, qwen, gemini, gpt4omini), all grounding in real file paths. Unanimous on the most important point: **server-side token validation middleware is the difference between this working and it being cosmetic security**. Without it, anyone who lifts the localStorage token bypasses the entire scheme.

### Attack vectors the Council surfaced

1. **localStorage token theft / replay** — needs cryptographic signing + server-side revocation check
2. **Magic-link forwarding** — a verified user could forward their one-time link to a colleague → bind token to IP/device fingerprint at first verification
3. **Ghost M365 session persistence** — even with submitter_token revoked, shared `atraining@` M365 cookie persists → both layers must be gated together
4. **Revocation propagation gap** — without single source of truth read on every request, a "revoked" token can linger in caches → `Submitters` sheet in OneDrive as live truth, 60s TTL read cache

### Council telemetry note

`diversity=0.00, discount_factor=0.50` — all 5 reviewers converged on the same critique angle (missing middleware). Real signal, low methodological independence. Weight their structural recommendation high (the middleware gap is real) and their attack-vector enumeration medium.

## Implementation plan (~5 hours total)

| # | Step | Estimate |
|---|---|---|
| 1 | SPA Submitter Identity dialog + localStorage cache + email field | ~1 hr |
| 2 | Backend `Submitters` sheet in OneDrive Excel (`email, token_hash, issued_at, expires_at, status, last_verified_ip, last_activity_ts`) | ~30 min |
| 3 | `/api/auth/issue-link` anonymous endpoint that emails verification link via `/api/email` plumbing | ~30 min |
| 4 | `/api/auth/verify-link?token=…` validates + flips token active in Submitters sheet | ~30 min |
| 5 | `requireSubmitterToken(req)` middleware in `api/src/shared/auth.js` — extract from header, HMAC-verify, check revocation (60s cache), reject expired/revoked | ~1 hr |
| 6 | Wire middleware into `ordersAdd.js`, `orderUpdate.js`, `pdfUpload.js`, `email.js`, `markCompleted` path | ~30 min |
| 7 | Admin "Manage Submitters" panel — view list, last activity, manually revoke | ~1 hr |

## Residual risks David accepts if PRP1 ships

- **Shared `atraining@` password remains.** If leaked, the M365 cookie alone won't get past the submitter_token gate, but Conditional Access tightening would be ideal (IT-controlled, blocked).
- **Token leak from an active, verified user's laptop** — same as any compromised session; mitigated by the 90-day re-verify cycle + admin manual-revoke.

## Files to reference when picking this up

- Codebase grounding:
  - `index.html` — MSAL config at line 282, role arrays at line 236-245
  - `api/src/shared/roles.js` — current canEdit / canManageStatus
  - `api/src/shared/auth.js` — `requireUser(req)` (this is where `requireSubmitterToken` lives)
  - `api/src/functions/email.js` — Graph sendMail to arbitrary recipients
  - `api/src/shared/graph.js` — `readSheet` / `writeSheet` for OneDrive Excel
- Prior memory:
  - `project_bbtca_callup_pause_2026_05_22.md` — original handoff state
  - `project_asp_callup_form_r7_override.md` — R7 override (this repo is Claude-Code-owned, no Godbot routing)

## Next decision David needs to make

**Three options when revisiting:**

1. **Build all 7 steps in one ~5-hour push** — most coherent, ships a complete posture
2. **Build Layer A first (steps 1-2, ~1.5 hrs)** — get identity tracking live immediately, defer magic-link verification to phase 2
3. **Defer entirely until BBTCA confirms the 8-user list + their email domain** (likely `@torontoport.com` or `@billybishopairport.com`) — saves potentially wasted work if domain assumption is wrong

Council transcript saved at `scripts/_drafts/council_bbtca_multi_user_identity_2026_05_27_1779937109.json` in the Godbot3 repo (not this one — Council tooling lives there).
