/**
 * NOTIFICATION ROUTING — invariants.  node test/notification_routing_test.js
 *
 * WHY THIS FILE EXISTS (2026-09-06)
 * Pat Deal was receiving every new-order notification twice: once addressed to
 * him, and once via YTZShiftManagers@security-asp.com, a distribution list he
 * belongs to. Farhad and Prince were in the same position. The fix removes them
 * from the baskets that already carry "ytz" and leaves them on the ones that do
 * not (completed / edit-Completed, where there is no duplicate to remove and
 * dropping them would have silently cost them completion notices).
 *
 * That fix is one word in a list. It regresses the moment somebody re-adds a
 * name "so Pat definitely gets it", which is exactly how the duplicate arose.
 * So the shape is pinned here rather than left to memory.
 *
 * The routing block is READ OUT OF index.html and evaluated, so these assertions
 * are made against the code that actually ships, not a copy of it that can drift.
 * Offline, dependency-free, no network — it runs on the deploy gate.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const target = process.argv[2] || path.join(__dirname, "..", "index.html");
const src = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

// Lift the routing block out of the SPA. Bounded by two stable markers; if either
// moves, this fails loudly rather than silently testing nothing.
const START = "const NOTIFICATION_ROUTING_ENABLED";
const END = "// Display names used in the user badge";
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error(
    "\nCould not locate the notification-routing block in " + path.basename(target) + ".\n" +
    "Markers expected:\n  start: " + START + "\n  end:   " + END + "\n" +
    "If the code moved, update these markers — do NOT delete the test.\n"
  );
  process.exit(1);
}
const sandbox = {};
vm.createContext(sandbox);
// `const`/`let` at the top level of a vm script are lexical bindings — unlike
// `function` declarations they never become properties of the context object.
// So the block is followed by an export statement evaluated in the SAME scope,
// which can see them. (Reading them off the sandbox instead yields undefined,
// and assertions against undefined pass for the wrong reason.)
const EXPORT = "\n;globalThis.__routing = { RECIPIENTS, ACTIVE_RECIPIENTS, YTZ_DL_MEMBERS," +
  " recipientKeysFor, notifyTargets, ADMIN_RECIPIENT, NOTIFICATION_ROUTING_ENABLED," +
  " cancelNotifyTargets, CANCEL_NOTIFY_LIVE, CANCEL_ALWAYS_KEYS };\n";
vm.runInContext(src.slice(from, to) + EXPORT, sandbox, { filename: "index.html#routing" });

const {
  RECIPIENTS, ACTIVE_RECIPIENTS, YTZ_DL_MEMBERS,
  recipientKeysFor, notifyTargets, ADMIN_RECIPIENT,
  NOTIFICATION_ROUTING_ENABLED,
  cancelNotifyTargets, CANCEL_ALWAYS_KEYS,
} = sandbox.__routing;

// The cancellation invariants must hold in BOTH gate states, so the same block is
// evaluated again with CANCEL_NOTIFY_LIVE forced true. Without this, "YTZ always
// gets cancellations" would quietly stop being true the moment the third-party
// distribution is switched on - its Scheduled basket contains no "ytz".
const blockSrc = src.slice(from, to);
const liveSrc = blockSrc.replace("const CANCEL_NOTIFY_LIVE = false;", "const CANCEL_NOTIFY_LIVE = true;");
if (liveSrc === blockSrc) {
  console.error("\nCould not force CANCEL_NOTIFY_LIVE true - the declaration moved. Fix the test, not the app.\n");
  process.exit(1);
}
const liveSandbox = {};
vm.createContext(liveSandbox);
vm.runInContext(liveSrc + EXPORT, liveSandbox, { filename: "index.html#routing(live)" });
const LIVE = liveSandbox.__routing;

// Guard against the extraction silently yielding nothing: an assertion made
// against undefined is not a passing test, it is an absent one.
for (const [name, val] of Object.entries(sandbox.__routing)) {
  if (val === undefined) {
    console.error("\nExtraction failed: '" + name + "' is undefined. Fix the test, not the app.\n");
    process.exit(1);
  }
}

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (e) {
    failures.push(name);
    console.log("  FAIL  " + name + "\n        " + e.message);
  }
}

// Every basket in the matrix: (event, status-at-event) pair that can occur.
const BASKETS = [
  ["new", "Pending"],
  ["scheduled", "Scheduled"],
  ["completed", "Completed"],
  ["edit", "Pending"],
  ["edit", "Scheduled"],
  ["edit", "Completed"],
  ["cancelled", "Pending"],
  ["cancelled", "Scheduled"],
];
const label = (e, s) => e + "/" + s;

console.log("\nNOTIFICATION ROUTING\n" + "=".repeat(64));

// ── THE DUPLICATE THIS FIXED ────────────────────────────────────────────────
check("nobody on the YTZ distribution list is ALSO addressed directly", () => {
  assert.ok(Array.isArray(YTZ_DL_MEMBERS) && YTZ_DL_MEMBERS.length,
    "YTZ_DL_MEMBERS is missing — who is on the DL is what makes a duplicate a duplicate");
  for (const [e, s] of BASKETS) {
    const keys = recipientKeysFor(e, s);
    if (!keys.includes("ytz")) continue;
    // Compare LENGTH, not the array. Values built inside the vm carry that
    // context's Array.prototype, so deepStrictEqual against a host-realm []
    // fails on the prototype check even when both are empty.
    const dupes = keys.filter((k) => YTZ_DL_MEMBERS.includes(k));
    assert.strictEqual(dupes.length, 0,
      label(e, s) + " sends to ytz AND to " + dupes.join(", ") +
      " — each of them gets the mail twice. They are on YTZShiftManagers@; " +
      "reaching them through it is the whole point.");
  }
});

check("Pat is not directly addressed on any basket that carries ytz", () => {
  assert.strictEqual(RECIPIENTS.pat, "pdeal@security-asp.com", "the 'pat' key must still be Pat");
  for (const [e, s] of BASKETS) {
    const keys = recipientKeysFor(e, s);
    if (keys.includes("ytz")) {
      assert.ok(!keys.includes("pat"), label(e, s) + " addresses Pat directly as well as via ytz");
    }
  }
});

// ── THE COVERAGE IT MUST NOT COST ───────────────────────────────────────────
// completed / edit-Completed have no ytz on them, so removing these three there
// would not have removed a duplicate — it would have removed the notification.
check("Farhad, Prince and Pat still receive Completed and edit-Completed", () => {
  for (const basket of [["completed", "Completed"], ["edit", "Completed"]]) {
    const keys = recipientKeysFor(basket[0], basket[1]);
    assert.ok(!keys.includes("ytz"),
      label(basket[0], basket[1]) + " has gained ytz — re-check the de-duplication, " +
      "these three are listed directly here precisely because it did not.");
    for (const k of YTZ_DL_MEMBERS) {
      assert.ok(keys.includes(k),
        label(basket[0], basket[1]) + " no longer includes '" + k + "'. There is no ytz " +
        "on this basket, so this is lost coverage, not a removed duplicate.");
    }
  }
});

check("every basket still reaches the two TPA leads and Airport Planning", () => {
  for (const [e, s] of BASKETS) {
    const keys = recipientKeysFor(e, s);
    for (const k of ["denise", "chad", "ap"]) {
      assert.ok(keys.includes(k), label(e, s) + " dropped '" + k + "'");
    }
  }
});

// ── GENERAL SANITY ──────────────────────────────────────────────────────────
check("no basket names a recipient key that has no address", () => {
  for (const [e, s] of BASKETS) {
    for (const k of recipientKeysFor(e, s)) {
      assert.ok(RECIPIENTS[k] || k === "admin",
        label(e, s) + " names '" + k + "', which is not in RECIPIENTS. A typo here " +
        "does not error — it silently drops that person from the gate.");
    }
  }
});

check("no send list contains the same address twice", () => {
  for (const [e, s] of BASKETS) {
    const addrs = notifyTargets(e, s).map((t) => String(t.to).toLowerCase());
    assert.strictEqual(new Set(addrs).size, addrs.length,
      label(e, s) + " would send twice to: " +
      addrs.filter((a, i) => addrs.indexOf(a) !== i).join(", "));
  }
});

check("David is copied on every basket", () => {
  for (const [e, s] of BASKETS) {
    const addrs = notifyTargets(e, s).map((t) => String(t.to).toLowerCase());
    assert.ok(addrs.includes(String(ADMIN_RECIPIENT).toLowerCase()),
      label(e, s) + " does not copy the admin");
  }
});

check("Duty Managers are never a recipient, on any basket", () => {
  const all = JSON.stringify(RECIPIENTS).toLowerCase();
  assert.ok(!all.includes("dutymanagers"),
    "dutymanagers@torontoportauthority.com is permanently excluded (David 2026-06-16 / 2026-06-26)");
  for (const [e, s] of BASKETS) {
    for (const t of notifyTargets(e, s)) {
      assert.ok(!String(t.to).toLowerCase().includes("dutymanagers"), label(e, s) + " reaches Duty Managers");
    }
  }
});

check("Holly is app-access-only and never a notification recipient", () => {
  const all = JSON.stringify(RECIPIENTS).toLowerCase();
  assert.ok(!all.includes("holly") && !all.includes("hbrown") && !all.includes("hmoore"),
    "Holly has APP ACCESS ONLY (David 2026-06-26) — she must not be in RECIPIENTS");
});

check("the PDF rides along on new + completed only", () => {
  const attached = (e, s) => notifyTargets(e, s, "TPO-2026-001.pdf").some((t) => t.attach);
  assert.ok(attached("new", "Pending"), "a new order must carry its post order");
  assert.ok(attached("completed", "Completed"), "a completion must carry the post order");
  assert.ok(!attached("edit", "Pending"), "edits must not attach");
  assert.ok(!attached("scheduled", "Scheduled"), "scheduling must not attach");
});

check("every key used by a basket is in ACTIVE_RECIPIENTS", () => {
  for (const [e, s] of BASKETS) {
    for (const k of recipientKeysFor(e, s)) {
      assert.ok(ACTIVE_RECIPIENTS.has(k),
        label(e, s) + " names '" + k + "' but it is not active, so it is filtered out and " +
        "that person is silently not notified.");
    }
  }
});

// -- CANCELLATIONS REACH YTZ SHIFT MANAGERS (David 2026-09-10) ---------------
// "make sure YTZ Shift managers are on the cancellation emails like I am."
// They were getting none: CANCEL_NOTIFY_LIVE has been false since the Cancel
// feature shipped, so every cancellation went to David alone.
const CANCEL_STATUSES = ["Pending", "Scheduled"];
const addrs = (list) => list.map((t) => String(t.to).toLowerCase());

check("YTZ Shift Managers are notified on every cancellation", () => {
  for (const s of CANCEL_STATUSES) {
    assert.ok(addrs(cancelNotifyTargets(s)).includes(String(RECIPIENTS.ytz).toLowerCase()),
      "cancelled/" + s + " does not reach YTZShiftManagers@");
  }
});

check("YTZ stays on cancellations if CANCEL_NOTIFY_LIVE is flipped true", () => {
  for (const s of CANCEL_STATUSES) {
    assert.ok(addrs(LIVE.cancelNotifyTargets(s)).includes(String(LIVE.RECIPIENTS.ytz).toLowerCase()),
      "cancelled/" + s + " loses YTZ once the TPA distribution is on. The Scheduled " +
      "basket has no 'ytz', so this must come from CANCEL_ALWAYS_KEYS, not recipientKeysFor.");
  }
});

check("David is notified on every cancellation, in both gate states", () => {
  const admin = String(ADMIN_RECIPIENT).toLowerCase();
  for (const s of CANCEL_STATUSES) {
    assert.ok(addrs(cancelNotifyTargets(s)).includes(admin), "gate off, cancelled/" + s);
    assert.ok(addrs(LIVE.cancelNotifyTargets(s)).includes(admin), "gate on, cancelled/" + s);
  }
});

check("cancellation targets contain no duplicate addresses", () => {
  for (const s of CANCEL_STATUSES) {
    for (const pair of [["gate off", cancelNotifyTargets], ["gate on", LIVE.cancelNotifyTargets]]) {
      const to = addrs(pair[1](s));
      assert.strictEqual(to.length, new Set(to).size, pair[0] + ", cancelled/" + s + " emails somebody twice");
    }
  }
});

check("Denise and Chad are notified on every cancellation, in both gate states", () => {
  for (const k of ["denise", "chad"]) {
    const a = String(RECIPIENTS[k]).toLowerCase();
    for (const s of CANCEL_STATUSES) {
      assert.ok(addrs(cancelNotifyTargets(s)).includes(a),
        k + " (" + a + ") is missing from cancelled/" + s + " - David added them 2026-09-11");
      assert.ok(addrs(LIVE.cancelNotifyTargets(s)).includes(a),
        k + " is missing from cancelled/" + s + " once the gate is on");
    }
  }
});

check("every CANCEL_ALWAYS_KEYS key is active and has an address", () => {
  assert.ok(Array.isArray(CANCEL_ALWAYS_KEYS) && CANCEL_ALWAYS_KEYS.length,
    "CANCEL_ALWAYS_KEYS is empty - cancellations would go to David alone again");
  for (const k of CANCEL_ALWAYS_KEYS) {
    assert.ok(RECIPIENTS[k], "CANCEL_ALWAYS_KEYS names '" + k + "' which has no address");
    assert.ok(ACTIVE_RECIPIENTS.has(k),
      "CANCEL_ALWAYS_KEYS names '" + k + "' but it is not in ACTIVE_RECIPIENTS");
  }
});

check("cancellation recipients are exactly David + CANCEL_ALWAYS_KEYS while the gate is off", () => {
  const allowed = new Set([String(ADMIN_RECIPIENT).toLowerCase()]);
  for (const k of CANCEL_ALWAYS_KEYS) allowed.add(String(RECIPIENTS[k]).toLowerCase());
  for (const s of CANCEL_STATUSES) {
    for (const a of addrs(cancelNotifyTargets(s))) {
      assert.ok(allowed.has(a),
        "cancelled/" + s + " emails " + a + ", who is neither David nor in CANCEL_ALWAYS_KEYS");
    }
  }
});

check("Airport Planning is NOT emailed on cancellation while the gate is off", () => {
  const ap = String(RECIPIENTS.ap).toLowerCase();
  for (const s of CANCEL_STATUSES) {
    assert.ok(!addrs(cancelNotifyTargets(s)).includes(ap),
      "cancelled/" + s + " emails Airport Planning (" + ap + "). David named Denise and Chad, " +
      "not Airport Planning - adding it is his call, not a side effect.");
  }
});

check("cancellations never attach the post-order PDF", () => {
  for (const s of CANCEL_STATUSES) {
    for (const t of cancelNotifyTargets(s)) assert.strictEqual(t.attach, null, "cancelled/" + s + " attached");
    for (const t of LIVE.cancelNotifyTargets(s)) assert.strictEqual(t.attach, null, "cancelled/" + s + " attached (gate on)");
  }
});

console.log("=".repeat(64));
console.log("  " + pass + " passed, " + failures.length + " failed\n");
if (failures.length) {
  console.error(
    "NOTIFICATION ROUTING IS WRONG — deploy must not proceed.\n" +
    "These encode decisions David made about who hears about a call-up, and when.\n" +
    "If a change here is deliberate, change the assertion in the same commit and say why.\n"
  );
  process.exit(1);
}
console.log("Routing invariants hold.\n");
