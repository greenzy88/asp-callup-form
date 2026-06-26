/* Adversarial regression test — the breakers surfaced by the 2026-06-25
 * multi-agent fuzz workflow. Confirms the high-value fixes (glyph variants,
 * numGuards label spectrum, date ranges, time seconds/spaced-colon) and that
 * NO field ever returns "See PDF" or empty when data is present.
 */
const fs = require("fs");
const path = require("path");
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) { const c = src[i];
    if (c === "{") depth++; else if (c === "}") { if (--depth === 0) { end = i + 1; break; } } }
  return src.slice(start, end);
}
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const parseFields = eval("(" + extractFn(html, "parseFields") + ")");
const DEF = {
  event: "Aurora Drone Light Festival", sd: "04 March 2026", ed: "04 March 2026",
  dayGlyphs: "☐Sun ☐Mon ☐Tue ☐Wed ☐Thu ☐Fri ☒Sat", st: "1900", et: "2330",
  covGlyphs: "☒Continuous ☐Specific Hours", guardsLabel: "Number of Escorts/Guards:", guards: "4",
  loc: "West Apron Viewing Lawn (Gate 3 muster)", contact: "Marcus Bellweather", phone: "(416) 555-0142",
  ppeGlyphs: "☐ RAIC ☐ AVOP D ☐ AVOP DA ☒ Radio ☒ Hi-Visibility Vest ☒ Safety Footwear ☐ Hard Hat ☐ Eye Protection ☐ Hearing Protection ☐ Other ____________",
  duties: "Securing the site as follows: • 2 guards on the fence line • 1 guard roaming the gate",
};
function makeText(o = {}) {
  const d = Object.assign({}, DEF, o);
  return `TEMPORARY POST ORDER Page 1 of 2 Event/Project: ${d.event} Start Date: ${d.sd} End Date: ${d.ed} Days Required: ${d.dayGlyphs} Start Time: ${d.st} End Time: ${d.et} Coverage: ${d.covGlyphs} ${d.guardsLabel} ${d.guards} Meeting Location: ${d.loc} Site Contact: ${d.contact} Contact Number: ${d.phone} PPE / Equipment Requirements: ${d.ppeGlyphs} Post Details 1.0 Post Description and Assigned Duties ${d.duties} 2.0 Site Drawing TEMPORARY POST ORDER Page 2 of 2`;
}
const SEEPDF = (v) => v == null || /see pdf/i.test(String(v));
let pass = 0, fail = 0; const fails = [];
function t(name, got, ok) { if (SEEPDF(got) || !ok(got)) { fail++; fails.push({ name, got: String(got) }); } else pass++; }

// --- numGuards label spectrum (uses raw header text so guard label is custom) ---
function gtext(headerGuards) {
  // build text with the guard label/value replaced by a raw header fragment
  const d = Object.assign({}, DEF);
  return `TEMPORARY POST ORDER Event/Project: ${d.event} Start Date: ${d.sd} End Date: ${d.ed} Days Required: ${d.dayGlyphs} Start Time: ${d.st} End Time: ${d.et} Coverage: ${d.covGlyphs} ${headerGuards} Meeting Location: ${d.loc} Site Contact: ${d.contact} Contact Number: ${d.phone} PPE / Equipment Requirements: ☒ Radio Post Details 1.0 Post Description and Assigned Duties ${d.duties} 2.0 Site`;
}
const GUARDS = [
  ["Number of Escorts/Guards: 4", "4"], ["No. of Escorts / Guards: 12", "12"],
  ["Guards Required: 5", "5"], ["Number of Security Guards: 9", "9"],
  ["Guard Qty: 5", "5"], ["Guards - 4", "4"], ["Guards = 4", "4"], ["Guards 4", "4"],
  ["4 Guards Required", "4"], ["Approx 6 guards", "6"], ["Minimum 8 guards", "8"],
  ["Guards on Site: 5", "5"], ["Number of Officers: 6", "6"],
  ["Number of Guards: 1 2", "12"], ["Number of Guards (day shift): 10", "10"],
  ["Guards Needed: 8", "8"], ["# of Guards: 3", "3"],
];
for (const [hdr, exp] of GUARDS)
  t(`guards: "${hdr}"`, parseFields(gtext(hdr), "t.pdf").numGuards, (v) => String(v) === exp);

// --- glyph variants (☑ U+2611, ✅) must NOT empty days/coverage/ppe ---
t("days ☑Fri", parseFields(makeText({ dayGlyphs: "☐Sun ☐Mon ☐Tue ☐Wed ☐Thu ☑Fri ☐Sat" }), "t").days, (v) => /Fri/.test(v));
t("days ✅Wed", parseFields(makeText({ dayGlyphs: "☐Sun ☐Mon ☐Tue ✅Wed ☐Thu ☐Fri ☐Sat" }), "t").days, (v) => /Wed/.test(v));
t("coverage ☑Continuous", parseFields(makeText({ covGlyphs: "☑Continuous ☐Specific Hours" }), "t").coverage, (v) => v === "Continuous");
t("ppe ☑Radio", parseFields(makeText({ ppeGlyphs: "☐ RAIC ☑ Radio ☐ Hard Hat" }), "t").ppe, (v) => /Radio/.test(v));
t("ppe Hi-Vis abbrev", parseFields(makeText({ ppeGlyphs: "☒ Radio ☒ Hi-Vis Vest" }), "t").ppe, (v) => /Hi-Visibility Vest/.test(v));
// negative control: an UNCHECKED day must NOT be reported
t("days ☐ unchecked stays empty", parseFields(makeText({ dayGlyphs: "☐Sun ☐Mon ☐Tue ☐Wed ☐Thu ☐Fri ☐Sat" }), "t").days, (v) => v === "");

// --- date ranges keep the START ---
t("range 'March 16 to March 18, 2026'", parseFields(makeText({ sd: "March 16 to March 18, 2026" }), "t").startDate, (v) => /March 16/.test(v) && !/18/.test(v));
t("range 'March 31 - April 2, 2026'", parseFields(makeText({ sd: "March 31 - April 2, 2026" }), "t").startDate, (v) => /March 31/.test(v) && !/April/.test(v));

// --- times: seconds + spaced colon ---
t("time '7:00:30 AM'", parseFields(makeText({ st: "7:00:30 AM" }), "t").startTime, (v) => /7:00/.test(v) && !/:30/.test(v));
t("time '7 : 00 AM'", parseFields(makeText({ st: "7 : 00 AM" }), "t").startTime, (v) => /7:00/.test(v));

console.log(`\nADVERSARIAL  PASS ${pass}  FAIL ${fail}\n`);
if (fails.length) { for (const f of fails) console.log(`  FAIL ${f.name} -> ${JSON.stringify(f.got)}`); process.exit(1); }
else console.log("ALL ADVERSARIAL CASES PASS.");
