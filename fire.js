// Fire status — reads data/fire.json, which tools/fetch_fire.js regenerates
// hourly via .github/workflows/fire.yml. Ambient information only: nothing
// in this app gates a route or bail decision on it. Watch Duty remains the
// safety layer.
//
// sw.js excludes /data/ from its cache (see that file), so this always
// tries the network first and only sees a cached copy if the browser's own
// HTTP cache serves one — same posture as forecast.js.

export async function fetchFireData() {
  const res = await fetch('./data/fire.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Two clocks matter here, not one: how long ago THIS device fetched the
// file (network health), and how long ago the Action actually generated it
// (whether the Action is still running at all). A device with perfect
// signal but a dead Action would otherwise look falsely fresh.
export function fireStaleness(generatedAt) {
  if (!generatedAt) return { cls: '', text: 'No fire data yet' };
  const hrs = Math.round((Date.now() - new Date(generatedAt).getTime()) / 3_600_000);
  if (hrs < 2) return { cls: 'green', text: `Fire data as of ${hrs === 0 ? '<1' : hrs} h ago` };
  if (hrs < 6) return { cls: 'amber', text: `Fire data as of ${hrs} h ago` };
  return { cls: 'red', text: `Fire data STALE — ${hrs} h old` };
}
