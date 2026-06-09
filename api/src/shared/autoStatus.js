// Pure logic for the time-based auto-status engine (no I/O — unit-testable).
// All call-up times are America/Toronto wall-clock. The cron (cronTick.js)
// passes each order + the current time and acts on the returned decision.
//
// Anchor = order START datetime (StartDate "YYYY-MM-DD" + StartTime). Let
// start = that instant, X = start + 8h, W = start - 8h.
//   WARN     : now in [W, start)   AND Status "Pending"   AND !NotifiedStartingSoon
//   EXPIRE   : now in [start, X)   AND Status "Scheduled" AND !NotifiedExpiry
//   COMPLETE : now in [X, X+GRACE) AND Status "Scheduled"
// Orders with an unparseable/blank StartTime are SKIPPED (fail safe — never fire).

const EIGHT_H_MS = 8 * 60 * 60 * 1000;
const GRACE_MS = 48 * 60 * 60 * 1000; // tolerate up to a 2-day cron outage for COMPLETE

// Offset (ms) of America/Toronto from UTC at a given UTC instant. Positive west
// of UTC would be negative; Toronto is UTC-5 (EST) / UTC-4 (EDT) so this returns
// a NEGATIVE number. Uses Intl (built in to Node) — no external tz library.
function torontoOffsetMs(utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const hh = p.hour === "24" ? 0 : Number(p.hour); // some ICU builds emit "24" for midnight
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh, Number(p.minute), Number(p.second));
  return asIfUtc - utcMs;
}

// Convert a Toronto wall-clock (y, mo[1-12], d, h, mi) to a UTC epoch ms.
// Standard two-step offset probe. Correct for all instants except the one
// ambiguous repeated hour at the autumn DST fall-back (a call-up starting
// 01:00-01:59 on the November transition would resolve to standard time — an
// accepted edge; security call-ups do not start at 1:30am on that one night).
function torontoWallClockToUTC(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = torontoOffsetMs(guess);
  return guess - off;
}

// Parse a StartTime string -> {h, m} or null. Handles "HH:MM", "H:MM AM/PM",
// "HHMM" (24h). Anything else (blank, "See PDF", garbage) -> null.
function parseTime(s) {
  if (s === undefined || s === null) return null;
  const str = String(s).trim();
  if (!str) return null;
  let m = str.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2]);
    const ap = m[3] ? m[3].toLowerCase() : "";
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return { h, m: mi };
  }
  m = str.match(/^(\d{2})(\d{2})$/); // HHMM
  if (m) {
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return { h, m: mi };
  }
  return null;
}

// Compute the start instant (UTC epoch ms) from StartDate + StartTime, or null
// if either is missing/unparseable (-> the order is skipped by decideAction).
function parseStartInstant(startDate, startTime) {
  if (!startDate) return null;
  const dm = String(startDate).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const t = parseTime(startTime);
  if (!t) return null;
  return torontoWallClockToUTC(Number(dm[1]), Number(dm[2]), Number(dm[3]), t.h, t.m);
}

function _truthy(v) {
  return v === true || v === 1 ||
    ["true", "1", "yes", "y"].includes(String(v == null ? "" : v).trim().toLowerCase());
}

// Decide the action for one order at time nowMs. Returns one of:
//   { action: "warn" }      -> 8h-before-start advisory (Pending)
//   { action: "expire" }    -> at-start notice, will auto-complete in 8h (Scheduled)
//   { action: "complete" }  -> auto-set Completed (Scheduled, >=8h past start)
//   { action: "skip", reason } -> unparseable/blank start
//   { action: "none" }      -> nothing to do this tick
function decideAction(order, nowMs) {
  const status = String(order && order.Status != null ? order.Status : "").trim();
  const start = parseStartInstant(order && order.StartDate, order && order.StartTime);
  if (start == null) return { action: "skip", reason: "no-start-instant" };
  const X = start + EIGHT_H_MS;
  const W = start - EIGHT_H_MS;
  if (status === "Pending" && nowMs >= W && nowMs < start && !_truthy(order.NotifiedStartingSoon)) {
    return { action: "warn", start, X };
  }
  if (status === "Scheduled" && nowMs >= start && nowMs < X && !_truthy(order.NotifiedExpiry)) {
    return { action: "expire", start, X };
  }
  if (status === "Scheduled" && nowMs >= X && nowMs < X + GRACE_MS) {
    return { action: "complete", start, X };
  }
  return { action: "none" };
}

module.exports = {
  EIGHT_H_MS, GRACE_MS,
  torontoOffsetMs, torontoWallClockToUTC, parseTime, parseStartInstant, decideAction,
};
