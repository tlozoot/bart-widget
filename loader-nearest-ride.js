// Nearest Ride — loader
// Downloads the real widget code from GitHub on each run, so updates arrive without copy-paste.
// Falls back to the last downloaded copy if you're offline or GitHub is unreachable.
const URL = "https://raw.githubusercontent.com/tlozoot/bart-widget/main/nearest-ride.js";

const fm = FileManager.local();
const cache = fm.joinPath(fm.documentsDirectory(), "nearest-ride-cached.js");

let code = null;
try {
  const r = new Request(URL);
  r.timeoutInterval = 5;
  const text = await r.loadString();
  if (r.response && r.response.statusCode === 200 && text.length > 100) {
    code = text;
    fm.writeString(cache, code);
  }
} catch (e) {}

if (!code && fm.fileExists(cache)) code = fm.readString(cache);

if (code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(code)();
} else {
  const w = new ListWidget();
  w.addText("Nearest Ride: couldn't download widget code");
  if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
  Script.complete();
}
