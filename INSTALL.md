# Cascades Solo — install before you leave

**https://bhotchkies.github.io/cascades-solo/**

Elevation profile, water/camp/junction lookup, forecast + AQI, and fire status
for whichever route you pick. Works with no signal once installed — which
matters, since the whole point of a wilderness trip is no signal.

> **Do this at home, on wifi, before you drive out.**
> The app saves itself to your phone the first time you open it. A phone that
> has never opened it will show nothing on trail.

---

## iPhone / iPad

1. Open **https://bhotchkies.github.io/cascades-solo/** in Safari or Chrome.
2. Tap the **Share** button — the square with an arrow pointing up.
3. Scroll down and tap **Add to Home Screen**, then **Add**, top right.
4. **Open it once from the new home screen icon.** This is the step that saves
   it for offline use. Don't skip it.

## Android

1. Open **https://bhotchkies.github.io/cascades-solo/** in **Chrome**.
2. Tap the **⋮** menu, top right, then the install option (wording varies:
   **Install app**, **Add to Home screen**).
3. Tap **Install** on the popup that follows.
4. **Open it once from the new home screen icon.**

---

## Before you leave cell coverage

1. **Pick a route.** There's no in-app picker yet — the app opens on
   whichever route was last loaded. Once picked, stay on it: there's no
   mid-trip switching, and the map/forecast are keyed to one route.
2. **Tap Map → Download offline map.** This is a separate ~20 MB download
   from the app shell itself — do it on wifi. It only fetches the *active*
   route's tiles, so re-download if you switch routes before leaving.
3. Check the forecast, AQI, and fire sections have populated — they need one
   successful load with signal before they'll have anything to show offline.

## How to check it worked

Turn on airplane mode, open the app from the home screen icon, and open the
map. If the terrain tiles render and your last position shows, you're set.
Turn airplane mode back off before you actually leave.

---

## How to use it

**The elevation profile is the home screen.** Pan and zoom it like a map —
drag to pan, pinch or the +/− buttons to zoom, "Show whole route" to reset.
Tap any marker (water drop, tent, dot) for its name and any notes.

- **Next water / next camp** show the nearest two ahead of your position,
  not just the closest one — useful for planning past the first stop.
- **Next junction** shows where the trail forks next.
- **Visible climb** reflects whatever's currently on screen, not the whole
  route — pan or zoom to check a specific stretch.
- **Forecast** projects 3 days ahead from your measured pace (default
  2.2 mph × 8h/day if it hasn't measured you moving yet) — mile numbers are
  estimates, not a schedule.
- **Fire** section and the **Map**'s downloaded tiles are both ambient
  information. Neither is a safety tool — that's what Watch Duty is for.
- The **age badges** (forecast staleness, fire data staleness) tell you how
  old what you're looking at is. Green is fresh, amber is hours old, red is
  stale.

Water and campsite markers come from AllTrails' community waypoints, scraped
and clustered — real crowd reports, not verified by anyone. Treat them as
hints, not facts, especially water in late season.

---

## One honest note on the community waypoint data

The camp/water markers are unverified crowd reports pulled from AllTrails,
clustered by proximity. A report from 2018 sits next to one from last month
with no visual distinction beyond what the detail sheet shows. Water sources
especially can be seasonal — a report existing doesn't mean it's flowing now.
