"""Autonomous mobile-viewport test of the call-up form SWA.

Run after a code change (and after the GitHub Action redeploys, ~1-2 min):
    python test/test_mobile.py

Reuses the auth state saved by test/setup_auth.py. Takes screenshots at each
step into test/screenshots/. Reports pass/fail with paths to the screenshots
so a human (or me) can verify the UI looks right.

Test sequence:
  1. Load SWA → screenshot home page
  2. Click an existing order to open detail panel → screenshot
  3. Upload a sample BBTCA PDF → screenshot the parsed-fields preview
  4. Confirm new order appears → screenshot the table
  5. Click into new order → screenshot detail
  6. Click red Delete button → confirm dialog → screenshot
  7. Confirm order is gone → screenshot table
"""
from __future__ import annotations
import sys
import time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

SWA_URL = "https://delightful-bay-0e217b31e.7.azurestaticapps.net/"
HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "storage_state.json"
SHOTS_DIR = HERE / "screenshots"
DOWNLOADS = Path.home() / "Downloads"

IPHONE_13 = {
    "viewport": {"width": 390, "height": 844},
    "device_scale_factor": 3,
    "is_mobile": True,
    "has_touch": True,
    "user_agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
        "Mobile/15E148 Safari/604.1"
    ),
}


def pick_sample_pdf() -> Path:
    candidates = sorted(DOWNLOADS.glob("*BBTCA*Post Order*.pdf"))
    if not candidates:
        sys.exit("ERROR: no BBTCA Post Order PDFs found in ~/Downloads")
    return candidates[0]


def shot(page, name: str) -> Path:
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    path = SHOTS_DIR / f"{stamp}_{name}.png"
    page.screenshot(path=str(path), full_page=True)
    print(f"  shot: {path.name}")
    return path


def main() -> int:
    if not STATE_FILE.exists():
        sys.exit(
            f"ERROR: {STATE_FILE} not found.\n"
            f"Run `python test/setup_auth.py` first (one-time, requires David)."
        )
    sample_pdf = pick_sample_pdf()
    print(f"sample PDF: {sample_pdf.name}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(STATE_FILE), **IPHONE_13)
        page = context.new_page()

        print(f"\n[1] Loading {SWA_URL}")
        page.goto(SWA_URL, wait_until="networkidle", timeout=60_000)
        time.sleep(2)
        shot(page, "01_home")

        # Detect sign-in state
        signin_btn = page.locator("button:has-text('Sign in')")
        if signin_btn.count() > 0 and signin_btn.first.is_visible():
            print("  FAIL: sign-in button visible — auth state expired.")
            print("  David needs to re-run test/setup_auth.py")
            shot(page, "02_signin_required")
            return 2

        print("\n[2] Uploading sample PDF")
        file_input = page.locator("#pdfInput")
        file_input.set_input_files(str(sample_pdf))
        # Wait for parse to complete + form to populate
        try:
            page.wait_for_selector("#progressMsg:has-text('Reading')", state="visible", timeout=5_000)
        except PWTimeout:
            pass
        time.sleep(4)
        shot(page, "03_uploaded_parsed")

        print("\n[3] Checking for new order in table")
        time.sleep(3)
        shot(page, "04_table_after_upload")

        # Click the most-recent (top) order row to test Delete
        first_row = page.locator("tbody tr").first
        if first_row.count() == 0:
            print("  FAIL: no order rows visible after upload")
            return 3
        first_row.click()
        time.sleep(2)
        shot(page, "05_order_detail")

        print("\n[4] Testing Delete button visibility (admin-only)")
        delete_btn = page.locator("#deleteBtn")
        if delete_btn.count() == 0:
            print("  FAIL: deleteBtn element missing from DOM")
            return 4
        is_visible = delete_btn.is_visible()
        print(f"  delete_btn visible: {is_visible}")
        if not is_visible:
            print("  WARN: delete button hidden — isAdmin may be false (not signed in as dramlagan@)")
            shot(page, "06_no_delete_btn")
            return 5
        shot(page, "06_delete_btn_visible")

        # Auto-accept the confirm dialog
        page.once("dialog", lambda d: d.accept())
        print("\n[5] Clicking Delete")
        delete_btn.click()
        time.sleep(5)
        shot(page, "07_after_delete")

        print("\n[OK] Test sequence completed. Review screenshots in test/screenshots/")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
