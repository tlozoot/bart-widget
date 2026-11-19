# bart-widget
Scriptable code for bart widgets

- `bart-commute.js` — the widget. Next trains at the nearer of 24th St / Montgomery in your commute direction, headway-gap warnings (vs. schedule) for both directions, and route-relevant BART alerts.
- `loader.js` — paste this into Scriptable once. It downloads `bart-commute.js` from this repo on every run (falls back to the last cached copy offline), so pushes here update the widget.
