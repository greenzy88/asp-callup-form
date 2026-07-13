/**
 * AUTH INVARIANTS — the deploy gate.
 *
 * These are the properties that, if any one of them is violated, sign-in breaks for the
 * client. They are asserted against index.html BEFORE the app can deploy, and against the
 * LIVE site by the canary AFTER it deploys.
 *
 * WHY THIS FILE EXISTS (2026-07-13):
 * Sign-in died in front of the client. Root cause: commit cdd8696 (2026-06-26) added an
 * unconditional on-load `handleRedirectPromise()`. Because redirectUri was the SPA itself,
 * the sign-in POPUP loaded a second copy of the app, and that copy CONSUMED AND CLEARED the
 * auth code from the URL ~25ms after it arrived — before the opener's 30ms poll could read
 * it. The opener never signed in; the popup sat on the signed-out screen. It was a RACE, so
 * it "worked" 25-40% of the time and hid for 17 days.
 *
 * It shipped because NOTHING in CI checked that a human can still log in. That is the hole
 * this file plugs. It is deliberately dumb, deterministic and dependency-free — a gate that
 * is itself flaky is worse than no gate.
 *
 * Run:  node test/auth_invariants.js [path-to-index.html]
 * Exit: 0 = all invariants hold, 1 = at least one is violated (deploy must not proceed).
 */
const fs = require("fs");
const path = require("path");

const target = process.argv[2] || path.join(__dirname, "..", "index.html");
// Normalise CRLF -> LF. index.html is committed with CRLF, and in JS regex `.` does NOT match
// \r, so a `//.*$` comment-stripper silently matches NOTHING on a CRLF file. That bug would
// have made this gate pass everything.
const src = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const ORIGIN = "https://delightful-bay-0e217b31e.7.azurestaticapps.net";
const failures = [];
const passes = [];

function check(name, ok, detail) {
  (ok ? passes : failures).push({ name, detail });
}

// Strip // line comments and /* */ blocks so a comment EXPLAINING the bug can never be
// mistaken for the bug itself. (The fix's own comments quote the old alert text verbatim.)
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

