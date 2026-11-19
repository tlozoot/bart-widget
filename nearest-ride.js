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

// ---------- main ----------
let here = null, err = null;
try {
  Location.setAccuracyToHundredMeters();
  here = await Location.current();
} catch (e) { err = "No location"; }

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

// ---------- widget ----------
const family = config.widgetFamily || "medium";
const w = new ListWidget();
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
if (best) w.url = openUrl(best.op);

function icon(kind) {
  return SFSymbol.named(kind === "scooter" ? "scooter" : "bicycle").image;
}

function where(v) { return `${fmtDist(v.dist)} ${v.dir}`; }

function detail(v) {
  if (v.docked) return `${v.count} at dock${v.station ? " · " + v.station : ""}`;
  if (v.rangeM) return `${Math.round(v.rangeM / 1609.34)} mi range`;
  return null;
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
    const d = w.addText(`${where(best)} · ${fmtWalk(best.dist)}`);
    d.font = Font.systemFont(12);
    const others = ranked.slice(1).map(v => `${v.op} ${where(v)}`).join("  ");
    if (others) { const o = w.addText(others); o.font = Font.systemFont(11); o.textOpacity = 0.7; }
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
    const bd = w.addText(`${where(best)} · ${fmtWalk(best.dist)}`);
    bd.font = Font.systemFont(13); bd.textColor = fg; bd.textOpacity = 0.85;
    bd.lineLimit = 1; bd.minimumScaleFactor = 0.7;
    const det = detail(best);
    if (det) {
      const dt = w.addText(det);
      dt.font = Font.systemFont(12); dt.textColor = fg; dt.textOpacity = 0.6;
      dt.lineLimit = 1; dt.minimumScaleFactor = 0.7;
    }

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
      rt.textOpacity = op === best.op ? 1 : 0.65;
    }
  }

  w.addSpacer(4);
  const ts = w.addDate(new Date());
  ts.applyTimeStyle();
  ts.font = Font.systemFont(9); ts.textColor = fg; ts.textOpacity = 0.4;
}

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentMedium();
}
Script.complete();
