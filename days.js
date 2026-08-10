// Day-boundary tracking. Deliberately NOT a new storage system — a "day"
// reuses geo.js's existing per-session-key fix cache, keyed by calendar
// date instead of the single hardcoded 'trip' key it used before. The
// first fix recorded under a given date's key becomes that day's start
// (mile + time); geo.js's own REBASE_MI logic (discarding a pre-departure
// tap at camp before you've actually moved) already does the right thing
// for "where did today's hiking start" without any new code here.
//
// Per Blair's call: he never hikes across a calendar-day boundary, so
// date-based reset is safe — see the app.js/geo.js session key wiring.

export function todayDateStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayDateStr(d);
}

// Decimal local hour-of-day (e.g. 6.5 = 6:30am) from a fix timestamp —
// used as computeDayTimeline's startHour/nowHour. Assumes the phone's own
// clock is trail-local time, which holds for an actual device on trail.
export function hourOfDay(epochMs) {
  const d = new Date(epochMs);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// Today's recorded start — { mi, t, confirmed } — or null if no fix has
// been taken yet today. `geo` is geo.js; sessionKey is today's date string.
export function getDayStart(geo, sessionKey) {
  const cache = geo.getFix(sessionKey);
  return cache?.base || null;
}

// Nominal start mile for a day `daysAhead` from today, projected forward
// from today's actual (or not-yet-started) position at the nominal daily
// mileage. Returns null if today has no recorded start at all (e.g. still
// at home before the trip) — callers fall back to a full-route view.
export function nominalDayStartMi(todayStartMi, daysAhead, milesPerDay) {
  if (todayStartMi == null) return null;
  return todayStartMi + daysAhead * milesPerDay;
}
