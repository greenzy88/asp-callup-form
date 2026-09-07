/**
 * NOTIFICATION SENDER — behaviour tests.  node test/notify_sender_test.js
 *
 * The change under test moves the From address on call-up notifications off
 * David's personal mailbox and onto the shared atraining@ account. The app is
 * live at an airport, so the property that matters most is not "the new mode
 * works" — it is "NOTHING CHANGES until somebody deliberately changes it, and
 * a broken new sender never costs anyone a notification."
 *
 * Everything here runs offline. Graph and the notification identity are stubbed
 * through require.cache, so no token, no network and no mailbox is involved.
 */
const path = require("path");
const assert = require("assert");
const Module = require("module");

// THE GATE IS DEPENDENCY-FREE ON PURPOSE. api/node_modules is gitignored — a
// package.json at the repo root would make Azure's Oryx builder think this is a
// Node app and BUILD it, changing what gets deployed (see .gitignore). So the
// CI runner has no @azure/* packages, and a test that requires one fails there
// while passing locally. The modules under test pull in two of them, so we
// intercept those two ids at the loader. Nothing else is faked: the code being
// tested is the real code.
const FAKE_MODULES = {
  "@azure/msal-node": {
    ConfidentialClientApplication: class {
      constructor(cfg) { this.config = cfg; }
      getTokenCache() { return { serialize: async () => "{}" }; }
      async getAuthCodeUrl() { throw new Error("not exercised offline"); }
      async acquireTokenByCode() { throw new Error("not exercised offline"); }
      async acquireTokenByRefreshToken() { throw new Error("not exercised offline"); }
    },
  },
  "@azure/data-tables": {
    TableClient: { fromConnectionString: () => { throw new Error("not exercised offline"); } },
  },
};
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(FAKE_MODULES, request)) {
    return FAKE_MODULES[request];
  }
  return _origLoad.apply(this, arguments);
};

const SHARED = path.join(__dirname, "..", "api", "src", "shared");
const P = (m) => require.resolve(path.join(SHARED, m));

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (e) {
    failures.push({ name, detail: e.message });
    console.log("  FAIL  " + name + "\n        " + e.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (e) {
    failures.push({ name, detail: e.message });
    console.log("  FAIL  " + name + "\n        " + e.message);
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

const graphSends = [];
const notifySends = [];
let notifyThrows = null;

function install() {
  // Drop anything already loaded so each scenario gets fresh module state.
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(SHARED)) delete require.cache[k];
  }
  require.cache[P("graph.js")] = {
    id: P("graph.js"),
    filename: P("graph.js"),
    loaded: true,
    exports: {
      graphFetch: async (url, init) => {
        graphSends.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 202, text: async () => "" };
      },
    },
  };
  require.cache[P("notifyMailer.js")] = {
    id: P("notifyMailer.js"),
    filename: P("notifyMailer.js"),
    loaded: true,
    exports: {
      sendMail: async (message, saveToSentItems) => {
        if (notifyThrows) throw notifyThrows;
        notifySends.push({ message, saveToSentItems });
        return true;
      },
    },
  };
  return require(path.join(SHARED, "mailSend.js"));
}

function env(overrides) {
  for (const k of ["NOTIFY_SENDER_MODE", "NOTIFY_SENDER_UPN", "NOTIFY_FALLBACK_TO_OWNER",
                   "SENDER_DISPLAY_NAME", "SELFTEST_KEY"]) {
    delete process.env[k];
  }
  process.env.OWNER_UPN = "dramlagan@security-asp.com";
  Object.assign(process.env, overrides || {});
}

function reset() {
  graphSends.length = 0;
  notifySends.length = 0;
  notifyThrows = null;
}

const MESSAGE = {
  subject: "Call Up Request Completed: 1234 - Test",
  body: { contentType: "HTML", content: "<p>hi</p>" },
  toRecipients: [{ emailAddress: { address: "droy@torontoportauthority.com" } }],
};

const ctx = { warn: () => {}, error: () => {} };

console.log("\nNOTIFICATION SENDER\n" + "=".repeat(64));

