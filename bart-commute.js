// BART Commute widget for Scriptable (iOS)
// Next trains at whichever of your two stations is nearer, in the direction you'd go:
//   24th St Mission -> northbound (downtown)    Montgomery St -> southbound (Mission)
// Flags *headway* problems: are trains spaced further apart than the schedule says
// they should be right now? Checks your return trip too. Per-train "delay" is ignored.

// ---------- config ----------
const KEY = "MW9S-E7SL-26DU-VV8V"; // BART's public key
const STATIONS = {
  "24TH": { name: "24th St", dir: "n", label: "→ downtown", lat: 37.7522, lon: -122.4184 },
  "MONT": { name: "Montgomery", dir: "s", label: "→ Mission", lat: 37.7894, lon: -122.4011 },
};
const MAX_TRAINS = 4;
const GAP_SLACK_MIN = 3;     // flag only if worst real gap exceeds worst scheduled gap by this much
const FALLBACK_GAP_MIN = 10; // if the schedule can't be loaded, flag gaps at least this long
const LOOKAHEAD_MAX = 40;    // never look further ahead than this (minutes)
// -----------------------------

const fam = config.widgetFamily;
const isLock = fam && fam.startsWith("accessory");

// How the station was chosen, shown in small print so you can tell:
//   "📍" live location · "📍~" last known location · "🕐" time-of-day guess · "📌" pinned
let PICKED_BY = "";

function nearest(lat, lon) {
  let best = null, bestD = Infinity;
  for (const [code, s] of Object.entries(STATIONS)) {
    const d = Math.hypot(lat - s.lat, (lon - s.lon) * Math.cos(s.lat * Math.PI / 180));
    if (d < bestD) { bestD = d; best = code; }
  }
  return best;
}

async function pickStation() {
  const p = (args.widgetParameter || "").trim().toUpperCase();
  if (STATIONS[p]) { PICKED_BY = "📌"; return p; }

  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.documentsDirectory(), "bart-last-location.json");

  // 1. Live location (with a timeout: widgets get very little time to run)
  try {
    Location.setAccuracyToKilometer(); // coarse is plenty to tell 24th from Montgomery, and much faster
    const loc = await Promise.race([
      Location.current(),
      new Promise((_, rej) => Timer.schedule(6000, false, () => rej(new Error("timeout")))),
    ]);
    fm.writeString(cachePath, JSON.stringify({ lat: loc.latitude, lon: loc.longitude, t: Date.now() }));
    PICKED_BY = "📍";
    return nearest(loc.latitude, loc.longitude);
  } catch (e) {}

  // 2. Last known location, if recent (< 45 min)
  try {
    if (fm.fileExists(cachePath)) {
      const c = JSON.parse(fm.readString(cachePath));
      if (Date.now() - c.t < 45 * 60 * 1000) { PICKED_BY = "📍~"; return nearest(c.lat, c.lon); }
    }
  } catch (e) {}

  // 3. Guess: early on a weekday you're probably at 24th; otherwise downtown
  PICKED_BY = "🕐";
  const now = new Date();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  return weekday && now.getHours() >= 4 && now.getHours() < 10 ? "24TH" : "MONT";
}

async function getJSON(url) {
  const r = new Request(url);
  r.timeoutInterval = 10;
  return await r.loadJSON();
}

