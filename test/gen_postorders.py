"""Generate 5 made-up BBTCA Temporary Post Order PDFs that look like the REAL
client form (logo + 'TEMPORARY POST ORDER' header + bordered table, fields-left
/ PPE-list-right + shaded section headers). Data FORMAT is varied per order
(date styles, time styles, bullet glyphs, label phrasings) to stress the
parser's recognition. 2026-06-16."""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle, Paragraph,
                                Spacer, Image, KeepTogether)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("Sym", r"C:/Windows/Fonts/seguisym.ttf"))
LOGO = r"C:/Users/DaveBot/asp-callup-form/test/assets/logo_0.jpg"
OUT = r"C:/Users/DaveBot/Downloads/stress_po"
os.makedirs(OUT, exist_ok=True)

ss = getSampleStyleSheet()
P  = ParagraphStyle("p", parent=ss["Normal"], fontName="Helvetica", fontSize=9.5, leading=12)
PB = ParagraphStyle("pb", parent=P, fontName="Helvetica-Bold")
PH = ParagraphStyle("ph", parent=P, fontName="Helvetica-Bold", fontSize=10, alignment=1)
PT = ParagraphStyle("pt", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=15, alignment=2)
PPPE = ParagraphStyle("ppe", parent=P, fontName="Sym", fontSize=9, leading=14)
ALL_DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
ALL_PPE  = ["RAIC","AVOP D","AVOP DA","Radio","Hi-Visibility Vest","Safety Footwear",
            "Hard Hat","Eye Protection","Hearing Protection"]
def box(on): return "☒" if on else "☐"   # ☒ / ☐

def field_row(label, value):
    return [Paragraph(f"<b>{label}</b> {value}", P)]

def build(o):
    path = os.path.join(OUT, o["file"])
    doc = SimpleDocTemplate(path, pagesize=letter, topMargin=0.5*inch,
                            bottomMargin=0.5*inch, leftMargin=0.6*inch, rightMargin=0.6*inch)
    W = doc.width
    el = []
    # header: logo left, title right
    hdr = Table([[Image(LOGO, width=2.0*inch, height=0.74*inch),
                  Paragraph("TEMPORARY POST ORDER", PT)]], colWidths=[2.3*inch, W-2.3*inch])
    hdr.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"MIDDLE")]))
    el += [hdr, Spacer(1, 10)]

    # Event/Project banner row (full width)
    ev = Paragraph(f"<para align=center><b>Event/Project:</b> <font color='#c00000'><b>{o['event']}</b></font></para>", PH)

    # LEFT field block (nested table) — order MATCHES parser between() anchors
    days = "  ".join(f"{box(d in o['days'])}{d}" for d in ALL_DAYS)
    left_rows = [
        [Paragraph(f"<b>Start Date:</b> {o['sd']}", P), Paragraph(f"<b>End Date:</b> {o['ed']}", P)],
        [Paragraph(f"<b>Days Required:</b> {days}", PPPE), ""],
        [Paragraph(f"<b>Start Time:</b> {o['st']}", P), Paragraph(f"<b>End Time:</b> {o['et']}", P)],
        [Paragraph(f"<b>Coverage:</b> {box(o['coverage']=='Continuous')}Continuous  {box(o['coverage']=='Specific Hours')}Specific Hours", PPPE), ""],
        [Paragraph(f"<b>{o.get('guard_label','Number of Escorts/Guards:')}</b> {o['guards']}", P), ""],
        [Paragraph(f"<b>Meeting Location:</b> {o['loc']}", P), ""],
        [Paragraph(f"<b>Site Contact:</b> {o['contact']}", P), ""],
        [Paragraph(f"<b>Contact Number:</b> {o['phone']}", P), ""],
    ]
    lw = (W*0.62)
    left = Table(left_rows, colWidths=[lw*0.5, lw*0.5])
    left.setStyle(TableStyle([
        ("GRID",(0,0),(-1,-1),0.5,colors.black),
        ("SPAN",(0,1),(1,1)),("SPAN",(0,3),(1,3)),("SPAN",(0,4),(1,4)),
        ("SPAN",(0,5),(1,5)),("SPAN",(0,6),(1,6)),("SPAN",(0,7),(1,7)),
        ("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
    ]))
    # RIGHT PPE block
    ppe_lines = "<b>PPE / Equipment Requirements:</b><br/>" + "<br/>".join(
        f"{box(p in o['ppe'])} {p}" for p in ALL_PPE) + "<br/>☐ Other ____________"
    right = Paragraph(ppe_lines, PPPE)

    body = Table([[ev, ""],[left, right]], colWidths=[W*0.62, W*0.38])
    body.setStyle(TableStyle([
        ("SPAN",(0,0),(1,0)),
        ("BOX",(0,0),(-1,-1),0.8,colors.black),
        ("LINEBELOW",(0,0),(1,0),0.8,colors.black),
        ("LINEAFTER",(0,1),(0,1),0.8,colors.black),
        ("BACKGROUND",(0,0),(1,0),colors.whitesmoke),
        ("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),5),
        ("RIGHTPADDING",(0,0),(-1,-1),5),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5),
    ]))
    el += [body, Spacer(1, 2)]

    # Post Details shaded banner
    pd = Table([[Paragraph("<para align=center><b>Post Details</b></para>", PH)]], colWidths=[W])
    pd.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),colors.whitesmoke),("BOX",(0,0),(-1,-1),0.8,colors.black),
                            ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3)]))
    # Duties
    duty_html = f"<b>1.0 Post Description and Assigned Duties</b><br/>{o['leadin']}<br/>"
    for d in o["duties"]:
        duty_html += f"&nbsp;&nbsp;{o['bullet']} {d}<br/>"
    if o.get("trailer"): duty_html += f"<br/>{o['trailer']}"
    duties = Table([[Paragraph(duty_html, P)]], colWidths=[W])
    duties.setStyle(TableStyle([("BOX",(0,0),(-1,-1),0.8,colors.black),("LEFTPADDING",(0,0),(-1,-1),6),
                                ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),10)]))
    sd = Table([[Paragraph("<b>2.0 Site Drawing</b>", P)]], colWidths=[W])
    sd.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),colors.whitesmoke),("BOX",(0,0),(-1,-1),0.8,colors.black),
                            ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3)]))
    el += [pd, duties, sd]
    doc.build(el)
    return path

