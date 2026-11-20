// Nearest Ride — Scriptable widget
// Finds the closest rentable ELECTRIC bike or scooter across
// Lyft (Bay Wheels), Lime and Spin, using their public GBFS feeds.
// Tap the widget to open the app that has the closest vehicle.
//
// Works as: small / medium home screen widget, or rectangular lock screen widget.

// ---------- config ----------
const FEEDS = {
  Lyft: "https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json",
  Lime: "https://data.lime.bike/api/partners/v2/gbfs/san_francisco/gbfs.json",
  Spin: "https://mds.bird.co/gbfs/v2/public/provider/spin/san_francisco/gbfs.json",
};

// What tapping opens. If one of these doesn't launch the app on your phone,
// set USE_SHORTCUTS = true and make three one-step Shortcuts ("Open App")
// named "Open Lyft", "Open Lime", "Open Spin".
const USE_SHORTCUTS = false;
const APP_URLS = {
  Lyft: "lyft://",
  Lime: "lime://",
  Spin: "spin://",
};

// Used when the phone can't get a location (or widget parameter = "home").
const HOME = { latitude: 37.74422, longitude: -122.41805, label: "47 Prospect" };
const LOCATION_TIMEOUT_S = 8;
const OVERPASS = [  // OpenStreetMap query servers, tried in order
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const FLAT_FT = 5;          // elevation changes smaller than this show as flat

const MIN_RANGE_M = 1500;   // skip vehicles reporting less than ~1 mile of charge
const WALK_M_PER_MIN = 80;  // ~3 mph walking pace
const COLORS = { Lyft: "#FF00BF", Lime: "#00DD00", Spin: "#FF5436" };

// ---------- helpers ----------
async function getJSON(url) {
  const r = new Request(url);
  r.timeoutInterval = 10;
  r.headers = { "User-Agent": "Scriptable-NearestRide/1.0" };
  return await r.loadJSON();
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Compass direction from (lat1,lon1) to (lat2,lon2), 8-point
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

function fmtDist(m) {
  const ft = m * 3.28084;
  if (ft < 528) return `${Math.round(ft / 10) * 10} ft`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

function fmtWalk(m) {
  return `${Math.max(1, Math.round(m / WALK_M_PER_MIN))} min walk`;
}

function feedUrl(discovery, name) {
  const data = discovery.data || {};
  const lang = data.en || data[Object.keys(data)[0]] || {};
  const f = (lang.feeds || []).find(x => x.name === name);
  return f ? f.url : null;
}

// Map vehicle_type_id -> {electric, kind}
function parseTypes(vt) {
  const map = {};
  for (const t of (vt?.data?.vehicle_types || [])) {
    map[t.vehicle_type_id] = {
      electric: t.propulsion_type && t.propulsion_type !== "human",
      kind: (t.form_factor || "").includes("scooter") ? "scooter" : "bike",
    };
  }
  return map;
}

// Returns a list of candidate vehicles: {op, lat, lon, kind, rangeM, docked}
async function loadOperator(op, discoveryUrl) {
  const disc = await getJSON(discoveryUrl);
  const fbsUrl = feedUrl(disc, "free_bike_status") || feedUrl(disc, "vehicle_status");
  const vtUrl = feedUrl(disc, "vehicle_types");

  const [fbs, vt] = await Promise.all([
    fbsUrl ? getJSON(fbsUrl) : null,
    vtUrl ? getJSON(vtUrl).catch(() => null) : null,
  ]);
  const types = parseTypes(vt);
  const out = [];

  for (const b of (fbs?.data?.bikes || fbs?.data?.vehicles || [])) {
    if (b.is_disabled || b.is_reserved) continue;
    const t = types[b.vehicle_type_id];
    // No type info → only trust it if the operator is all-electric (Lime, Spin)
    const electric = t ? t.electric : op !== "Lyft";
    if (!electric) continue;
    if (b.current_range_meters != null && b.current_range_meters < MIN_RANGE_M) continue;
    if (b.lat == null || b.lon == null) continue;
    out.push({
      op, lat: b.lat, lon: b.lon,
      kind: t ? t.kind : (op === "Lyft" ? "bike" : "scooter"),
      rangeM: b.current_range_meters, docked: false,
    });
  }

  // Bay Wheels also has e-bikes sitting in docks
  if (op === "Lyft") {
    const siUrl = feedUrl(disc, "station_information");
    const ssUrl = feedUrl(disc, "station_status");
    if (siUrl && ssUrl) {
      const [si, ss] = await Promise.all([getJSON(siUrl), getJSON(ssUrl)]);
      const loc = {};
      for (const s of (si?.data?.stations || [])) loc[s.station_id] = s;
      const eIds = Object.keys(types).filter(k => types[k].electric);
      for (const s of (ss?.data?.stations || [])) {
        if (!s.is_renting) continue;
        let n = s.num_ebikes_available;
        if (n == null && s.vehicle_types_available) {
          n = s.vehicle_types_available
            .filter(v => eIds.includes(v.vehicle_type_id))
            .reduce((a, v) => a + (v.count || 0), 0);
        }
        const info = loc[s.station_id];
        if (!n || !info) continue;
        out.push({ op, lat: info.lat, lon: info.lon, kind: "bike",
          rangeM: null, docked: true, count: n, station: info.name });
      }
    }
  }
  return out;
}

function openUrl(op) {
  return USE_SHORTCUTS
    ? `shortcuts://run-shortcut?name=${encodeURIComponent("Open " + op)}`
    : APP_URLS[op];
}

// Errors from the extra lookups; shown at the bottom when you run the script in the app.
const DIAG = [];
function note(where, e) { DIAG.push(`${where}: ${String(e && e.message || e).slice(0, 80)}`); }

// Elevation in meters for a list of {latitude, longitude}.
// Open-Meteo (one call, ~90 m terrain model); falls back to USGS (one call per point, ~10 m model).
async function elevations(points) {
  try {
    const lat = points.map(p => p.latitude.toFixed(5)).join(",");
    const lon = points.map(p => p.longitude.toFixed(5)).join(",");
    const j = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (Array.isArray(j.elevation) && j.elevation.length === points.length) return j.elevation;
    throw new Error(JSON.stringify(j).slice(0, 60));
  } catch (e) {
    note("open-meteo", e);
    return await Promise.all(points.map(async p => {
      try {
        const j = await getJSON(`https://epqs.nationalmap.gov/v1/json?x=${p.longitude}&y=${p.latitude}&units=Meters&wkid=4326`);
        const v = parseFloat(j.value);
        return isNaN(v) || v < -100 ? null : v;
      } catch (e2) { note("usgs", e2); return null; }
    }));
  }
}

function fmtElev(ft) {
  if (ft == null || isNaN(ft)) return "";
  if (Math.abs(ft) < FLAT_FT) return "↔️ flat";
  return `${ft > 0 ? "⬆️" : "⬇️"}${Math.round(Math.abs(ft))} ft`;
}

function shortStreet(name) {
  return name
    .replace(/\s+(Street|St|Avenue|Ave|Boulevard|Blvd|Place|Pl|Terrace|Way|Lane|Ln|Road|Rd|Drive|Dr|Court|Ct|Alley|Plaza)\.?$/i, "")
    .trim();
}

// Distance in meters from point p to segment a-b (small-area flat approximation)
function segDist(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320, m = 110540;
  const ax = (a.lon - p.lon) * k, ay = (a.lat - p.lat) * m;
  const bx = (b.lon - p.lon) * k, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// "Prospect @ Coso": the street the vehicle is on, plus the nearest cross street (OpenStreetMap)
async function crossStreet(lat, lon) {
  try {
    const q = `[out:json][timeout:8];way(around:150,${lat},${lon})[highway~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"][name];(._;>;);out body;`;
    let j = null;
    for (const host of OVERPASS) {
      try {
        const r = new Request(host + "?data=" + encodeURIComponent(q));
        r.timeoutInterval = 8;
        r.headers = { "User-Agent": "Scriptable-NearestRide/1.0 (github.com/tlozoot/bart-widget)" };
        const t = await r.loadString();
        if (r.response.statusCode !== 200) throw new Error(`HTTP ${r.response.statusCode}`);
        j = JSON.parse(t);
        break;
      } catch (e) { note(host.split("/")[2], e); }
    }
    if (!j) throw new Error("all Overpass servers failed");
    const nodes = {}, namesAt = {};
    for (const e of j.elements) if (e.type === "node") nodes[e.id] = e;
    const ways = j.elements.filter(e => e.type === "way");
    const p = { lat, lon };
    let main = null, mainD = Infinity;
    for (const w of ways) {
      const nm = shortStreet(w.tags.name);
      for (let i = 0; i < w.nodes.length; i++) {
        (namesAt[w.nodes[i]] = namesAt[w.nodes[i]] || new Set()).add(nm);
        if (i === 0) continue;
        const a = nodes[w.nodes[i - 1]], b = nodes[w.nodes[i]];
        if (!a || !b) continue;
        const d = segDist(p, a, b);
        if (d < mainD) { mainD = d; main = nm; }
      }
    }
    if (!main) throw new Error(`no streets in ${ways.length} ways`);
    let cross = null, crossD = Infinity;
    for (const [id, set] of Object.entries(namesAt)) {
      if (!set.has(main) || set.size < 2 || !nodes[id]) continue;
      const d = haversine(lat, lon, nodes[id].lat, nodes[id].lon);
      if (d < crossD) { crossD = d; cross = [...set].find(n => n !== main); }
    }
    return cross ? `${main} @ ${cross}` : main;
  } catch (e) {
    note("cross st", e);
    try {
      const g = await Location.reverseGeocode(lat, lon);
      return g && g[0] && g[0].thoroughfare ? shortStreet(g[0].thoroughfare) : null;
    } catch (e2) { return null; }
  }
}

async function currentLocation() {
  if ((args.widgetParameter || "").trim().toLowerCase() === "home") return null;
  Location.setAccuracyToHundredMeters();
  const timeout = new Promise(res => Timer.schedule(LOCATION_TIMEOUT_S * 1000, false, () => res(null)));
  try { return await Promise.race([Location.current(), timeout]); } catch (e) { return null; }
}

// ---------- main ----------
let here = await currentLocation(), err = null, atHome = false;
if (!here) { here = HOME; atHome = true; }

const nearestByOp = {};
if (here) {
  const results = await Promise.allSettled(
    Object.entries(FEEDS).map(([op, url]) => loadOperator(op, url))
  );
  results.forEach((r, i) => {
    const op = Object.keys(FEEDS)[i];
    if (r.status !== "fulfilled") { nearestByOp[op] = { op, failed: true }; return; }
    let best = null;
    for (const v of r.value) {
      v.dist = haversine(here.latitude, here.longitude, v.lat, v.lon);
      v.dir = bearing(here.latitude, here.longitude, v.lat, v.lon);
      if (!best || v.dist < best.dist) best = v;
    }
    nearestByOp[op] = best || { op, none: true };
  });
}

const ranked = Object.values(nearestByOp)
  .filter(v => v.dist != null)
  .sort((a, b) => a.dist - b.dist);
const best = ranked[0];

// Elevation change vs. where you are, and cross streets for the closest one
const [elevRes, crossRes] = await Promise.allSettled([
  ranked.length ? elevations([here, ...ranked]) : Promise.resolve([]),
  best ? crossStreet(best.lat, best.lon) : Promise.resolve(null),
]);
if (elevRes.status === "rejected") note("elevation", elevRes.reason);
if (elevRes.status === "fulfilled") {
  const e = elevRes.value;
  ranked.forEach((v, i) => {
    if (e[0] != null && e[i + 1] != null) v.elevFt = (e[i + 1] - e[0]) * 3.28084;
  });
}
if (best && crossRes.status === "fulfilled") best.cross = crossRes.value;

// ---------- widget ----------
const family = config.widgetFamily || "medium";
const w = new ListWidget();
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
if (best) w.url = openUrl(best.op);

function icon(kind) {
  return SFSymbol.named(kind === "scooter" ? "scooter" : "bicycle").image;
}

function where(v) {
  const el = fmtElev(v.elevFt);
  return `${fmtDist(v.dist)} ${v.dir}${el ? " · " + el : ""}`;
}

function detail(v) {
  const walk = fmtWalk(v.dist);
  if (v.docked) return `${walk} · ${v.count} at dock`;
  if (v.rangeM) return `${walk} · ${Math.round(v.rangeM / 1609.34)} mi range`;
  return walk;
}

if (family === "accessoryRectangular") {
  if (!best) {
    w.addText(err || "No e-rides nearby").font = Font.mediumSystemFont(13);
  } else {
    const top = w.addStack();
    top.centerAlignContent();
    const im = top.addImage(icon(best.kind));
    im.imageSize = new Size(14, 14);
    top.addSpacer(4);
    const t = top.addText(`${best.op} ${best.kind}`);
    t.font = Font.boldSystemFont(14);
    const d = w.addText(where(best));
    d.font = Font.systemFont(12); d.lineLimit = 1; d.minimumScaleFactor = 0.7;
    const sub = best.cross || ranked.slice(1).map(v => `${v.op} ${fmtDist(v.dist)}`).join("  ");
    if (sub) { const o = w.addText(sub); o.font = Font.systemFont(11); o.textOpacity = 0.7; o.lineLimit = 1; o.minimumScaleFactor = 0.7; }
  }
} else {
  w.backgroundColor = Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E"));
  w.setPadding(12, 14, 12, 14);
  const fg = Color.dynamic(Color.black(), Color.white());

  if (!best) {
    const t = w.addText(err || "No electric rides nearby");
    t.font = Font.semiboldSystemFont(14); t.textColor = fg;
  } else {
    const head = w.addStack();
    head.centerAlignContent();
    const im = head.addImage(icon(best.kind));
    im.imageSize = new Size(20, 20);
    im.tintColor = new Color(COLORS[best.op]);
    head.addSpacer(6);
    const ht = head.addText(`${best.op} ${best.kind}`);
    ht.font = Font.boldSystemFont(family === "small" ? 15 : 17);
    ht.textColor = fg;

    w.addSpacer(2);
    const bd = w.addText(where(best));
    bd.font = Font.systemFont(13); bd.textColor = fg; bd.textOpacity = 0.85;
    bd.lineLimit = 1; bd.minimumScaleFactor = 0.7;
    const place = best.cross || (best.docked ? best.station : null);
    if (place) {
      const pl = w.addText(place);
      pl.font = Font.mediumSystemFont(13); pl.textColor = fg;
      pl.lineLimit = 1; pl.minimumScaleFactor = 0.7;
    }
    const dt = w.addText(detail(best));
    dt.font = Font.systemFont(12); dt.textColor = fg; dt.textOpacity = 0.6;
    dt.lineLimit = 1; dt.minimumScaleFactor = 0.7;

    w.addSpacer(8);
    for (const op of Object.keys(FEEDS)) {
      if (op === best.op && family === "small") continue;
      const v = nearestByOp[op];
      const row = w.addStack();
      row.centerAlignContent();
      const dot = row.addText("●");
      dot.font = Font.systemFont(9); dot.textColor = new Color(COLORS[op]);
      row.addSpacer(5);
      const label = v?.dist != null ? `${op}  ${where(v)}`
        : v?.failed ? `${op}  feed down` : `${op}  none`;
      const rt = row.addText(label);
      rt.font = Font.systemFont(12); rt.textColor = fg;
      rt.lineLimit = 1; rt.minimumScaleFactor = 0.7;
      rt.textOpacity = op === best.op ? 1 : 0.65;
    }
  }

  w.addSpacer(4);
  const foot = w.addStack();
  if (atHome) {
    const h = foot.addText(`🏠 ${HOME.label} · `);
    h.font = Font.systemFont(9); h.textColor = fg; h.textOpacity = 0.4;
  }
  // Relative date: iOS keeps this counting up live between refreshes
  // (iOS stretches a live date to fill the row, so the label goes before it, not after)
  const up = foot.addText("updated ");
  up.font = Font.systemFont(9); up.textColor = fg; up.textOpacity = 0.4;
  const ts = foot.addDate(new Date());
  ts.applyRelativeStyle(); ts.lineLimit = 1;
  ts.font = Font.systemFont(9); ts.textColor = fg; ts.textOpacity = 0.4;
}

if (!config.runsInWidget && DIAG.length) {
  w.addSpacer(4);
  for (const d of DIAG) {
    const t = w.addText("⚠︎ " + d);
    t.font = Font.systemFont(8); t.textColor = Color.red(); t.lineLimit = 2;
  }
}

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentMedium();
}
Script.complete();
