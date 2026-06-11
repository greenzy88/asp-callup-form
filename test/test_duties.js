// Test harness for dutiesListHtml — extracts the REAL functions from index.html
// (escHtml + dutiesListHtml) and runs them against a battery of inputs so we test
// the shipped source, not a copy. Run: node test/test_duties.js
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractFn(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  // brace-match from the first "{" after the signature
  let i = html.indexOf("{", start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return html.slice(start, end);
}

// eval the two functions into this scope
const src = extractFn("escHtml") + "\n" + extractFn("dutiesListHtml");
eval(src);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "\n        " + (detail || "")); }
}

// helper extractors over the produced HTML
const liTexts = (h) => (h.match(/<li>([\s\S]*?)<\/li>/g) || []).map(s => s.replace(/<\/?li>/g, ""));
const leadParas = (h) => (h.match(/<p style="margin:0 0 4px 0">([\s\S]*?)<\/p>/g) || [])
  .map(s => s.replace(/<p[^>]*>|<\/p>/g, ""));
const hasUl = (h) => /<ul/.test(h);

// ── Case 1: real Girls Take Flight duties (lead-in + 3 bullets via glyphs) ──
const gtf = "Providing crowd control, monitoring and wayfinding to attendees of Girls Take Flight event at the Airport as follows:\n" +
  "• 2 roaming security guards will monitor guest activity at the Island Traffic Turning Circle and will patrol between Stolport FBO and the Terminal Atrium entrance\n" +
  "• 2 roaming security guards will monitor guest activity and will patrol along Hangar Road, between Hangar 4A and Hangar 6\n" +
  "• 1 security guard will monitor guest activity at the North access door to Hangar 2";
{
  const h = dutiesListHtml(gtf);
  const li = liTexts(h), lead = leadParas(h);
  check("GTF: lead-in pulled to its own <p>", lead.length === 1 && /as follows:$/.test(lead[0]), JSON.stringify(lead));
  check("GTF: exactly 3 bullets (lead-in NOT bullet #1)", li.length === 3, JSON.stringify(li));
  check("GTF: first bullet is the first guard line", /^2 roaming/.test(li[0] || ""), li[0]);
  check("GTF: lead-in is NOT among bullets", !li.some(x => /as follows:/.test(x)), JSON.stringify(li));
}

// ── Case 2: no lead-in (bullets only) — must NOT fabricate a lead-in <p> ──
const noLead = "• Patrol the north gate\n• Check IDs at the door\n• Escort contractors";
{
  const h = dutiesListHtml(noLead);
  check("no-lead: zero lead-in <p>", leadParas(h).length === 0, h);
  check("no-lead: 3 bullets", liTexts(h).length === 3, JSON.stringify(liTexts(h)));
}

// ── Case 3: single plain sentence, no colon, no markers — one bullet, no lead-in ──
{
  const h = dutiesListHtml("Stand at the main entrance and check badges.");
  check("single-sentence: no lead-in <p>", leadParas(h).length === 0, h);
  check("single-sentence: 1 bullet", liTexts(h).length === 1, JSON.stringify(liTexts(h)));
}

// ── Case 4: lone colon-terminated sentence, NO following bullets — by DESIGN it
// stays a single bullet (lead-in extraction requires >=2 items, so we never leave
// a heading over an empty list). There's no "bullet #1" problem without a list. ──
{
  const h = dutiesListHtml("Duties are as follows:");
  check("lead-only: NOT extracted (stays single bullet, by design)", leadParas(h).length === 0, h);
  check("lead-only: exactly 1 bullet", liTexts(h).length === 1, JSON.stringify(liTexts(h)));
}

// ── Case 5: dash bullets with a colon lead-in (MPTF-style "-Word") ──
const dash = "Security coverage for the renovation as follows:\n" +
  "-The guard will monitor the construction entrance\n" +
  "-The guard will log all contractor entries\n" +
  "-The guard will maintain Hi-Visibility standards";
{
  const h = dutiesListHtml(dash);
  check("dash: lead-in pulled out", leadParas(h).length === 1, JSON.stringify(leadParas(h)));
  check("dash: 3 bullets", liTexts(h).length === 3, JSON.stringify(liTexts(h)));
  check("dash: hyphen in Hi-Visibility preserved (not split)", /Hi-Visibility/.test(h), h);
}

