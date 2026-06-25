"""Generate ~a dozen made-up BBTCA Temporary Post Order PDFs that look EXACTLY like
the REAL client form (2026-06-25 rebuild — David: the old version was a scaled-down
text doc; this is a faithful 2-page replica): Billy Bishop logo + 'TEMPORARY POST
ORDER' header on BOTH pages, gray Event/Project banner, two-column table (fields-left /
PPE-checkboxes-right), Post Details + 1.0 bulleted Duties, 2.0 Site Drawing banner, the
REAL site-map image (page 2), 3.0 General Information + 4.0 Emergency Procedures, and the
Ports Toronto footer logo + 'Page N of 2' on every page. Data FORMAT is varied per order
(date/time styles, bullet glyphs, label phrasings, special chars) to stress the parser."""
import os

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle, Paragraph,
                                Spacer, Image, PageBreak)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("Sym", r"C:/Windows/Fonts/seguisym.ttf"))
ASSETS = r"C:/Users/DaveBot/asp-callup-form/test/assets"
LOGO_BB = os.path.join(ASSETS, "logo_0.jpg")          # Billy Bishop (680x251)
LOGO_PORTS = os.path.join(ASSETS, "logo_1.png")       # Ports Toronto (325x110)
SITE_MAP = os.path.join(ASSETS, "site_drawing.png")  # real BBTCA site map
OUT = r"C:/Users/DaveBot/Downloads/stress_po"
os.makedirs(OUT, exist_ok=True)

ss = getSampleStyleSheet()
P = ParagraphStyle("p", parent=ss["Normal"], fontName="Helvetica", fontSize=9.5, leading=12)
PH = ParagraphStyle("ph", parent=P, fontName="Helvetica-Bold", fontSize=10, alignment=1)
PPPE = ParagraphStyle("ppe", parent=P, fontName="Sym", fontSize=9, leading=14)
ALL_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
ALL_PPE = ["RAIC", "AVOP D", "AVOP DA", "Radio", "Hi-Visibility Vest", "Safety Footwear",
           "Hard Hat", "Eye Protection", "Hearing Protection"]

# Standard boilerplate — VERBATIM from the real post orders (same on every order).
GENERAL_INFO = [
    "Any deviation from this Post Order must be approved in writing by the Site Contact or their designate.",
    "Escorts/guards must perform a site safety check to ensure no safety or security hazards remain and confirm all escorted personnel and/or vehicles have left the site.",
    "Guards must carry a copy of this Temporary Post Order at all times.",
    "Non-emergency incidents should be reported to <b>Airport Operations</b> at <b>416-203-6942 x 3010</b>.",
]
EMERGENCY = [
    "<b>Immediately report all emergencies</b> to the <font color='#c00000'><b>Airport Emergency Line – 416-203-1910</b></font>.",
    "Do <b>NOT</b> take direction or release information to outside agencies, individuals, or partners without explicit consent from the <b>Airport Duty Manager</b>, <b>PortsToronto Security</b>, or <b>Site Contact</b>.",
]


def box(on):
    return "☒" if on else "☐"   # checked / unchecked


def _page_furniture(canvas, doc):
    """Header (Billy Bishop logo + title) + footer (Page N of 2 + Ports Toronto) on
    EVERY page — matches the real form."""
    canvas.saveState()
    pw, ph = letter
    # header
    canvas.drawImage(LOGO_BB, 0.6 * inch, ph - 0.45 * inch - 0.63 * inch,
                     width=1.7 * inch, height=0.63 * inch, mask='auto')
    canvas.setFont("Helvetica-Bold", 16)
    canvas.drawRightString(pw - 0.6 * inch, ph - 0.45 * inch - 0.42 * inch,
                           "TEMPORARY POST ORDER")
    # footer
    canvas.setFont("Helvetica", 9)
    canvas.drawString(0.6 * inch, 0.4 * inch, f"Page {canvas.getPageNumber()} of 2")
    try:
        canvas.drawImage(LOGO_PORTS, pw - 0.6 * inch - 1.05 * inch, 0.3 * inch,
                         width=1.05 * inch, height=0.355 * inch, mask='auto')
    except Exception:
        pass
    canvas.restoreState()


