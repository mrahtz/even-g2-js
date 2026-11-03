// Protocol checks for g2.js: golden vectors from real captures, plus effect glyphs.
// Run: node test.mjs (from this folder)
import assert from "node:assert/strict";
import { crc16, decode, effects, frames } from "./g2.js";

const hex = (u8) => Buffer.from(u8).toString("hex");

assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29b1);

// The captured app-launch frame: framing + CRC must reproduce it exactly.
const prelude = "aa219213010101200802109c01220a1a081206120408001000a142";
const body = Buffer.from(prelude, "hex").subarray(8, -2);
assert.equal(hex(frames(new Uint8Array(body), { seq: 0x92, sid: 0x01 })[0]), prelude);

// Multi-fragment: shared seq, 1-based index, total.
const big = frames(new Uint8Array(600), { seq: 0x41, sid: 0xe0, chunk: 200 });
assert.deepEqual(big.map((f) => [f[2], f[4], f[5]]), [[0x41, 4, 1], [0x41, 4, 2], [0x41, 4, 3], [0x41, 4, 4]]);

// Decoding a real motion report (floats on the wire).
const motion = decode(Buffer.from("08026a151a1308081a0f0d49e1a8be15a9a9443e1d4d676e3f", "hex"));
const imu = motion.message(13).message(3).message(3);
assert.ok(Math.abs(imu.num(1) + 0.3298) < 1e-3 && Math.abs(imu.num(3) - 0.9312) < 1e-3);

// Every effect frame uses only glyphs the lens font has and fits a container.
const safe = new Set([..."━─█▇▆▅▄▃▂▁▲△▶▷▼▽◀◁●○■□★☆"]);
const all = [
  ...["dots", "bar", "line", "blocks", "arrows"].map((style) => effects.spinner({ label: "Loading", style })),
  effects.progress({ label: "Up", seconds: 30 }), effects.countdown({ seconds: 90, label: "Tea" }),
  effects.stopwatch({ label: "Lap" }), effects.clock(), effects.ticker({ text: "News. ".repeat(40) }),
  effects.typewriter({ text: "Typing. ".repeat(100), cps: 20 }), effects.breathe(), effects.equalizer({ label: "x" }),
];
for (const e of all) {
  for (let t = 0; t < 200; t += 0.37) {
    for (const paused of [false, true]) {
      const f = e.frame(t, { paused, value: t / 200 });
      assert.ok(Buffer.byteLength(f) <= 990, "too long");
      for (const ch of f) assert.ok(ch.charCodeAt(0) < 128 || safe.has(ch), `unsupported glyph ${ch}`);
    }
  }
}
console.log("g2.js: all checks passed");