// ---------------------------------------------------------------------------
// 1. NO POPUP SIGN-IN. This is the bug. A popup redirect-target is the SPA itself, so the
//    popup re-runs the app and eats its own auth code. It will ALSO break outright when
//    Microsoft enforces COOP on login.microsoftonline.com (already report-only for our
//    client_id as of 2026-07-13) — window.opener gets severed and popup auth dies.
// ---------------------------------------------------------------------------
check(
  "sign-in does NOT use loginPopup()",
  !/msalInstance\s*\.\s*loginPopup\s*\(/.test(code),
  "Found msalInstance.loginPopup(...). Sign-in MUST be loginRedirect(). See the 2026-07-13 outage."
);
check(
  "sign-in DOES use loginRedirect()",
  /msalInstance\s*\.\s*loginRedirect\s*\(/.test(code),
  "No msalInstance.loginRedirect(...) found — how does the user sign in?"
);
check(
  "no acquireTokenPopup()",
  !/acquireTokenPopup\s*\(/.test(code),
  "acquireTokenPopup opens a popup whose redirect target is this SPA — same bug class."
);

// ---------------------------------------------------------------------------
// 2. handleRedirectPromise() MUST NOT RUN INSIDE A POPUP. Defense in depth: if anyone ever
//    reintroduces a popup, this guard stops it from destroying the auth code.
// ---------------------------------------------------------------------------
const hrp = /handleRedirectPromise\s*\(/.test(code);
const guarded =
  /window\.opener\s*&&\s*window\.opener\s*!==\s*window/.test(code) &&
  /!\s*_inPopup|_inPopup\s*===\s*false|!\s*isInPopup/.test(code);
check(
  "handleRedirectPromise() is guarded against running in a popup",
  !hrp || guarded,
  "handleRedirectPromise() is called but there is no `window.opener && window.opener !== window` " +
    "popup guard. THIS IS THE EXACT 2026-07-13 BUG: in a popup it clears the auth hash before " +
    "the opener can read it."
);

// ---------------------------------------------------------------------------
// 3. redirectUri MUST strip BOTH the query and the fragment. The old
//    `window.location.href.split('?')[0]` kept the '#...', so on a redirect RETURN the page
//    loads as ".../#code=..." and the computed redirect_uri became ".../#code=..." — which
//    matches no registered URI (AADSTS50011).
// ---------------------------------------------------------------------------
check(
  "redirectUri strips the fragment (origin + pathname)",
  /redirectUri\s*:\s*window\.location\.origin\s*\+\s*window\.location\.pathname/.test(code),
  "redirectUri must be `window.location.origin + window.location.pathname`. " +
    "href.split('?')[0] KEEPS the '#fragment' -> AADSTS50011 on the redirect path."
);

// ---------------------------------------------------------------------------
// 4. NEVER BLAME POP-UPS. The old catch-all alert fired for ANY unrecognised sign-in error
//    and told the user to allow pop-ups and switch to Safari/Chrome. It sent David into his
//    browser settings, in front of the client, for a problem that had nothing to do with
//    pop-ups. There is no pop-up any more; an error must say what actually failed.
// ---------------------------------------------------------------------------
check(
  "no 'allow pop-ups / use Safari or Chrome' alert",
  !/allow pop-?ups/i.test(code),
  "A pop-up-blocker alert is still reachable in CODE. Sign-in is a redirect — a pop-up nag " +
    "is now always a lie, and it misdirects the user."
);

// ---------------------------------------------------------------------------
// 5. PINNED, INTEGRITY-CHECKED CDN SCRIPTS. If MSAL could float, the app could break with no
//    deploy — which is precisely the failure mode we are defending against.
// ---------------------------------------------------------------------------
const scriptTags = src.match(/<script[^>]+src=["']https?:[^>]*>/g) || [];
const noSri = scriptTags.filter((t) => !/integrity=/.test(t));
check(
  "every external <script> has a Subresource Integrity hash",
  noSri.length === 0,
  `These external scripts have no integrity= attribute:\n    ${noSri.join("\n    ")}`
);
const floating = scriptTags.filter((t) => /@latest|\/latest\/|@\^|@~/.test(t));
check(
  "no floating CDN versions",
  floating.length === 0,
  `Floating CDN version (can change with no deploy):\n    ${floating.join("\n    ")}`
);

// ---------------------------------------------------------------------------
// 6. THE 404 TRAP. staticwebapp.config.json rewrites EVERY unknown path to the full SPA.
//    So a "blank" redirect page (e.g. /auth.html) would actually serve the whole app —
//    silently re-creating the bug. If anyone adds a redirect page, it must be a REAL file.
// ---------------------------------------------------------------------------
const swaPath = path.join(path.dirname(target), "staticwebapp.config.json");
if (fs.existsSync(swaPath)) {
  const swa = JSON.parse(fs.readFileSync(swaPath, "utf8"));
  const rewrites404 = swa?.responseOverrides?.["404"]?.rewrite === "/index.html";
  const usesBlankPage = /redirectUri\s*:\s*[^\n]*(blank|auth\.html|redirect\.html)/i.test(code);
  check(
    "no 'blank redirect page' that the 404 rule would turn back into the full SPA",
    !(rewrites404 && usesBlankPage),
    "index.html points redirectUri at a blank page, but staticwebapp.config.json rewrites 404 -> " +
      "/index.html. If that page does not physically exist, the SPA is served there anyway and " +
      "the popup bug comes straight back. Commit the real file."
  );
}

// ---------------------------------------------------------------------------
console.log(`\nAUTH INVARIANTS  (${path.basename(target)})\n${"=".repeat(60)}`);
passes.forEach((p) => console.log(`  PASS  ${p.name}`));
failures.forEach((f) => console.log(`  FAIL  ${f.name}\n        ${f.detail}`));
console.log(`${"=".repeat(60)}`);
console.log(`  ${passes.length} passed, ${failures.length} failed\n`);

if (failures.length) {
  console.error(
    "DEPLOY BLOCKED — a sign-in invariant is violated.\n" +
      "These are not style rules. Each one of them, on its own, broke sign-in for the client\n" +
      "on 2026-07-13. If you are certain, fix the invariant here in the same commit and say why.\n"
  );
  process.exit(1);
}
console.log("All sign-in invariants hold.\n");
