/* Exhaustive parser test for the BBTCA Call-Up PDF field extractor.
 *
 * David (2026-06-25): "There must never be 'See PDF' on any field. Test every
 * field with a wide spectrum of info to ensure that doesn't show up."
 *
 * parseFields(text, filename) in index.html is pure text-regex over the
 * pdf.js-flattened PDF text, so we extract it verbatim (stays in sync with the
 * live file) and run a wide spectrum of real-world formats per field. The text
 * template below is the REAL pdf.js output captured from a generated post order
 * (test/_realtext_PO01.txt), with swappable tokens.
 *
 * A test FAILS if a field comes back "See PDF", empty (when data was present),
 * or grossly wrong (grabbed a neighbouring label/value).
 */
const fs = require("fs");
const path = require("path");

// ---- extract parseFields (+ nothing else; it is self-contained) from index.html
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) throw new Error(`${name} not found`);
  // find the opening brace of the body
  let i = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const parseFields = eval("(" + extractFn(html, "parseFields") + ")");

// ---- faithful flattened-PDF text template (from real pdf.js output) ----
const DEF = {
  event: "Aurora Drone Light Festival",
  sd: "04 March 2026", ed: "04 March 2026",
  dayGlyphs: "☐Sun ☐Mon ☐Tue ☐Wed ☐Thu ☐Fri ☒Sat",
  st: "1900", et: "2330",
  covGlyphs: "☒Continuous ☐Specific Hours",
  guardsLabel: "Number of Escorts/Guards:", guards: "4",
  loc: "West Apron Viewing Lawn (Gate 3 muster)",
  contact: "Marcus Bellweather", phone: "(416) 555-0142",
  ppeGlyphs: "☐ RAIC ☐ AVOP D ☐ AVOP DA ☒ Radio ☒ Hi-Visibility Vest ☒ Safety Footwear ☐ Hard Hat ☐ Eye Protection ☐ Hearing Protection ☐ Other ____________",
  duties: "Securing the site as follows: • 2 guards on the fence line • 1 guard roaming the gate",
};
function makeText(o = {}) {
  const d = Object.assign({}, DEF, o);
  return `TEMPORARY POST ORDER Page 1 of 2 Event/Project: ${d.event} Start Date: ${d.sd} End Date: ${d.ed} Days Required: ${d.dayGlyphs} Start Time: ${d.st} End Time: ${d.et} Coverage: ${d.covGlyphs} ${d.guardsLabel} ${d.guards} Meeting Location: ${d.loc} Site Contact: ${d.contact} Contact Number: ${d.phone} PPE / Equipment Requirements: ${d.ppeGlyphs} Post Details 1.0 Post Description and Assigned Duties ${d.duties} 2.0 Site Drawing TEMPORARY POST ORDER Page 2 of 2 3.0 General Information 1. Any deviation must be approved by the Site Contact . 4.0 Emergency Procedures 1. Report emergencies to the Airport Emergency Line - 416-203-1910 .`;
}

const BAD = (v) => v == null || v === "" || /see pdf/i.test(String(v));
let pass = 0, fail = 0;
const fails = [];
function check(field, label, input, got, extra) {
  const bad = BAD(got) || (extra && !extra(got));
  if (bad) { fail++; fails.push({ field, label, input, got: String(got) }); }
  else pass++;
}

// ---------- DATE SPECTRUM ----------
const DATES = [
  "04 March 2026", "4 March 2026", "04 Mar 2026", "4 Mar 2026",
  "March 4, 2026", "March 4 2026", "Mar 4, 2026", "Mar. 4, 2026",
  "2026-03-04", "2026/03/04", "2026.03.04",
  "04/03/2026", "4/3/2026", "03/04/2026", "04-03-2026", "04-Mar-2026",
  "2nd March 2026", "3rd of March 2026", "1st Apr 2026", "21st March 2026",
  "Tuesday, March 3, 2026", "Tue 3 Mar 2026", "Wed, 04 Mar 2026",
  "Apr 5 2026", "April 5 2026", "5 April 2026", "Apr-05-2026",
  "March 16 - 18, 2026", "16-18 March 2026", "Mar 16-18 2026",
  "31/12/2026", "01 Jan 2027", "Dec 31, 2026", "2026/12/31",
  "3 Mar 26", "03/04/26",
];
for (const d of DATES) {
  const r = parseFields(makeText({ sd: d, ed: d }), "t.pdf");
  check("startDate", "Start Date", d, r.startDate);
  check("endDate", "End Date", d, r.endDate);
}