// ── Case 6: numbered list with lead-in ──
const numbered = "The contractor requires the following: 1. Monitor gate A 2. Monitor gate B 3. Log all vehicles";
{
  const h = dutiesListHtml(numbered);
  check("numbered: lead-in 'the following:' pulled out", leadParas(h).length === 1, JSON.stringify(leadParas(h)));
  check("numbered: 3 bullets", liTexts(h).length === 3, JSON.stringify(liTexts(h)));
}

// ── Case 7: empty / whitespace → empty string ──
check("empty: '' -> ''", dutiesListHtml("") === "", JSON.stringify(dutiesListHtml("")));
check("empty: '   ' -> ''", dutiesListHtml("   ") === "", JSON.stringify(dutiesListHtml("   ")));

// ── Case 8: lead-in with NO colon must stay as bullet #1 (don't over-trigger) ──
const noColon = "• General security duties\n• Patrol perimeter\n• Report incidents";
{
  const h = dutiesListHtml(noColon);
  check("no-colon-lead: no lead-in <p> (first line has no colon)", leadParas(h).length === 0, h);
  check("no-colon-lead: 3 bullets incl. the first", liTexts(h).length === 3, JSON.stringify(liTexts(h)));
}

// ── Case 9: HTML-injection safety — lead-in + bullets escaped ──
const evil = "Watch for <script>alert(1)</script> as follows:\n• Item A & B\n• Item \"quoted\"";
{
  const h = dutiesListHtml(evil);
  check("xss: no raw <script> in output", !/<script>/.test(h), h);
  check("xss: ampersand escaped in bullet", /Item A &amp; B/.test(h), h);
}

// ── Case 10: single paragraph, multiple sentences, lead-in colon then prose sentences ──
const para = "The guard duties for this event are as follows: Monitor the entrance. Check all badges. Escort visitors to the EOC.";
{
  const h = dutiesListHtml(para);
  check("para: lead-in pulled out", leadParas(h).length === 1 && /as follows:$/.test(leadParas(h)[0]), JSON.stringify(leadParas(h)));
  check("para: >=2 bullets from sentence split", liTexts(h).length >= 2, JSON.stringify(liTexts(h)));
}

// ── Case 11 (adversarial): lead-in echoes the "Duties:" heading label ──
{
  const h = dutiesListHtml("Duties:\n• Screen passengers\n• Monitor X-ray\n• Patrol concourse");
  check("heading-echo: no 'Duties:' lead-in <p> (heading already prints it)", leadParas(h).length === 0, h);
  // "Duties:" must not become a floating <p>; it stays a bullet (or is the heading only)
  check("heading-echo: no duplicate-heading <p>", !/<p style="margin:0 0 4px 0">Duties:<\/p>/.test(h), h);
}

// ── Case 12 (adversarial): stray leading colon from PDF extraction ──
{
  const h = dutiesListHtml("   :   • Screen all staff • Verify badge expiry • Check vehicle permits");
  check("orphan-colon: never emit a bare ':' lead-in <p>", !/<p style="margin:0 0 4px 0">:?\s*<\/p>/.test(h), h);
  check("orphan-colon: no lead-in <p> with no letters", leadParas(h).every(p => /[A-Za-z]/.test(p)), JSON.stringify(leadParas(h)));
}

// ── Case 13 (adversarial): lead-in + exactly ONE duty → stays inline, no heading-over-1-bullet ──
{
  const h = dutiesListHtml("Responsibilities: Maintain access control at the secure door.");
  check("single-duty: no lead-in <p> (would be heading over 1 bullet)", leadParas(h).length === 0, h);
}

// ── Case 14: lead-in + exactly TWO duties → DOES hoist (>=2 remain) ──
{
  const h = dutiesListHtml("Duties for the shift are as follows:\n• Patrol the perimeter\n• Log all entries");
  check("two-duty: lead-in IS hoisted", leadParas(h).length === 1 && /as follows:$/.test(leadParas(h)[0]), JSON.stringify(leadParas(h)));
  check("two-duty: 2 bullets remain", liTexts(h).length === 2, JSON.stringify(liTexts(h)));
}

// ── Case 15: a real lead-in containing the word "Duties" but NOT the bare label ──
{
  const h = dutiesListHtml("Duties at the north gate are as follows:\n• Check IDs\n• Log vehicles\n• Escort contractors");
  check("duties-in-leadin: real lead-in still hoisted (not the bare label)", leadParas(h).length === 1, JSON.stringify(leadParas(h)));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
