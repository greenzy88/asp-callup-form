/**
 * LIVE SIGN-IN CANARY — runs on a schedule against the DEPLOYED site.
 *
 * IT NEVER SIGNS IN. No credentials, no token, no MFA, no sign-in event, nothing that could
 * look like a compromised account. It drives a real browser up to the point where Microsoft
 * would ask for a password, verifies everything on OUR side of that boundary, and aborts.
 *
 * WHY A CANARY AND NOT JUST THE DEPLOY GATE:
 * The 2026-07-13 outage shipped with NO deploy. The last deploy was 2026-07-06 and the live
 * bytes never changed — the bug was a latent race that simply started losing. A deploy gate
 * cannot see that. Things that can break this app with nobody touching it:
 *   - a pinned CDN library silently changing under its version tag
 *   - the Entra app registration being edited by someone else in the tenant
 *   - Microsoft enforcing COOP on login.microsoftonline.com (already report-only for our
 *     client_id — it would kill popup auth outright, which is one reason we no longer use it)
 *   - an Azure Static Web Apps platform change
 * The canary is what notices. A failing scheduled run emails the repo owner automatically.
 *
 * WHAT IT ASSERTS (all without authenticating):
 *   1. The live site is up and still serves code satisfying every auth invariant.
 *   2. Clicking "Sign In with M365" opens NO popup window and calls window.open ZERO times.
 *   3. It shows NO alert() — in particular, never a pop-up-blocker nag.
 *   4. The page itself navigates to a WELL-FORMED Entra /authorize URL: the right tenant, the
 *      right client_id, response_type=code, response_mode=fragment, PKCE S256, and a
 *      redirect_uri exactly matching what is registered.
 *   5. The pinned CDN scripts still match their Subresource Integrity hashes.
 *
 * Run:  node test/canary_live.js
 * Exit: 0 = sign-in is healthy, 1 = SOMETHING IS BROKEN FOR THE CLIENT.
 */
const { chromium } = require("playwright");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ORIGIN = "https://delightful-bay-0e217b31e.7.azurestaticapps.net";
const TENANT = "0dff3239-8d56-4fa4-bbb2-f6ce4401cfaf";
const CLIENT_ID = "47a13aa4-d214-4987-a6c8-472cc0161f67";

const failures = [];
const notes = [];
const ok = (m) => notes.push(`  PASS  ${m}`);
const bad = (m) => {
  failures.push(m);
  notes.push(`  FAIL  ${m}`);
};