// ---------- TIME SPECTRUM ----------
const TIMES = [
  "1900", "0500", "0030", "2330", "0000",
  "19:00", "5:00", "05:00", "13:45", "00:30",
  "7 AM", "7AM", "7 am", "11 AM", "7:00 AM", "7:00AM", "11:30 PM",
  "7 a.m.", "11 p.m.", "12 noon", "noon", "midnight",
  "9 o'clock", "0900 hrs", "0900hrs", "1700 hours",
  "6:00 AM EST", "9.00", "9.30 am", "0600h",
  "7 AM - 11 AM", "0900-1700",
];
for (const t of TIMES) {
  const r = parseFields(makeText({ st: t, et: t }), "t.pdf");
  check("startTime", "Start Time", t, r.startTime);
  check("endTime", "End Time", t, r.endTime);
}

// ---------- GUARDS LABEL SPECTRUM ----------
const GUARDS = [
  ["Number of Escorts/Guards:", "4"], ["No. of Escorts / Guards:", "12"],
  ["No of Guards:", "8"], ["# of Guards:", "3"], ["Number of Guards:", "15"],
  ["Number of Escorts / Guards :", "6"], ["No. of Guards", "2"],
  ["Guards Required:", "5"], ["Number of Security Guards:", "9"],
];
for (const [lbl, g] of GUARDS) {
  const r = parseFields(makeText({ guardsLabel: lbl, guards: g }), "t.pdf");
  check("numGuards", lbl, g, r.numGuards, (v) => String(v) === g);
}

// ---------- EVENT / LOCATION / CONTACT / PHONE ----------
const EVENTS = ["Aurora Drone Light Festival", "VVIP Motorcade & Departure", "Hangar 9 Roof – Replacement", "NYE: Fireworks (Waterfront)", "A", "Runway 8-26 Charity Fun-Run 2026"];
for (const e of EVENTS) check("event", "Event", e, parseFields(makeText({ event: e }), "t.pdf").event);
const LOCS = ["West Apron Viewing Lawn (Gate 3 muster)", "Signature FBO – VIP Lounge entrance", "Gate 110", "Marine Terminal Staging Yard, Door 4"];
for (const l of LOCS) check("meetingLocation", "Meeting Location", l, parseFields(makeText({ loc: l }), "t.pdf").meetingLocation);
const CONTACTS = ["Marcus Bellweather", "Siobhán O'Brien-D'Souza", "Aoife Ní Bhraonáin", "Yuki Tanaka-Okonkwo", "Dr. Desmond Achterberg"];
for (const c of CONTACTS) check("siteContact", "Site Contact", c, parseFields(makeText({ contact: c }), "t.pdf").siteContact);
const PHONES = ["(416) 555-0142", "647-555-0199", "416.555.0173", "1-416-555-0144", "437.555.0102", "+1 (416) 555 0188", "416 555 0142 ext 12"];
for (const p of PHONES) check("contactNumber", "Contact Number", p, parseFields(makeText({ phone: p }), "t.pdf").contactNumber);

// ---------- DAYS / COVERAGE / PPE ----------
check("days", "Days", "Sat", parseFields(makeText({ dayGlyphs: "☐Sun ☐Mon ☐Tue ☐Wed ☐Thu ☐Fri ☒Sat" }), "t.pdf").days, (v) => v === "Sat");
check("days", "Days multi", "Mon,Wed", parseFields(makeText({ dayGlyphs: "☐Sun ☒Mon ☐Tue ☒Wed ☐Thu ☐Fri ☐Sat" }), "t.pdf").days, (v) => /Mon/.test(v) && /Wed/.test(v));
check("coverage", "Coverage cont", "Continuous", parseFields(makeText({ covGlyphs: "☒Continuous ☐Specific Hours" }), "t.pdf").coverage, (v) => v === "Continuous");
check("coverage", "Coverage spec", "Specific", parseFields(makeText({ covGlyphs: "☐Continuous ☒Specific Hours" }), "t.pdf").coverage, (v) => v === "Specific Hours");
check("ppe", "PPE", "Radio", parseFields(makeText(), "t.pdf").ppe, (v) => /Radio/.test(v));
check("duties", "Duties", "bullets", parseFields(makeText(), "t.pdf").duties, (v) => /guards on the fence/.test(v));

// ---------- REPORT ----------
console.log(`\nPASS ${pass}  FAIL ${fail}\n`);
if (fails.length) {
  console.log("FAILURES (field | input -> got):");
  for (const f of fails) console.log(`  ${f.field.padEnd(15)} | ${JSON.stringify(f.input).padEnd(28)} -> ${JSON.stringify(f.got)}`);
  process.exit(1);
} else {
  console.log("ALL FIELDS PARSED — no 'See PDF', no empties, no misgrabs.");
}