// ── 1. THE DEPLOY MUST BE A NO-OP ───────────────────────────────────────────
// With no new app settings present, this must behave byte-for-byte like the
// version that is live right now: one /me/sendMail on the owner's token, From
// = the owner, display-name mask intact, saveToSentItems true.
(async () => {
  await checkAsync("no settings set => sends as the owner, exactly as before", async () => {
    env(); reset();
    const { sendConfigured } = install();
    const res = await sendConfigured(ctx, MESSAGE);
    assert.strictEqual(notifySends.length, 0, "must not touch the notify identity");
    assert.strictEqual(graphSends.length, 1, "expected exactly one Graph send");
    const sent = graphSends[0];
    assert.strictEqual(sent.url, "/me/sendMail");
    assert.strictEqual(sent.body.message.from.emailAddress.address, "dramlagan@security-asp.com");
    assert.strictEqual(
      sent.body.message.from.emailAddress.name,
      "ASP Call-Up Notifications (Do Not Reply)"
    );
    assert.strictEqual(sent.body.saveToSentItems, true);
    assert.deepStrictEqual(sent.body.message.toRecipients, MESSAGE.toRecipients);
    assert.strictEqual(sent.body.message.subject, MESSAGE.subject);
    assert.strictEqual(res.sentAs, "dramlagan@security-asp.com");
    assert.strictEqual(res.mode, "owner");
    assert.strictEqual(res.fellBack, false);
  });

  await checkAsync("an unrecognised NOTIFY_SENDER_MODE value falls to owner, not to a guess", async () => {
    env({ NOTIFY_SENDER_MODE: "atraining" }); reset();
    const { sendConfigured } = install();
    const res = await sendConfigured(ctx, MESSAGE);
    assert.strictEqual(res.mode, "owner");
    assert.strictEqual(notifySends.length, 0);
    assert.strictEqual(graphSends.length, 1);
  });

  // ── 2. THE SWITCH ─────────────────────────────────────────────────────────
  await checkAsync("mode=notify => sends as atraining, owner token untouched", async () => {
    env({ NOTIFY_SENDER_MODE: "notify" }); reset();
    const { sendConfigured } = install();
    const res = await sendConfigured(ctx, MESSAGE);
    assert.strictEqual(graphSends.length, 0, "the owner's mailbox must not be used at all");
    assert.strictEqual(notifySends.length, 1);
    const m = notifySends[0].message;
    assert.strictEqual(m.from.emailAddress.address, "atraining@security-asp.com");
    assert.strictEqual(m.from.emailAddress.name, "ASP Call-Up Notifications (Do Not Reply)");
    assert.strictEqual(notifySends[0].saveToSentItems, true, "sent copies are kept (David 2026-09-06)");
    assert.strictEqual(res.sentAs, "atraining@security-asp.com");
    assert.strictEqual(res.fellBack, false);
  });

  await checkAsync("the message body/subject/recipients are identical in both modes", async () => {
    env(); reset();
    let s = install();
    await s.sendConfigured(ctx, MESSAGE);
    const ownerMsg = graphSends[0].body.message;
    env({ NOTIFY_SENDER_MODE: "notify" }); reset();
    s = install();
    await s.sendConfigured(ctx, MESSAGE);
    const notifyMsg = notifySends[0].message;
    const strip = (m) => { const c = Object.assign({}, m); delete c.from; return c; };
    assert.deepStrictEqual(strip(ownerMsg), strip(notifyMsg),
      "only the From address may differ between the two modes");
  });

  await checkAsync("NOTIFY_SENDER_UPN can be repointed without a code change", async () => {
    env({ NOTIFY_SENDER_MODE: "notify", NOTIFY_SENDER_UPN: "Orders@Security-ASP.com" }); reset();
    const { sendConfigured } = install();
    const res = await sendConfigured(ctx, MESSAGE);
    assert.strictEqual(res.sentAs, "orders@security-asp.com", "must be normalised to lower case");
  });

  // ── 3. NOBODY LOSES A NOTIFICATION ────────────────────────────────────────
  // The shared account's password will be changed one day. When that happens
  // the notification must still go out.
  await checkAsync("notify sender broken => falls back to the owner and still delivers", async () => {
    env({ NOTIFY_SENDER_MODE: "notify" }); reset();
    const { sendConfigured } = install();
    notifyThrows = Object.assign(new Error("invalid_grant: token revoked"), { code: "NOTIFY_REFRESH_FAILED" });
    const res = await sendConfigured(ctx, MESSAGE);
    assert.strictEqual(graphSends.length, 1, "the notification must still have gone out");
    assert.strictEqual(graphSends[0].body.message.from.emailAddress.address, "dramlagan@security-asp.com");
    assert.strictEqual(res.fellBack, true);
    assert.strictEqual(res.sentAs, "dramlagan@security-asp.com");
    assert.ok(/token revoked/.test(res.notifyError), "the reason must be reported, not swallowed");
  });

  await checkAsync("the fallback is loud — it logs an error, never silent", async () => {
    env({ NOTIFY_SENDER_MODE: "notify" }); reset();
    const { sendConfigured } = install();
    notifyThrows = new Error("boom");
    const logged = [];
    await sendConfigured({ warn: () => {}, error: (...a) => logged.push(a.join(" ")) }, MESSAGE);
    assert.ok(logged.length > 0, "a fallback with no log is how this rots unnoticed");
    assert.ok(/FAILED/.test(logged.join(" ")));
  });

  await checkAsync("NOTIFY_FALLBACK_TO_OWNER=0 makes a broken sender fail hard instead", async () => {
    env({ NOTIFY_SENDER_MODE: "notify", NOTIFY_FALLBACK_TO_OWNER: "0" }); reset();
    const { sendConfigured } = install();
    notifyThrows = new Error("boom");
    await assert.rejects(() => sendConfigured(ctx, MESSAGE));
    assert.strictEqual(graphSends.length, 0, "hard-fail mode must NOT quietly send as the owner");
  });

  // ── 4. STORAGE SEPARATION ─────────────────────────────────────────────────
  // The owner's credential is what keeps the app alive. The new row must be
  // unable to collide with it.
  check("the two credentials live in different table partitions", () => {
    delete require.cache[P("tokenStore.js")];
    const ts = require(path.join(SHARED, "tokenStore.js"));
    assert.deepStrictEqual(ts.OWNER_KEY, { partitionKey: "owner", rowKey: "owner" },
      "the owner row must not move — it is the live credential");
    assert.notStrictEqual(ts.NOTIFY_KEY.partitionKey, ts.OWNER_KEY.partitionKey);
    assert.ok(typeof ts.load === "function" && typeof ts.save === "function" &&
              typeof ts.clear === "function", "the original owner API must still exist");
    assert.ok(typeof ts.loadNotify === "function" && typeof ts.saveNotify === "function");
  });

  // ── 5. THE SELF-TEST ENDPOINT IS OFF BY DEFAULT ───────────────────────────
  check("the self-test endpoint does not exist unless SELFTEST_KEY is set", () => {
    env();
    delete require.cache[P("config.js")];
    const cfg = require(path.join(SHARED, "config.js"));
    assert.strictEqual(cfg.selftestKey(), "", "unset must mean disabled, not a default key");
  });

  check("notify defaults are the safe ones", () => {
    env();
    delete require.cache[P("config.js")];
    const cfg = require(path.join(SHARED, "config.js"));
    assert.strictEqual(cfg.notifySenderMode(), "owner", "the default must be today's behaviour");
    assert.strictEqual(cfg.notifyFallbackToOwner(), true, "fallback on by default");
    assert.strictEqual(cfg.notifySenderUpn(), "atraining@security-asp.com");
  });

  // ── 6. THE WRONG-MAILBOX GUARD ────────────────────────────────────────────
  // notifyMailer refuses to use a stored credential that belongs to an account
  // other than the one configured. Without this, editing NOTIFY_SENDER_UPN
  // would silently keep sending from whatever was captured last.
  function withStubbedTokenStore(row) {
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(SHARED)) delete require.cache[k];
    }
    require.cache[P("tokenStore.js")] = {
      id: P("tokenStore.js"),
      filename: P("tokenStore.js"),
      loaded: true,
      exports: {
        loadNotify: async () => row,
        saveNotify: async () => {},
        OWNER_KEY: { partitionKey: "owner", rowKey: "owner" },
        NOTIFY_KEY: { partitionKey: "sender", rowKey: "notify" },
      },
    };
    return require(path.join(SHARED, "notifyMailer.js"));
  }

  await checkAsync("no captured credential => a clear 'run setup' error, not a crash", async () => {
    env({ NOTIFY_SENDER_MODE: "notify", AAD_CLIENT_ID: "id", AAD_CLIENT_SECRET: "sec",
          AAD_TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const nm = withStubbedTokenStore(null);
    await assert.rejects(() => nm.getAccessToken(), (e) => {
      assert.strictEqual(e.code, "NOTIFY_NOT_AUTHED");
      assert.strictEqual(e.status, 503);
      assert.ok(/auth\/setup\?as=notify/.test(e.message), "must say how to fix it");
      return true;
    });
  });

  await checkAsync("a credential for the wrong mailbox is refused, not used", async () => {
    env({ NOTIFY_SENDER_MODE: "notify", NOTIFY_SENDER_UPN: "atraining@security-asp.com",
          AAD_CLIENT_ID: "id", AAD_CLIENT_SECRET: "sec",
          AAD_TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const nm = withStubbedTokenStore({
      refreshToken: "rt", capturedBy: "someone.else@security-asp.com",
      capturedAt: new Date().toISOString(),
    });
    await assert.rejects(() => nm.getAccessToken(), (e) => {
      assert.strictEqual(e.code, "NOTIFY_IDENTITY_MISMATCH");
      return true;
    });
  });

  await checkAsync("status() reports freshness so the credential cannot decay unseen", async () => {
    env({ NOTIFY_SENDER_MODE: "notify", AAD_CLIENT_ID: "id", AAD_CLIENT_SECRET: "sec",
          AAD_TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const old = new Date(Date.now() - 70 * 86400000).toISOString();
    const nm = withStubbedTokenStore({ refreshToken: "rt", capturedBy: "atraining@security-asp.com", capturedAt: old });
    const st = await nm.status();
    assert.strictEqual(st.ready, true);
    assert.strictEqual(st.identityMatches, true);
    assert.strictEqual(st.stale, true, "70 days old must read as stale (warn at 60, dead at 90)");
    assert.ok(st.expiresInDays > 19 && st.expiresInDays < 21);
  });

  await checkAsync("an unknown-age credential never reads as healthy", async () => {
    env({ AAD_CLIENT_ID: "id", AAD_CLIENT_SECRET: "sec",
          AAD_TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const nm = withStubbedTokenStore(null);
    const st = await nm.status();
    assert.strictEqual(st.ready, false);
    assert.strictEqual(st.stale, null, "unknown must be null, never false");
  });

  console.log("=".repeat(64));
  console.log("  " + pass + " passed, " + failures.length + " failed\n");
  if (failures.length) process.exit(1);
})();
