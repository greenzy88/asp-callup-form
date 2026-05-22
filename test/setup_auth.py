"""One-time auth setup for autonomous mobile testing.

Run this BEFORE leaving the computer for a long stretch:
    python test/setup_auth.py

It opens a browser pre-sized to iPhone 13, navigates to the SWA URL, waits
for you to sign in with `dramlagan@security-asp.com`, then saves the full
browser state (cookies + MSAL tokens in localStorage) to test/storage_state.json.

After that, test/test_mobile.py can run autonomously for ~18 hours (until the
MSAL refresh token expires or is revoked).

NOTE: storage_state.json is gitignored — it contains the active session.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

SWA_URL = "https://delightful-bay-0e217b31e.7.azurestaticapps.net/"
HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "storage_state.json"

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


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(**IPHONE_13)
        page = context.new_page()
        print(f"Opening {SWA_URL} ...")
        page.goto(SWA_URL)

        print()
        print("=" * 60)
        print("ACTION REQUIRED:")
        print("  1. The browser window is open at iPhone 13 viewport size")
        print("  2. Click 'Sign in with Microsoft'")
        print("  3. Sign in as dramlagan@security-asp.com")
        print("  4. Complete MFA on your phone if prompted")
        print("  5. Wait until the call-up form is fully loaded")
        print("  6. Return here and press ENTER to save auth state")
        print("=" * 60)
        input(">>> Press ENTER when you are signed in and the form is visible: ")

        context.storage_state(path=str(STATE_FILE))
        print(f"\n[OK] Auth state saved to {STATE_FILE}")
        print(f"     ({STATE_FILE.stat().st_size:,} bytes)")
        print()
        print("You can close the browser now. Claude can test autonomously.")
        browser.close()


if __name__ == "__main__":
    main()
