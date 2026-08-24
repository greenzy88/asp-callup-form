// GET /api/auth/status
// Returns whether the owner has completed /api/auth/setup. Used by
// the frontend to show a "needs owner re-auth" banner.

const { app } = require("@azure/functions");
const tokenStore = require("../shared/tokenStore");

app.http("authStatus", {
  route: "auth/status",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (_req, ctx) => {
    try {
      const t = await tokenStore.load();
      // CREDENTIAL FRESHNESS, so a silent decay is visible BEFORE it is fatal.
      //
      // 2026-08-24: the app died on AADSTS700082 — the owner refresh token had
      // been "inactive for 90.00:00:00". Before that moment the symptom was
      // nothing at all: every request succeeded until the one that did not,
      // and the 6-hourly canary deliberately never signs in, so it observed a
      // healthy site the whole way down.
      //
      // Nano-council, all three seats, and deepseek's why5 is what this is:
      // "a per-tick checker that reads the persisted owner token's own
      //  last-refresh/save timestamp and alarms when now - saved_at approaches
      //  the 90-day inactivity window; the value already lives in tokenStore,
      //  the 6-hourly tick already runs, and the check requires NO SIGN-IN, so
      //  it does not violate the owner's rule."
      //
      // It also guards the rotation fix itself. With rotation working,
      // capturedAt is rewritten on every refresh and ageDays stays near zero.
      // If rotation ever regresses, this goes stale and warns weeks before
      // Entra kills the credential — the alarm for the bug AND for its fix.
      const MAX_INACTIVE_DAYS = 90;   // Entra's window, from the AADSTS700082 text
      const WARN_AT_DAYS = 60;        // 30 days of runway to re-run /api/auth/setup
      let ageDays = null;
      if (t && t.capturedAt) {
        const ms = Date.now() - new Date(t.capturedAt).getTime();
        if (Number.isFinite(ms) && ms >= 0) ageDays = +(ms / 86_400_000).toFixed(2);
      }
      return {
        status: 200,
        jsonBody: {
          ready: !!(t && t.refreshToken),
          capturedBy: t ? t.capturedBy : null,
          capturedAt: t ? t.capturedAt : null,
          ageDays,
          maxInactiveDays: MAX_INACTIVE_DAYS,
          // null when there is no timestamp to judge — "unknown" must never
          // render as "fine", which is how the 90 days passed unremarked.
          stale: ageDays === null ? null : ageDays >= WARN_AT_DAYS,
          expiresInDays:
            ageDays === null ? null : +(MAX_INACTIVE_DAYS - ageDays).toFixed(2),
        },
      };
    } catch (e) {
      ctx.error("authStatus failed:", e);
      return { status: 500, jsonBody: { error: e.message } };
    }
  },
});
