"""Generate a spectrum of faithful post-order PDFs with DIVERSE date/time/guard
formats, to verify end-to-end (pdf.js + parseFields) that no field ever shows
"See PDF". Reuses gen_postorders.build(). Output: Downloads/stress_po/SPxx_*.pdf
"""
import copy
import sys

sys.path.insert(0, "test")
import gen_postorders as g

BASE = copy.deepcopy(g.ORDERS[0])  # PO01 as the structural template

# (file, overrides) — each exercises previously-weak or adversarial formats
SPECS = [
    ("SP01_iso_slash", dict(sd="2026/04/02", ed="2026/04/02", st="13:45", et="17:15")),
    ("SP02_ordinals_ampm", dict(sd="2nd March 2026", ed="21st March 2026", st="7 AM", et="11 AM")),
    ("SP03_range_hrs", dict(sd="March 16 - 18, 2026", ed="March 16 - 18, 2026", st="0900 hrs", et="1700 hrs")),
    ("SP04_monthdash_words", dict(sd="Apr-05-2026", ed="Apr-05-2026", st="noon", et="midnight")),
    ("SP05_2digit_oclock", dict(sd="03/04/26", ed="04/04/26", st="9 o'clock", et="5 o'clock")),
    ("SP06_secguards", dict(sd="Tuesday, March 3, 2026", ed="Tuesday, March 3, 2026",
                            st="0500", et="2100", guards="9", guard_label="Number of Security Guards:")),
    ("SP07_dotted", dict(sd="2026.03.04", ed="2026.03.05", st="9.30 am", et="5.30 pm")),
    ("SP08_guards_required", dict(sd="5 Mar 2026", ed="6 Mar 2026", st="0700", et="1730",
                                  guards="12", guard_label="Guards Required:")),
]

for fname, ov in SPECS:
    o = copy.deepcopy(BASE)
    o["file"] = fname + ".pdf"
    o["event"] = "Spectrum Test " + fname.split("_", 1)[1].replace("_", " ").title()
    o.update(ov)
    g.build(o)
    print("wrote", o["file"], "| sd", o["sd"], "et", o["et"],
          "| guardLabel", ov.get("guard_label", "default"))

print("\nDONE:", len(SPECS), "spectrum PDFs in", g.OUT)
