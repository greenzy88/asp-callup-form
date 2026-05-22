"""Mock-data rendering for autonomous mobile UX iteration.

Loads index.html via file://, bypasses MSAL by directly toggling appContent
visibility, injects fake orders, and screenshots the table view + detail
panel + upload card. Used when no real auth state is available (e.g., David
is on his phone and the playwright auth setup wasn't run).

Run: python test/mock_render.py
Output: test/screenshots/mock_*.png
"""
from __future__ import annotations
import time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INDEX = ROOT / "index.html"
SHOTS = HERE / "screenshots"

IPHONE_13 = {
    "viewport": {"width": 390, "height": 844},
    "device_scale_factor": 2,
    "is_mobile": True,
    "has_touch": True,
    "user_agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
        "Mobile/15E148 Safari/604.1"
    ),
}

def role_inject(role: str) -> str:
    """Return JS snippet that sets the right user + delegates to detectUserRole."""
    upn = {
        "admin":   "dramlagan@security-asp.com",
        "manager": "fmohammad@security-asp.com",
        "manager2": "pdeal@security-asp.com",  # Pat — same permissions as Farhad
        "client":  "atraining@security-asp.com",
    }[role]
    return f"""
      currentUserUpn = '{upn}';
      detectUserRole('{upn}');
    """


MOCK_INJECT_JS_TEMPLATE = r"""(roleJs) => {
  // Switch to authenticated view
  document.getElementById('authSection').style.display = 'none';
  document.getElementById('appContent').style.display = 'block';
  // Role-specific state + visibility
  eval(roleJs);

  // Fake orders covering varied lengths + statuses
  orders = [
    {OrderID:'TPO-2026-001', Event:'Crane lift over Pier 7',
     StartDate:'2026-06-01', EndDate:'2026-06-01',
     StartTime:'08:00', EndTime:'16:00',
     NumGuards:3, SiteContact:'John Smith',
     Status:'Pending', Archived:'No',
     PDFFilename:'TPO-2026-001_crane.pdf',
     PPERequired:'Hard Hat,Safety Vest,Steel Toe Boots'},
    {OrderID:'TPO-2026-002', Event:'High Mast Street Light Replacement',
     StartDate:'2026-06-15', EndDate:'2026-06-16',
     StartTime:'19:00', EndTime:'05:00',
     NumGuards:4, SiteContact:'Jane Doe',
     Status:'Scheduled', Archived:'No',
     PDFFilename:'TPO-2026-002_lights.pdf',
     PPERequired:'Hard Hat,Safety Vest'},
    {OrderID:'TPO-2026-003', Event:'MPTF Renovation',
     StartDate:'2026-07-10', EndDate:'2026-07-20',
     StartTime:'07:00', EndTime:'19:00',
     NumGuards:2, SiteContact:'Bob Wilson',
     Status:'Pending', Archived:'No',
     PDFFilename:'',
     PPERequired:''},
    {OrderID:'TPO-2026-004', Event:'Girls Take Flight 2026',
     StartDate:'2026-08-20', EndDate:'2026-08-20',
     StartTime:'10:00', EndTime:'18:00',
     NumGuards:6, SiteContact:'Sarah Chen',
     Status:'Scheduled', Archived:'No',
     PDFFilename:'TPO-2026-004_gtf.pdf',
     PPERequired:'Safety Vest'}
  ];
  statusHistory = [
    {OrderID:'TPO-2026-001', Status:'Pending', ChangedBy:'PDF Upload', Timestamp:'2026-05-15 10:30', Notes:'Order created from PDF upload'},
    {OrderID:'TPO-2026-002', Status:'Pending', ChangedBy:'PDF Upload', Timestamp:'2026-05-16 14:20', Notes:'Order created from PDF upload'},
    {OrderID:'TPO-2026-002', Status:'Scheduled', ChangedBy:'David', Timestamp:'2026-05-18 09:15', Notes:'Assigned guards from Saturday rotation'}
  ];

  renderTable();
  updateStats();
}"""


def shot(page, name: str, full: bool = True) -> Path:
    SHOTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    path = SHOTS / f"mock_{stamp}_{name}.png"
    page.screenshot(path=str(path), full_page=full)
    print(f"  -> {path.name}")
    return path


def render_role(role: str) -> None:
    file_url = f"file:///{str(INDEX).replace(chr(92), '/')}"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(**IPHONE_13)
        page = ctx.new_page()
        page.goto(file_url, wait_until="domcontentloaded", timeout=30_000)
        time.sleep(1.5)
        page.evaluate(MOCK_INJECT_JS_TEMPLATE, role_inject(role))
        time.sleep(0.5)

        print(f"  [{role}] screenshot: viewport top")
        shot(page, f"{role}_01_top", full=False)
        print(f"  [{role}] screenshot: full page")
        shot(page, f"{role}_02_full", full=True)

        # Click first order if there is one visible
        card = page.locator(".order-card").first
        if card.count() > 0 and card.is_visible():
            card.click()
            time.sleep(0.7)
            page.evaluate("document.getElementById('detailPanel').scrollIntoView({behavior:'instant', block:'start'})")
            time.sleep(0.4)
            print(f"  [{role}] screenshot: detail panel")
            shot(page, f"{role}_03_detail", full=False)
        b.close()


def main() -> None:
    for role in ("admin", "manager", "manager2", "client"):
        print(f"\nrendering as: {role}")
        render_role(role)
    print(f"\nDone. Review {SHOTS}/mock_*.png")


if __name__ == "__main__":
    main()