def _banner(text, W):
    t = Table([[Paragraph(f"<para align=center>{text}</para>", PH)]], colWidths=[W])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.whitesmoke),
                           ("BOX", (0, 0), (-1, -1), 0.8, colors.black),
                           ("TOPPADDING", (0, 0), (-1, -1), 3),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return t


def _numbered_box(title, items, W):
    html = f"<b>{title}</b><br/>"
    for i, it in enumerate(items, 1):
        html += f"&nbsp;&nbsp;{i}.&nbsp;&nbsp;{it}<br/>"
    t = Table([[Paragraph(html, P)]], colWidths=[W])
    t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, colors.black),
                           ("LEFTPADDING", (0, 0), (-1, -1), 6),
                           ("TOPPADDING", (0, 0), (-1, -1), 5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    return t


def build(o):
    path = os.path.join(OUT, o["file"])
    doc = SimpleDocTemplate(path, pagesize=letter, topMargin=1.15 * inch,
                            bottomMargin=0.7 * inch, leftMargin=0.6 * inch,
                            rightMargin=0.6 * inch)
    W = doc.width
    el = []

    # Event/Project banner (top row of the bordered body table)
    ev = Paragraph(f"<para align=center><b>Event/Project:</b> "
                   f"<font color='#c00000'><b>{o['event']}</b></font></para>", PH)
    days = "  ".join(f"{box(d in o['days'])}{d}" for d in ALL_DAYS)
    left_rows = [
        [Paragraph(f"<b>Start Date:</b> {o['sd']}", P), Paragraph(f"<b>End Date:</b> {o['ed']}", P)],
        [Paragraph(f"<b>Days Required:</b> {days}", PPPE), ""],
        [Paragraph(f"<b>Start Time:</b> {o['st']}", P), Paragraph(f"<b>End Time:</b> {o['et']}", P)],
        [Paragraph(f"<b>Coverage:</b> {box(o['coverage'] == 'Continuous')}Continuous  "
                   f"{box(o['coverage'] == 'Specific Hours')}Specific Hours", PPPE), ""],
        [Paragraph(f"<b>{o.get('guard_label', 'Number of Escorts/Guards:')}</b> {o['guards']}", P), ""],
        [Paragraph(f"<b>Meeting Location:</b> {o['loc']}", P), ""],
        [Paragraph(f"<b>Site Contact:</b> {o['contact']}", P), ""],
        [Paragraph(f"<b>Contact Number:</b> {o['phone']}", P), ""],
    ]
    lw = W * 0.62
    left = Table(left_rows, colWidths=[lw * 0.5, lw * 0.5])
    left.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 3), (1, 3)), ("SPAN", (0, 4), (1, 4)),
        ("SPAN", (0, 5), (1, 5)), ("SPAN", (0, 6), (1, 6)), ("SPAN", (0, 7), (1, 7)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    ppe_lines = "<b>PPE / Equipment Requirements:</b><br/>" + "<br/>".join(
        f"{box(p in o['ppe'])} {p}" for p in ALL_PPE) + "<br/>☐ Other ____________"
    right = Paragraph(ppe_lines, PPPE)
    body = Table([[ev, ""], [left, right]], colWidths=[W * 0.62, W * 0.38])
    body.setStyle(TableStyle([
        ("SPAN", (0, 0), (1, 0)), ("BOX", (0, 0), (-1, -1), 0.8, colors.black),
        ("LINEBELOW", (0, 0), (1, 0), 0.8, colors.black),
        ("LINEAFTER", (0, 1), (0, 1), 0.8, colors.black),
        ("BACKGROUND", (0, 0), (1, 0), colors.whitesmoke),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    el += [body, Spacer(1, 2), _banner("<b>Post Details</b>", W)]

    duty_html = f"<b>1.0 Post Description and Assigned Duties</b><br/>{o['leadin']}<br/>"
    for d in o["duties"]:
        duty_html += f"&nbsp;&nbsp;{o['bullet']} {d}<br/>"
    if o.get("trailer"):
        duty_html += f"<br/>{o['trailer']}"
    duties = Table([[Paragraph(duty_html, P)]], colWidths=[W])
    duties.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, colors.black),
                                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                                ("TOPPADDING", (0, 0), (-1, -1), 6),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 10)]))
    el += [duties, _banner("<b>2.0 Site Drawing</b>", W)]

    # ---- Page 2: site map + General Information + Emergency Procedures ----
    el += [PageBreak()]
    site = Table([[Image(SITE_MAP, width=W, height=W * 534.0 / 758.0)]], colWidths=[W])
    site.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, colors.black),
                              ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                              ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    el += [site, Spacer(1, 4),
           _numbered_box("3.0 General Information", GENERAL_INFO, W), Spacer(1, 4),
           _numbered_box("4.0 Emergency Procedures", EMERGENCY, W)]

    doc.build(el, onFirstPage=_page_furniture, onLaterPages=_page_furniture)
    return path


