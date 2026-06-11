// Run a JSON array of {input, expected, suspectedFailure} cases through the REAL
// dutiesListHtml extracted from index.html, printing input -> rendered output so
// the result can be judged. Usage: node test/probe_duties.js cases.json
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractFn(name) {
  const start = html.indexOf("function " + name + "(");
  let i = html.indexOf("{", start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return html.slice(start, end);
}
eval(extractFn("escHtml") + "\n" + extractFn("dutiesListHtml"));

// readable render: strip style attrs, mark structure
function show(h) {
  return h
    .replace(/<p style="margin-bottom:4px"><strong>Duties:<\/strong><\/p>/g, "[H:Duties:]")
    .replace(/<p style="margin:0 0 4px 0">([\s\S]*?)<\/p>/g, "[LEAD: $1]")
    .replace(/<ul[^>]*>/g, "[UL]").replace(/<\/ul>/g, "[/UL]")
    .replace(/<li>/g, "\n    • ").replace(/<\/li>/g, "");
}

const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let i = 0;
for (const c of cases) {
  i++;
  const out = dutiesListHtml(c.input);
  console.log("\n#" + i + " [" + (c.lens || "?") + "] suspected: " + (c.suspectedFailure || ""));
  console.log("  IN : " + JSON.stringify(c.input).slice(0, 200));
  console.log("  OUT: " + show(out).replace(/\n/g, "\n  "));
}
console.log("\n" + i + " cases run");
