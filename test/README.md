# Self-testing for the call-up SWA

## One-time setup (David runs)

```bash
python test/setup_auth.py
```

Opens an iPhone-sized browser, you sign in as `dramlagan@security-asp.com`,
press ENTER in the terminal, done. Auth state is saved to
`test/storage_state.json` (gitignored).

Valid for ~18 hours (until MSAL refresh token expires).

## Autonomous test (Claude runs)

```bash
python test/test_mobile.py
```

Drives the live SWA at iPhone 13 viewport, uploads a sample PDF from your
Downloads folder, exercises the new admin Delete button, screenshots every
step into `test/screenshots/` (also gitignored).

Exit codes:
- 0 = pass
- 2 = auth state expired (re-run setup_auth.py)
- 3 = no orders appeared after upload
- 4 = delete button missing from DOM
- 5 = delete button hidden (admin gate failed)