# ~a dozen orders — WIDE variety of data + formats to stress the parser/app.
ORDERS = [
    dict(file="PO01_Aurora_Drone_Festival.pdf", event="Aurora Drone Light Festival",
         sd="04 March 2026", ed="04 March 2026", days=["Sat"], st="1900", et="2330",
         coverage="Continuous", guards="4", ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear"],
         loc="West Apron Viewing Lawn (Gate 3 muster)", contact="Marcus Bellweather",
         phone="(416) 555-0142", bullet="•",
         leadin="Providing crowd management and perimeter watch for the evening drone display as follows:",
         duties=["2 guards stationed at the West Apron viewing lawn perimeter to keep guests behind the fence line",
                 "1 guard roaming between Gate 3 and the Stolport FBO walkway directing foot traffic",
                 "1 guard monitoring the emergency vehicle lane to keep it clear at all times"],
         trailer="Guards must remain aware of taxiway activity along the South apron edge."),
    dict(file="PO02_Harbourfront_HalfMarathon.pdf", event="Harbourfront Half-Marathon Staging",
         sd="2026-03-14", ed="2026-03-15", days=["Sat", "Sun"], st="05:00", et="13:00",
         coverage="Specific Hours", guards="8",
         ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear", "Hearing Protection"],
         loc="Marine Terminal Staging Yard", contact="Priya Venkataraman", phone="647-555-0199", bullet="-",
         leadin="Securing the race staging compound and controlling access as follows:",
         duties=["4 guards on the staging compound fence line, one per gate, checking accreditation",
                 "2 guards escorting equipment vehicles between the yard and the start corral",
                 "2 guards on roving patrol of the spectator overflow lot"]),
    dict(file="PO03_Dignitary_Aircraft_Reception.pdf", event="Dignitary Aircraft Reception",
         sd="Mar 21, 2026", ed="Mar 21, 2026", days=["Fri"], st="6:00 AM", et="10:00 PM",
         coverage="Continuous", guards="1", ppe=["Radio", "Hi-Visibility Vest"],
         loc="Signature FBO – VIP Lounge entrance", contact="Siobhán O'Brien-D’Souza",
         phone="416.555.0173", bullet="•",
         leadin="Providing a single dedicated access-control post at the FBO VIP entrance as follows:",
         duties=["1 guard at the VIP Lounge entrance verifying the approved guest manifest before entry",
                 "Maintain a written visitor log and escort any unescorted persons to the Site Contact"]),
    dict(file="PO04_Hangar9_Roof_Replacement.pdf", event="Hangar 9 Roof Membrane Replacement",
         sd="02-Mar-2026", ed="06-Mar-2026", days=["Mon", "Tue", "Wed", "Thu", "Fri"], st="0700", et="1730",
         coverage="Continuous", guards="12", guard_label="No. of Escorts / Guards:",
         ppe=["RAIC", "Radio", "Hi-Visibility Vest", "Safety Footwear", "Hard Hat", "Eye Protection"],
         loc="Hangar 9 North Compound (contractor lay-down)", contact="Desmond Achterberg",
         phone="(416) 555-0188", bullet="•",
         leadin="Securing the active roofing work zone and the airside boundary as follows:",
         duties=["4 guards on the airside fence line maintaining the construction boundary",
                 "3 guards controlling the contractor vehicle gate and checking RAIC on all entrants",
                 "2 guards escorting material deliveries across the apron to the lay-down area",
                 "2 guards on the Hangar 9 roof access stair preventing unauthorized roof access",
                 "1 guard monitoring the FOD walk-down at shift change"]),
    dict(file="PO05_Glycol_Pad_Night_Watch.pdf", event="Glycol De-Icing Pad Night Watch",
         sd="18/02/2026", ed="19/02/2026", days=["Wed", "Thu"], st="2200", et="0600",
         coverage="Continuous", guards="2", ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear"],
         loc="De-Icing Pad Bravo – South gate", contact="Lena Kowalczyk", phone="(905) 555-0121", bullet="-",
         leadin="Overnight protection of the glycol storage and de-icing pad as follows:",
         duties=["1 guard at the South gate logging all tanker movements through the night",
                 "1 guard on roving patrol of the glycol containment berm checking for spills or tampering"]),
    dict(file="PO06_Terminal_Film_Shoot.pdf", event="Air Terminal Film Production Shoot",
         sd="March 9, 2026", ed="March 11, 2026", days=["Mon", "Tue", "Wed"], st="0500", et="2100",
         coverage="Specific Hours", guards="6", guard_label="# of Guards:",
         ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear"],
         loc="Air Terminal Building – Departures curb", contact="Renata Oyelaran",
         phone="(416) 555-0210", bullet="*",
         leadin="Access control and public safety around an active film set as follows:",
         duties=["2 guards managing the closed Departures curb and redirecting public traffic",
                 "2 guards on the set perimeter keeping the public clear of equipment and cabling",
                 "1 guard at the talent holding area checking crew accreditation",
                 "1 guard liaising with Airport Operations for any aircraft movement holds"]),
    dict(file="PO07_Seawall_Survey.pdf", event="Eastern Seawall Geotechnical Survey",
         sd="5 Mar 2026", ed="5 Mar 2026", days=["Thu"], st="0800", et="1600",
         coverage="Continuous", guards="3",
         ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear", "Hard Hat", "Eye Protection"],
         loc="East Service Road – seawall access point", contact="Tobias Nwachukwu",
         phone="416 555 0166", bullet="•",
         leadin="Escort and boundary control for a survey crew working near live airside as follows:",
         duties=["1 guard escorting the survey crew between the muster point and the seawall",
                 "1 guard maintaining the airside boundary at the East Service Road gate",
                 "1 guard spotting for vehicle movements on the adjacent taxiway"]),
    dict(file="PO08_NYE_Fireworks.pdf", event="New Year's Eve Waterfront Fireworks",
         sd="31/12/2026", ed="01/01/2027", days=["Thu", "Fri"], st="20:00", et="01:30",
         coverage="Continuous", guards="10",
         ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear", "Hearing Protection"],
         loc="Marine Terminal – public viewing pier", contact="Gerald Östberg",
         phone="(647) 555-0188", bullet="-",
         leadin="Crowd control and emergency-egress management for the fireworks viewing as follows:",
         duties=["6 guards on the viewing pier maintaining crowd density and clear egress lanes",
                 "2 guards at the pier entrance counting heads against the posted capacity",
                 "2 guards roaming the perimeter watching for unauthorized water access"]),
    dict(file="PO09_VVIP_Motorcade.pdf", event="VVIP Motorcade Aircraft Departure",
         sd="2026/04/02", ed="2026/04/02", days=["Thu"], st="13:45", et="17:15",
         coverage="Specific Hours", guards="5",
         ppe=["RAIC", "Radio", "Hi-Visibility Vest"],
         loc="Airport Administration Office – secure gate", contact="Aoife Ní Bhraonáin",
         phone="1-416-555-0144", bullet="•",
         leadin="Sterile-corridor access control for a VVIP motorcade and departure as follows:",
         duties=["2 guards controlling the secure vehicle gate and verifying RAIC for the motorcade",
                 "2 guards holding the sterile corridor between the Admin Office and the apron",
                 "1 guard coordinating the hold with PortsToronto Security and the Site Contact"]),
    dict(file="PO10_Apron_Repaint.pdf", event="Apron II Line-Marking Repaint",
         sd="March 16 - 18, 2026", ed="March 18, 2026", days=["Mon", "Tue", "Wed"], st="2300", et="0500",
         coverage="Continuous", guards="7",
         ppe=["RAIC", "Radio", "Hi-Visibility Vest", "Safety Footwear", "Hard Hat", "Eye Protection", "Hearing Protection"],
         loc="Apron II – contractor staging by Gate 6", contact="Bartholomew Quigley-Stamatakis",
         phone="(416) 555-0233", bullet="•",
         leadin="Overnight airside boundary control around a live line-marking operation as follows:",
         duties=["3 guards on the apron boundary keeping the work zone clear of aircraft movements",
                 "2 guards on the contractor vehicle gate checking RAIC and escorting paint rigs",
                 "1 guard maintaining the cure-zone cordon so fresh markings are not driven over",
                 "1 guard on radio watch with Airport Operations for any movement holds"]),
    dict(file="PO11_Charity_FunRun.pdf", event="Runway Charity Fun Run",
         sd="Apr 5 2026", ed="Apr 5 2026", days=["Sun"], st="7 AM", et="11 AM",
         coverage="Specific Hours", guards="9",
         ppe=["Radio", "Hi-Visibility Vest", "Safety Footwear"],
         loc="South Apron muster (Gate 110)", contact="Yuki Tanaka-Okonkwo",
         phone="437.555.0102", bullet="-",
         leadin="Course marshalling and crowd safety for a closed-runway charity run as follows:",
         duties=["5 guards posted along the run course at the marked marshal points",
                 "2 guards at the start/finish corral managing participant flow",
                 "2 guards on roving patrol watching the spectator areas and first-aid tents"]),
    dict(file="PO12_Fuel_Farm_Maintenance.pdf", event="Fuel Farm Tank Inspection",
         sd="2026-03-23", ed="2026-03-27", days=["Mon", "Tue", "Wed", "Thu", "Fri"], st="0600", et="1800",
         coverage="Continuous", guards="15", guard_label="Number of Escorts/Guards:",
         ppe=["RAIC", "Radio", "Hi-Visibility Vest", "Safety Footwear", "Hard Hat", "Eye Protection", "Hearing Protection"],
         loc="Fuel Farm Compound – North gate", contact="Mehmet Çetinkaya",
         phone="(289) 555-0190", bullet="•",
         leadin="Continuous access control and hot-work fire watch around the fuel farm as follows:",
         duties=["4 guards on the fuel-farm fence line maintaining the exclusion zone",
                 "3 guards at the North gate logging and escorting all contractor entry",
                 "4 guards on rotating fire watch during hot-work windows",
                 "2 guards escorting fuel-bowser movements clear of the work area",
                 "2 guards on the spill-kit cordon monitoring the containment berm"]),
]

if __name__ == "__main__":
    for o in ORDERS:
        print("wrote", build(o))
    print(f"DONE — {len(ORDERS)} faithful post orders in", OUT)
