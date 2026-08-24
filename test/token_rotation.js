/**
 * TOKEN ROTATION — the invariant that keeps the app alive between setups.
 *
 * WHY THIS FILE EXISTS (2026-08-24):
 * The app went down in front of clients. AADSTS700082: "The token was issued on
 * 2026-05-26T02:51:42.4831598Z and was inactive for 90.00:00:00." Every
 * client-facing read proxies through ONE owner refresh token (msal.js header:
 * "everyone else's data ops use the owner's persisted refresh token"), so when
 * it died, every user lost orders in the same instant.
 *
 * It was not a Microsoft change and not a deploy. Microsoft hands back a NEW
 * refresh token every time you use one, and graph.js discarded it. tokenStore
 * .save() had exactly one caller — authCallback.js:95, the one-time setup — so
 * the stored bytes never changed after 2026-05-26 and Entra counted them
 * inactive to the day.
 *
 * TWO COMMENTS SAID IT WAS ALREADY HANDLED, and that is why nobody looked:
 *   msal.js      "Microsoft generally extends the refresh-token's lifetime on
 *                 each use, so active apps stay live without rotation."
 *   tokenStore.js "Tokens are stored opaque; rotated automatically on refresh."
 * Neither was implemented. A comment asserting behaviour nobody built is worse
 * than no comment: it answers the question before it is asked.
 *
 * These tests use fakes for MSAL and Table Storage — they assert the WIRING,
 * which is the part that was missing. They never touch Microsoft, never touch
 * the live storage account, and never sign anything in.
 *
 * Run:  node test/token_rotation.js
 * Exit: 0 = rotation is wired, 1 = a request would again throw the token away.
 */
const path = require("path");
const Module = require("module");

const failures = [];
const passes = [];
function check(name, ok, detail) {
  (ok ? passes : failures).push({ name, detail });
}

const SHARED = path.join(__dirname, "..", "api", "src", "shared");
const P = (n) => path.join(SHARED, n);

// --- a loader that swaps msal.js and tokenStore.js for fakes -----------------
// graph.js requires them by relative path, so intercepting Module._load is the
// smallest thing that works without a test framework. The repo's other gate is
// "deliberately dumb, deterministic and dependency-free" and this matches it.
function loadGraphWith(fakeMsal, fakeStore) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(SHARED)) delete require.cache[k];
  }
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename && parent.filename.startsWith(SHARED)) {
      if (request === "./msal") return fakeMsal;
      if (request === "./tokenStore") return fakeStore;
    }
    return realLoad.apply(this, arguments);
  };
  try {
    return require(P("graph.js"));
  } finally {
    Module._load = realLoad;
  }
}

function makeStore(initial) {
  const saved = [];
  return {
    saved,
    load: async () => initial,
    save: async (t, by) => { saved.push({ t, by }); },
    clear: async () => {},
  };
}

// --- CASE 1: a rotated token is PERSISTED ------------------------------------
// The whole outage in one assertion.
{
  const store = makeStore({ refreshToken: "OLD", capturedBy: "owner@x.com" });
  const graph = loadGraphWith({
    acquireFromRefresh: async () => ({
      result: { accessToken: "AT", expiresOn: new Date(Date.now() + 3600e3) },
      rotatedRefreshToken: "NEW",
    }),
  }, store);
  let err = null;
  // NOT the save itself. graph.js does not export getOwnerAccessToken, and the
  // only ways in are graphFetch (a real network call) or adding a test seam to
  // the auth path of an app clients are using today — the same trade the
  // 2026-07-13 outage came from. What this proves is that graph.js still
  // RESOLVES ./msal and ./tokenStore after the return-shape change, which is
  // the precondition for every source invariant below. The behaviour is
  // asserted there.
  if (!graph || typeof graph !== "object") err = "graph.js failed to load";
  if (store.saved.length !== 0) err = "harness recorded a save before any call";
  check(
    "graph.js still loads with msal and tokenStore swapped",
    !err,
    err || "ok"
  );
}

// --- Source-level invariants, which hold whether or not the module is
// --- exercisable. These are what the deploy gate can always assert.
const fs = require("fs");
const graphSrc = fs.readFileSync(P("graph.js"), "utf8");
const msalSrc = fs.readFileSync(P("msal.js"), "utf8");

check(
  "graph.js PERSISTS the rotated refresh token",
  /rotatedRefreshToken/.test(graphSrc) && /tokenStore\.save\(/.test(graphSrc),
  "graph.js must call tokenStore.save() with the rotated token; before " +
    "2026-08-24 save() had a single caller in authCallback.js and the " +
    "credential never changed after setup"
);

check(
  "msal.acquireFromRefresh RETURNS the rotated refresh token",
  /rotatedRefreshToken/.test(msalSrc) && /getTokenCache\(\)/.test(msalSrc),
  "MSAL-node keeps the rotated token in its cache, not on the response — " +
    "authCallback.js already reads it that way to capture the first one"
);

check(
  "a storage failure cannot break a good access token",
  /catch\s*\(_saveErr\)/.test(graphSrc),
  "a missed save costs the old token's remaining life; a THROWN save costs " +
    "the user their orders, and this app has one credential for every user"
);

check(
  "the rotated token is only saved when it actually CHANGED",
  /!==\s*refreshToken/.test(msalSrc),
  "reporting identical bytes back would write storage on every request and " +
    "hide a broken rotation behind constant churn"
);

check(
  "the retired assumption is recorded, not silently deleted",
  /90\.00:00:00|AADSTS700082/.test(msalSrc),
  "the comment that caused this said Microsoft 'generally extends the " +
    "refresh-token's lifetime on each use' — the next reader needs to know " +
    "it was tested and false, or they will write it again"
);

// --- CREDENTIAL FRESHNESS, the detection half -------------------------------
// Rotation stops the decay; this is what makes a REGRESSION in the rotation
// visible weeks early instead of at the moment a client loses their orders.
const statusSrc = fs.readFileSync(
  path.join(__dirname, "..", "api", "src", "functions", "authStatus.js"),
  "utf8"
);

check(
  "auth/status reports the credential's AGE",
  /ageDays/.test(statusSrc),
  "before 2026-08-24 the endpoint returned ready/capturedBy/capturedAt and " +
    "nothing computed from them, so a 90-day-old token and a fresh one " +
    "rendered identically"
);

check(
  "auth/status warns BEFORE Entra's 90-day window closes",
  /WARN_AT_DAYS/.test(statusSrc) && /MAX_INACTIVE_DAYS/.test(statusSrc),
  "a threshold equal to the expiry alarms at the moment of the outage, " +
    "which is not a warning"
);

check(
  "an UNKNOWN age never renders as fine",
  /ageDays === null \? null :/.test(statusSrc),
  "the 90 days passed unremarked precisely because absence of a signal read " +
    "as absence of a problem"
);

check(
  "the freshness check requires no sign-in",
  !/loginRedirect|acquireToken|signIn/i.test(statusSrc),
  "David: 'don't sign in too much, I don't want you raising alarm bells' — " +
    "the timestamp already sits in tokenStore, so nothing needs authenticating"
);

// --- report ------------------------------------------------------------------
for (const p of passes) console.log(`  ok    ${p.name}`);
for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.detail}`);
console.log(
  `\n  ${passes.length} passed, ${failures.length} failed`
);
process.exit(failures.length ? 1 : 0);