(async () => {
  // -------------------------------------------------------------------------
  // 1. The LIVE bytes must satisfy the same auth invariants as the repo.
  //    This also catches "deployed != repo" drift, which no gate can see.
  // -------------------------------------------------------------------------
  const res = await fetch(ORIGIN + "/", { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) {
    bad(`live site returned HTTP ${res.status}`);
  } else {
    ok(`live site is up (HTTP ${res.status})`);
  }
  const html = await res.text();
  const tmp = path.join(require("os").tmpdir(), "canary_live_index.html");
  fs.writeFileSync(tmp, html);
  try {
    execFileSync("node", [path.join(__dirname, "auth_invariants.js"), tmp], { stdio: "pipe" });
    ok("LIVE bytes satisfy every auth invariant");
  } catch (e) {
    bad(
      "LIVE bytes VIOLATE an auth invariant:\n" +
        String(e.stdout || e.message)
          .split("\n")
          .filter((l) => /FAIL/.test(l))
          .join("\n")
    );
  }

  // -------------------------------------------------------------------------
  // 2. The pinned CDN scripts must still hash to their integrity= values.
  //    A library changing under a pinned tag breaks the app with no deploy.
  // -------------------------------------------------------------------------
  const tags = html.match(/<script[^>]+src=["'](https?:[^"']+)["'][^>]*>/g) || [];
  for (const tag of tags) {
    const src = tag.match(/src=["']([^"']+)["']/)[1];
    const integ = (tag.match(/integrity=["']sha384-([^"']+)["']/) || [])[1];
    if (!integ) {
      bad(`external script has no SRI hash: ${src}`);
      continue;
    }
    const body = Buffer.from(await (await fetch(src)).arrayBuffer());
    const actual = crypto.createHash("sha384").update(body).digest("base64");
    if (actual === integ) {
      ok(`CDN pin intact: ${src.split("/").slice(-1)[0]}`);
    } else {
      bad(
        `CDN FILE CHANGED UNDER ITS PINNED VERSION: ${src}\n` +
          `        expected sha384-${integ}\n        got      sha384-${actual}\n` +
          `        (the browser will now REFUSE to load it — the app is broken)`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Drive a real browser. NO SIGN-IN.
  // -------------------------------------------------------------------------
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const popups = [];
  const dialogs = [];
  const page = await ctx.newPage();
  // page.on("popup") — NOT ctx.on("page"). ctx.on("page") also fires for the main page we
  // just created ourselves (about:blank), which made this canary report a phantom popup on a
  // perfectly healthy site. A canary that cries wolf gets ignored, and then it protects nothing.
  page.on("popup", (p) => popups.push(p.url()));
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.addInitScript(() => {
    window.__opened = [];
    const _o = window.open;
    window.open = function () {
      window.__opened.push(String(arguments[0] || "about:blank"));
      return _o.apply(window, arguments);
    };
  });

  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
  const btn = page.locator('button:has-text("Sign In with M365")');
  if ((await btn.count()) === 0) {
    bad('the "Sign In with M365" button is not on the page');
  } else {
    ok('"Sign In with M365" button is present');
    const openedBefore = await page.evaluate(() => (window.__opened || []).length);
    await Promise.all([
      page.waitForURL(/login\.microsoftonline\.com/, { timeout: 30000 }).catch(() => {}),
      btn.click(),
    ]);
    await page.waitForTimeout(2500);

    const url = page.url();

    // (a) NO popup — this is THE regression. A popup here re-loads the SPA, which eats its
    //     own auth code (2026-07-13), and will also die when Microsoft enforces COOP.
    if (popups.length === 0) ok("no popup window was opened (full-page redirect)");
    else bad(`A POPUP WINDOW WAS OPENED (${popups.length}): ${popups.join(", ")} — this is the 2026-07-13 bug`);

    const openedAfter = await page
      .evaluate(() => (window.__opened || []).length)
      .catch(() => openedBefore); // we navigated away; that itself proves a full-page redirect
    if (openedAfter === openedBefore) ok("window.open() was never called");
    else bad(`window.open() was called ${openedAfter - openedBefore} time(s)`);

    // (b) NO alert — especially never a pop-up-blocker nag.
    if (dialogs.length === 0) ok("no alert() dialog was shown");
    else bad(`an alert() was shown to the user: ${JSON.stringify(dialogs)}`);

    // (c) The page ITSELF went to a well-formed Entra authorize URL.
    if (!/^https:\/\/login\.microsoftonline\.com\//.test(url)) {
      bad(`clicking Sign In did NOT take the page to Microsoft. It is at: ${url}`);
    } else {
      ok("the page itself navigated to Microsoft (a redirect, not a popup)");
      const u = new URL(url);
      const q = u.searchParams;
      const expect = {
        client_id: CLIENT_ID,
        response_type: "code",
        response_mode: "fragment",
        code_challenge_method: "S256",
        redirect_uri: ORIGIN + "/",
      };
      if (!u.pathname.startsWith(`/${TENANT}/`))
        bad(`authorize URL is not pinned to the ASP tenant: ${u.pathname}`);
      else ok("authorize URL is pinned to the ASP tenant");

      for (const [k, v] of Object.entries(expect)) {
        if (q.get(k) === v) ok(`authorize ${k}=${v}`);
        else bad(`authorize ${k} is "${q.get(k)}", expected "${v}"`);
      }
      if (q.get("code_challenge")) ok("PKCE code_challenge present");
      else bad("no PKCE code_challenge — the token exchange will be rejected");
    }
  }

  // ABORT before Microsoft authenticates anything. No sign-in is ever recorded.
  await page.goto("about:blank").catch(() => {});
  await browser.close();

  // -------------------------------------------------------------------------
  console.log(`\nLIVE SIGN-IN CANARY  ${new Date().toISOString()}\n${"=".repeat(64)}`);
  notes.forEach((n) => console.log(n));
  console.log("=".repeat(64));
  if (failures.length) {
    console.error(
      `\n*** SIGN-IN IS BROKEN OR AT RISK FOR THE CLIENT — ${failures.length} check(s) failed ***\n` +
        `The BBTCA Call-Up app is client-facing. Investigate before the client hits it.\n` +
        `Runbook: test/auth_invariants.js documents each invariant and why it exists.\n`
    );
    process.exit(1);
  }
  console.log("\nSign-in is healthy. (No sign-in was performed.)\n");
})().catch((e) => {
  console.error("CANARY ITSELF CRASHED:", e);
  process.exit(1);
});