// ---------- live departures ----------
async function fetchDepartures(code) {
  const s = STATIONS[code];
  const j = await getJSON(`https://api.bart.gov/api/etd.aspx?cmd=etd&orig=${code}&dir=${s.dir}&key=${KEY}&json=y`);
  const etds = (j.root.station && j.root.station[0] && j.root.station[0].etd) || [];
  const trains = [];
  let horizon = LOOKAHEAD_MAX; // how far ahead we can see *every* line
  for (const e of etds) {
    let lastForDest = 0;
    for (const est of e.estimate) {
      const mins = est.minutes === "Leaving" ? 0 : parseInt(est.minutes, 10);
      if (isNaN(mins)) continue;
      lastForDest = Math.max(lastForDest, mins);
      trains.push({
        dest: e.destination, mins, cars: est.length, color: est.hexcolor,
        platform: String(est.platform || ""), dynamic: est.dynamicflag === "1",
      });
    }
    // BART lists ~3 trains per destination; beyond a line's last listed train we're blind,
    // so a "gap" there would be fake. Only measure gaps inside the window all lines cover.
    if (lastForDest > 0) horizon = Math.min(horizon, lastForDest);
  }
  trains.sort((a, b) => a.mins - b.mins || (a.dynamic - b.dynamic));
  // Two trains can't leave the same platform in the same minute. BART sometimes lists an extra
  // "dynamic" (unscheduled) prediction alongside a real one; keep the first (non-dynamic preferred).
  const seen = new Set();
  const deduped = trains.filter(t => {
    const k = `${t.platform}|${t.mins}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const platforms = [...new Set(deduped.map(t => t.platform).filter(Boolean))];
  return { trains: deduped, horizon, platforms };
}

// Largest spacing between consecutive trains within [0, horizon], including the wait for the first one
function maxGap(minsList, horizon) {
  const m = minsList.filter(x => x <= horizon).sort((a, b) => a - b);
  if (!m.length) return null;
  let g = m[0];
  for (let i = 1; i < m.length; i++) g = Math.max(g, m[i] - m[i - 1]);
  return g;
}

// ---------- schedule baseline (cached per station per day) ----------
function parseClock(t) { // "07:12 AM" / "7:12 PM" -> minutes since midnight
  const x = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(t || "");
  if (!x) return null;
  let h = parseInt(x[1], 10) % 12;
  if (/pm/i.test(x[3])) h += 12;
  return h * 60 + parseInt(x[2], 10);
}
const field = (o, k) => o["@" + k] !== undefined ? o["@" + k] : o[k];

async function scheduledTimes(code, platforms) {
  if (!platforms || !platforms.length) return [];
  const fm = FileManager.local();
  const d = new Date();
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; // local date
  const path = fm.joinPath(fm.cacheDirectory(), `bart-sched-v2-${code}-${platforms.sort().join("")}-${today}.json`);
  if (fm.fileExists(path)) {
    try { return JSON.parse(fm.readString(path)); } catch (e) {}
  }
  const j = await getJSON(`https://api.bart.gov/api/sched.aspx?cmd=stnsched&orig=${code}&key=${KEY}&json=y`);
  let items = (j.root.station && j.root.station.item) || [];
  if (!Array.isArray(items)) items = [items];
  const times = items
    .filter(it => {
      const pl = String(field(it, "platform") || "").replace(/\D/g, "");
      return platforms.includes(pl);
    })
    .map(it => parseClock(field(it, "origTime")))
    .filter(t => t !== null)
    .sort((a, b) => a - b);
  if (times.length) fm.writeString(path, JSON.stringify(times));
  return times;
}

// Worst scheduled gap over the same window we can see live
async function scheduledMaxGap(code, horizon, platforms) {
  try {
    const times = await scheduledTimes(code, platforms);
    if (!times.length) return null;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const rel = times.map(t => t - nowMin).filter(d => d >= 0);
    return maxGap(rel, horizon);
  } catch (e) { return null; }
}

// Headway verdict for one station/direction
async function headway(code) {
  const { trains, horizon, platforms } = await fetchDepartures(code);
  const live = maxGap(trains.map(t => t.mins), horizon);
  const sched = await scheduledMaxGap(code, horizon, platforms);
  let bad = false;
  if (live !== null) {
    bad = sched !== null ? live >= sched + GAP_SLACK_MIN : live >= FALLBACK_GAP_MIN;
  }
  return { code, trains, live, sched, bad };
}

// ---------- advisories: only current + on your route ----------
const ROUTE_RE = /24th|16th|civic cent|powell|montgomery|embarcadero|downtown s\.?f|san francisco|\bSF\b|transbay|tube|system[- ]?wide|all (lines|stations|trains)|entire system/i;
const FUTURE_RE = /this weekend|next week|next weekend|tomorrow|starting|beginning|will (be|begin|start|run|close)|planned|scheduled|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\d{1,2}\/\d{1,2}/i;
const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

function isCurrentAndOnRoute(text) {
  if (!ROUTE_RE.test(text) || FUTURE_RE.test(text)) return false;
  const today = DAYS[new Date().getDay()];
  if (DAYS.some(d => d !== today && new RegExp(`\\b${d}`, "i").test(text))) return false;
  if (/tonight/i.test(text) && new Date().getHours() < 17) return false;
  return true;
}

async function fetchAdvisories() {
  try {
    const j = await getJSON(`https://api.bart.gov/api/bsa.aspx?cmd=bsa&key=${KEY}&json=y`);
    return (j.root.bsa || [])
      .map(b => (b.description && (b.description["#cdata-section"] || b.description)) || "")
      .filter(d => d && !/no delays reported/i.test(d))
      .filter(isCurrentAndOnRoute);
  } catch (e) { return []; }
}

// ---------- rendering ----------
function shortDest(d) {
  return d
    .replace("San Francisco International Airport", "SFO")
    .replace("SF Airport", "SFO")
    .replace("Dublin/Pleasanton", "Dublin")
    .replace("Pittsburg/Bay Point", "Bay Point")
    .replace("Berryessa/North San Jose", "Berryessa");
}
// BART's white (unassigned) and yellow lines are invisible on a light background
function lineColor(hex) {
  const h = (hex || "").toLowerCase();
  if (!h || h === "#ffffff") return Color.dynamic(new Color("#b0b0b0"), new Color("#ffffff"));
  if (h === "#ffff33") return Color.dynamic(new Color("#e0b800"), new Color("#ffff33"));
  return new Color(h);
}
const fmtMins = m => (m === 0 ? "now" : `${m}`);
const gapText = h => `up to ${h.live}m` + (h.sched !== null ? ` (usual ${h.sched})` : "");

async function build() {
  const code = await pickStation();
  const other = code === "24TH" ? "MONT" : "24TH";
  const s = STATIONS[code];
  const [out, back, advisories] = await Promise.all([
    headway(code),
    headway(other).catch(() => null),
    fetchAdvisories(),
  ]);
  const trains = out.trains;
  const slow = out.bad || (back && back.bad);
  // ⏱ = trains spaced wider than scheduled; ⚠︎ = a BART alert on your route
  const icon = slow ? "⏱ " : advisories.length ? "⚠︎ " : "";

  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 60 * 1000);
  // No w.url: tapping the widget opens Scriptable and re-runs the script

  if (fam === "accessoryInline") {
    const mins = trains.slice(0, 3).map(t => fmtMins(t.mins)).join(", ");
    w.addText(`${icon}${s.name}: ${mins || "—"} min`);
    return w;
  }

  if (isLock) {
    const h = w.addText(`${icon}${s.name} ${s.label}`);
    h.font = Font.boldSystemFont(13); h.lineLimit = 1;
    const mins = trains.slice(0, 4).map(t => fmtMins(t.mins)).join(" · ");
    const m = w.addText(mins ? `${mins} min` : "No trains");
    m.font = Font.boldMonospacedSystemFont(17); m.lineLimit = 1;
    let line3 = "";
    if (out.bad) line3 = "⏱ " + gapText(out);
    else if (back && back.bad) line3 = `⏱ Return: ${gapText(back)}`;
    else if (advisories.length) line3 = advisories[0];
    else if (trains[0]) line3 = `${shortDest(trains[0].dest)} · ${trains[0].cars} car`;
    if (line3) { const d = w.addText(line3); d.font = Font.systemFont(11); d.lineLimit = 1; }
    return w;
  }

  // Home screen / in-app
  w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e"));
  const fg = Color.dynamic(Color.black(), Color.white());
  const title = w.addText(`${s.name} ${s.label}`);
  title.font = Font.boldSystemFont(14); title.textColor = fg;
  w.addSpacer(6);

  const n = fam === "small" ? 3 : MAX_TRAINS;
  if (!trains.length) { const t = w.addText("No departures"); t.textColor = fg; }
  for (const t of trains.slice(0, n)) {
    const row = w.addStack(); row.centerAlignContent();
    const dot = row.addText("●"); dot.textColor = lineColor(t.color); dot.font = Font.systemFont(10);
    row.addSpacer(4);
    const dest = row.addText(shortDest(t.dest)); dest.font = Font.systemFont(13); dest.textColor = fg; dest.lineLimit = 1;
    row.addSpacer();
    const m = row.addText(t.mins === 0 ? "now" : `${t.mins} min`);
    m.font = Font.boldMonospacedSystemFont(13); m.textColor = fg;
    w.addSpacer(3);
  }

  const notes = [];
  if (out.bad) notes.push("⏱ " + gapText(out));
  if (back && back.bad) notes.push(`⏱ Return ${STATIONS[other].label}: ${gapText(back)}`);
  if (advisories.length) notes.push("⚠︎ " + advisories[0]);
  if (notes.length) {
    w.addSpacer(4);
    const shown = fam === "small" ? notes.slice(0, 1) : notes.slice(0, 2);
    for (const nt of shown) {
      const a = w.addText(nt); a.font = Font.systemFont(10); a.textColor = Color.orange(); a.lineLimit = 2;
    }
  }

  w.addSpacer();
  const foot = w.addStack();
  const ts = foot.addDate(new Date()); ts.applyTimeStyle();
  ts.font = Font.systemFont(9); ts.textColor = Color.gray();
  foot.addSpacer(4);
  const pb = foot.addText(PICKED_BY); pb.font = Font.systemFont(9); pb.textColor = Color.gray();
  return w;
}

let widget;
try {
  widget = await build();
} catch (e) {
  widget = new ListWidget();
  widget.addText("BART: couldn't load");
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
