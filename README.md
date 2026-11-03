# even-g2-js

Drive [Even Realities G2](https://www.evenrealities.com/) smart glasses from a web page over **Web Bluetooth**. No app, server or phone is involved; the browser talks to the glasses directly.

- **`g2.js`**: a dependency-free ES module covering connecting, the start-up handshake, text, lists, tap/swipe gestures, battery status, keep-alive, and text animations.
- **`index.html`**: a demo page with a lens preview, live typing, animations and a gesture log.
- **`test.mjs`**: protocol checks against golden vectors from real captures.

```bash
python3 -m http.server 8000     # then open http://localhost:8000 in Chrome
node test.mjs                   # protocol checks
```

## Usage

```js
import { G2, effects } from "./g2.js";

button.onclick = async () => {                    // the device picker needs a click
  const g2 = await G2.connect();
  await g2.text("Hello from the web");
  g2.play(effects.countdown({ seconds: 300, label: "Tea" }));
  g2.addEventListener("gesture", (e) => console.log(e.detail));
  // { type: "tap" | "swipe-forward" | "swipe-back" | "double-tap" | …, source: "right temple" | "ring" | … }
};
```

| Call | What it does |
|---|---|
| `G2.connect({ namePrefix?, log? })` | Opens the browser's device picker and connects. |
| `text(string)` | Full-lens text (about 10 lines × 50 characters). Rapid calls are merged, so only the newest text is drawn. |
| `list(items)` | A selectable list of up to 20 items. Picks arrive as `gesture` events with `item`. |
| `clear()` | Blanks the lens. |
| `refreshStatus()` | Battery, charging and firmware. Also sent as a `status` event. |
| `play(effect)` / `stop()` | Plays a text animation. A tap on the glasses pauses and resumes it. |
| `disconnect()` | Disconnects. A `disconnect` event fires whenever the link drops. |

The effects are `spinner`, `progress`, `countdown`, `stopwatch`, `clock`, `ticker`, `typewriter`, `breathe`, `equalizer` and `frames` (your own frames). `play()` returns a state object: set `state.value` (0–1) to drive a progress bar that has no duration. Effects only use glyphs the firmware font has (`━ ─ █▇▆▅▄▃▂▁ ▲▶▼◀ ●○ ■□ ★☆`, per the [Even Hub design guidelines](https://hub.evenrealities.com/docs/build/design-guidelines)), because other characters are silently dropped. In-place text updates run at about 16 frames per second.

## Limits

- **Browsers:** Chrome and Edge on macOS, Windows, Linux and Android. Not Safari, Firefox or anything on iOS.
- **Secure context:** Web Bluetooth only works on `https://` pages or on `localhost`. Opening `index.html` as a file doesn't work, because module scripts don't load from `file://`.
- **One host at a time:** disconnect the Even app on your phone (or turn off the phone's Bluetooth) first.
- **Two devices in the picker:** each temple is its own Bluetooth device. Pick the one with `_R_` in its name; it carries the display session and the gestures. The demo page remembers it and lists only that temple next time.
- **No background running:** the connection lasts only while the tab is open.

Verified on firmware 2.4.0.24 from Chrome on macOS: connecting, the handshake, text, animations, and tap/swipe gestures.

## Protocol

Frames are `aa 21 <seq> <len> <total> <index> <sid> <flag> <protobuf…> <crc16 LE>`, written to characteristic `00002760-08c2-11e1-9073-0e8ac72e5401`; replies come back on `…5402`. A session runs as follows:

1. The Even app's `sid 0x80` handshake: capability queries and a clock sync. Without it, the glasses drop the link about 27 s after connecting.
2. The app-launch prelude (`sid 0x01`).
3. One start-up page CREATE (`sid 0xe0`).
4. From then on: text updates, page rebuilds, and a heartbeat every 5 s.

This is unofficial, and builds on community reverse-engineering, mainly [Commute773/g2-kit](https://github.com/Commute773/g2-kit) (protobuf schemas and firmware gotchas) and [i-soxi/even-g2-protocol](https://github.com/i-soxi/even-g2-protocol) (the handshake). It's not affiliated with Even Realities.
