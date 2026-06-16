"""Generate V2 (revised) variants of the stress-test post orders, reusing the
faithful builder in gen_postorders. Each v2 changes a few fields so the
"Call Up Request Changed (Revised V2)" email has real diffs to highlight.
2026-06-16."""
import copy
import gen_postorders as g   # importing runs the v1 build loop (idempotent)

# base dicts keyed by a short name
BASE = {o["file"].split("_")[0]: o for o in g.ORDERS}

# (key, mutations) — only the listed fields change vs v1
V2 = {
    "PO1": dict(file="PO1_Aurora_Drone_Festival_v2.pdf", guards="6", st="1830",
                duties=BASE["PO1"]["duties"] + ["1 guard added at the North service road barricade per city permit"]),
    "PO4": dict(file="PO4_Hangar9_Roof_Replacement_v2.pdf", guards="10", ed="07-Mar-2026",
                loc="Hangar 9 North Compound (revised contractor lay-down — Gate B)"),
    "PO3": dict(file="PO3_Dignitary_Aircraft_Reception_v2.pdf", et="11:30 PM",
                ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear"]),
}

for key, changes in V2.items():
    o = copy.deepcopy(BASE[key])
    o.update(changes)
    print("wrote", g.build(o))
print("DONE — V2 revisions in", g.OUT)