ORDERS = [
    # PO1 — standard format (matches real): "DD Month YYYY", HHMM, • bullets
    dict(file="PO1_Aurora_Drone_Festival.pdf", event="Aurora Drone Light Festival",
         sd="04 March 2026", ed="04 March 2026", days=["Sat"], st="1900", et="2330",
         coverage="Continuous", guards="4", ppe=["Radio","Hi-Visibility Vest","Safety Footwear"],
         loc="West Apron Viewing Lawn (Gate 3 muster)", contact="Marcus Bellweather",
         phone="(416) 555-0142", bullet="•",
         leadin="Providing crowd management and perimeter watch for the evening drone display as follows:",
         duties=["2 guards stationed at the West Apron viewing lawn perimeter to keep guests behind the fence line",
                 "1 guard roaming between Gate 3 and the Stolport FBO walkway directing foot traffic",
                 "1 guard monitoring the emergency vehicle lane to keep it clear at all times"],
         trailer="Guards must remain aware of taxiway activity along the South apron edge."),
    # PO2 — VARIED: ISO dates "2026-03-14", times with colon "05:00", dash bullets
    dict(file="PO2_Harbourfront_HalfMarathon.pdf", event="Harbourfront Half-Marathon Staging",
         sd="2026-03-14", ed="2026-03-15", days=["Sat","Sun"], st="05:00", et="13:00",
         coverage="Specific Hours", guards="8", ppe=["Radio","Hi-Visibility Vest","Safety Footwear","Hearing Protection"],
         loc="Marine Terminal Staging Yard", contact="Priya Venkataraman", phone="647-555-0199", bullet="-",
         leadin="Securing the race staging compound and controlling access as follows:",
         duties=["4 guards on the staging compound fence line, one per gate, checking accreditation",
                 "2 guards escorting equipment vehicles between the yard and the start corral",
                 "2 guards on roving patrol of the spectator overflow lot"]),
    # PO3 — VARIED: "Mar 21, 2026" style, 12h times "6:00 AM / 10:00 PM", special chars
    dict(file="PO3_Dignitary_Aircraft_Reception.pdf", event="Dignitary Aircraft Reception",
         sd="Mar 21, 2026", ed="Mar 21, 2026", days=["Fri"], st="6:00 AM", et="10:00 PM",
         coverage="Continuous", guards="1", ppe=["Radio","Hi-Visibility Vest"],
         loc="Signature FBO – VIP Lounge entrance", contact="Siobhán O'Brien-D’Souza",
         phone="416.555.0173", bullet="•",
         leadin="Providing a single dedicated access-control post at the FBO VIP entrance as follows:",
         duties=["1 guard at the VIP Lounge entrance verifying the approved guest manifest before entry",
                 "Maintain a written visitor log and escort any unescorted persons to the Site Contact"]),
    # PO4 — VARIED: "DD-Mon-YYYY" dates, label "No. of Escorts / Guards:", many guards, long duties
    dict(file="PO4_Hangar9_Roof_Replacement.pdf", event="Hangar 9 Roof Membrane Replacement",
         sd="02-Mar-2026", ed="06-Mar-2026", days=["Mon","Tue","Wed","Thu","Fri"], st="0700", et="1730",
         coverage="Continuous", guards="12", guard_label="No. of Escorts / Guards:",
         ppe=["RAIC","Radio","Hi-Visibility Vest","Safety Footwear","Hard Hat","Eye Protection"],
         loc="Hangar 9 North Compound (contractor lay-down)", contact="Desmond Achterberg",
         phone="(416) 555-0188", bullet="•",
         leadin="Securing the active roofing work zone and the airside boundary as follows:",
         duties=["4 guards on the airside fence line maintaining the construction boundary",
                 "3 guards controlling the contractor vehicle gate and checking RAIC on all entrants",
                 "2 guards escorting material deliveries across the apron to the lay-down area",
                 "2 guards on the Hangar 9 roof access stair preventing unauthorized roof access",
                 "1 guard monitoring the FOD walk-down at shift change"]),
    # PO5 — VARIED: "DD/MM/YYYY" dates, overnight 2200->0600, dash bullets, minimal
    dict(file="PO5_Glycol_Pad_Night_Watch.pdf", event="Glycol De-Icing Pad Night Watch",
         sd="18/02/2026", ed="19/02/2026", days=["Wed","Thu"], st="2200", et="0600",
         coverage="Continuous", guards="2", ppe=["Radio","Hi-Visibility Vest","Safety Footwear"],
         loc="De-Icing Pad Bravo – South gate", contact="Lena Kowalczyk", phone="(905) 555-0121", bullet="-",
         leadin="Overnight protection of the glycol storage and de-icing pad as follows:",
         duties=["1 guard at the South gate logging all tanker movements through the night",
                 "1 guard on roving patrol of the glycol containment berm checking for spills or tampering"]),
]
for o in ORDERS:
    print("wrote", build(o))
print("DONE — 5 realistic post orders in", OUT)
