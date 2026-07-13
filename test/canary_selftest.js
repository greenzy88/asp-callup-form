/**
 * CANARY SELF-TEST — proves the canary actually CATCHES the 2026-07-13 outage.
 *
 * A guard that has never been shown to fire is not a guard. This serves the PRE-FIX
 * index.html (git 949d124 — the exact bytes that failed in front of the client) from
 * localhost, drives it with the same browser logic the canary uses, and asserts that the
 * canary's two live signals FIRE:
 *
 *    1. a POPUP WINDOW is opened   (page.on("popup"))
 *    2. the page does NOT itself navigate to Microsoft
 *
 * Plus the static gate must reject the same file.
 *
 * NO SIGN-IN: the popup goes to Entra and is closed immediately. Entra will reject the
 * localhost redirect_uri anyway; we only care that a popup was OPENED.
 *
 * Run: node test/canary_selftest.js
 */
const { chromium } = require("playwright");
const { execFileSync, execSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 8971;
const REPO = path.join(__dirname, "..");

(async () => {
  // The exact bytes that broke in front of the client.
  const broken = execSync("git show 949d124:index.html", { cwd: REPO, maxBuffer: 1 << 26 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-selftest-"));
  fs.writeFileSync(path.join(dir, "index.html"), broken);
  fs.writeFileSync(path.join(dir, "fixed.html"), fs.readFileSync(path.join(REPO, "index.html")));

  const srv = http
    .createServer((req, res) => {
      const f = req.url.startsWith("/fixed") ? "fixed.html" : "index.html";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(path.join(dir, f)));
    })
    .listen(PORT);

  const results = [];

  async function probe(url, label) {
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const popups = [];
    page.on("popup", (p) => popups.push(p));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator('button:has-text("Sign In with M365")').click();
    await page.waitForTimeout(4000);
    const selfNavigatedToMS = /login\.microsoftonline\.com/.test(page.url());
    // close any popup immediately — nothing is ever authenticated
    for (const p of popups) await p.close().catch(() => {});
    await browser.close();
    return { label, popupOpened: popups.length > 0, selfNavigatedToMS };
  }

  const brokenRun = await probe(`http://127.0.0.1:${PORT}/`, "PRE-FIX (949d124)");
  const fixedRun = await probe(`http://127.0.0.1:${PORT}/fixed`, "FIXED (HEAD)");
  srv.close();

  // Static gate must REJECT the broken file and ACCEPT the fixed one.
  const gate = (file) => {
    try {
      execFileSync("node", [path.join(__dirname, "auth_invariants.js"), file], { stdio: "pipe" });
      return "ACCEPTED";
    } catch {
      return "REJECTED";
    }
  };
  const gateBroken = gate(path.join(dir, "index.html"));
  const gateFixed = gate(path.join(REPO, "index.html"));

  console.log(`\nCANARY SELF-TEST — does the guard actually catch the outage?\n${"=".repeat(66)}`);
  console.log(`  PRE-FIX code (the bytes that failed in front of the client):`);
  console.log(`     popup window opened .......... ${brokenRun.popupOpened}   (canary FIRES on true)`);
  console.log(`     page itself went to Microsoft . ${brokenRun.selfNavigatedToMS}   (canary FIRES on false)`);
  console.log(`     static deploy gate ........... ${gateBroken}`);
  console.log(`  FIXED code (HEAD, now live):`);
  console.log(`     popup window opened .......... ${fixedRun.popupOpened}   (want false)`);
  console.log(`     page itself went to Microsoft . ${fixedRun.selfNavigatedToMS}   (want true)`);
  console.log(`     static deploy gate ........... ${gateFixed}`);
  console.log("=".repeat(66));

  results.push(["canary detects the popup in the pre-fix code", brokenRun.popupOpened === true]);
  results.push(["canary detects the missing redirect in the pre-fix code", brokenRun.selfNavigatedToMS === false]);
  results.push(["deploy gate REJECTS the pre-fix code", gateBroken === "REJECTED"]);
  results.push(["canary sees NO popup in the fixed code", fixedRun.popupOpened === false]);
  results.push(["canary sees the full-page redirect in the fixed code", fixedRun.selfNavigatedToMS === true]);
  results.push(["deploy gate ACCEPTS the fixed code", gateFixed === "ACCEPTED"]);

  results.forEach(([n, o]) => console.log(`  ${o ? "PASS" : "FAIL"}  ${n}`));
  const bad = results.filter(([, o]) => !o);
  if (bad.length) {
    console.error(`\n*** THE GUARD DOES NOT WORK — ${bad.length} self-test(s) failed. ***`);
    console.error("Do not trust it. A guard that cannot catch the bug it was written for is theatre.\n");
    process.exit(1);
  }
  console.log("\nThe guard fires on the real outage and stays quiet on the fix. It works.\n");
})().catch((e) => {
  console.error("SELF-TEST CRASHED:", e);
  process.exit(1);
});
