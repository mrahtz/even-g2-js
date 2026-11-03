// g2.js: drive Even Realities G2 glasses from a web page over Web Bluetooth.
// No dependencies. Works in Chrome / Edge on macOS, Windows, Linux and Android
// (not Safari or iOS). The page must be served over https or from localhost.
//
//   import { G2, effects } from "./g2.js";
//   const g2 = await G2.connect();            // must run from a click handler
//   await g2.text("Hello from the web");
//   g2.play(effects.countdown({ seconds: 300, label: "Tea" }));
//   g2.addEventListener("gesture", (e) => console.log(e.detail));
//
// A port of the protocol layer of G2 Link, a native macOS app for the G2.
// The protocol is unofficial and community reverse-engineered (see README.md).

// ---------------------------------------------------------------- framing

const uuid = (suffix) => `00002760-08c2-11e1-9073-0e8ac72e${suffix}`;
export const UUIDS = {
  write: uuid("5401"),
  notify: uuid("5402"),
  // Services the characteristics may live under; Web Bluetooth needs them listed up front.
  services: ["0000", "5450", "6450", "7450"].map(uuid),
};

export const SID = { app: 0x01, settings: 0x09, stateChange: 0x0d, handshake: 0x80, evenHub: 0xe0 };
const FLAG_REQUEST = 0x20;
const FLAG_NOTIFY = 0x01;

/** CRC-16/CCITT-FALSE. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Splits a payload into `aa 21` frames; every fragment shares `seq`, CRC on the last. */
export function frames(payload, { seq, sid, flag = FLAG_REQUEST, chunk = 200 }) {
  const crc = crc16(payload);
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  body[payload.length] = crc & 0xff;
  body[payload.length + 1] = crc >> 8;
  const total = Math.max(1, Math.ceil(body.length / chunk));
  const out = [];
  for (let i = 0; i < total; i++) {
    const piece = body.subarray(i * chunk, Math.min(body.length, (i + 1) * chunk));
    const f = new Uint8Array(8 + piece.length);
    f.set([0xaa, 0x21, seq & 0xff, piece.length, total, i + 1, sid, flag]);
    f.set(piece, 8);
    out.push(f);
  }
  return out;
}

class Reassembler {
  pending = new Map();

  /** Returns { sid, flag, payload } once a whole message has arrived. */
  push(raw) {
    if (raw.length < 8 || raw[0] !== 0xaa || (raw[1] !== 0x12 && raw[1] !== 0x21)) return null;
    const [, , seq, len, total, index, sid, flag] = raw;
    const chunk = raw.subarray(8, 8 + len);
    let body;
    if (total <= 1) {
      body = chunk;
    } else {
      if (index === 1 || !this.pending.has(seq)) this.pending.set(seq, { total, parts: new Map() });
      const p = this.pending.get(seq);
      p.parts.set(index, chunk);
      if (p.parts.size < p.total) return null;
      this.pending.delete(seq);
      const parts = [...Array(p.total).keys()].map((i) => p.parts.get(i + 1) ?? new Uint8Array());
      body = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of parts) { body.set(x, o); o += x.length; }
    }
    return { sid, flag, payload: body.subarray(0, Math.max(0, body.length - 2)) };
  }
}

// ---------------------------------------------------------------- protobuf

/** Minimal proto3 writer: zero / empty scalars are omitted, sub-messages always written. */
class PB {
  bytes = [];
  static build(fn) { const w = new PB(); fn(w); return new Uint8Array(w.bytes); }
  varint(v) {
    let n = BigInt(v);
    while (n >= 0x80n) { this.bytes.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
    this.bytes.push(Number(n));
  }
  key(field, wire) { this.varint((field << 3) | wire); }
  uint(field, v) { if (v) { this.key(field, 0); this.varint(v); } return this; }
  bool(field, v) { return this.uint(field, v ? 1 : 0); }
  raw(field, data) { this.key(field, 2); this.varint(data.length); this.bytes.push(...data); return this; }
  string(field, s) { if (s) this.raw(field, new TextEncoder().encode(s)); return this; }
  message(field, fn) { return this.raw(field, PB.build(fn)); }
}

/** Decodes a protobuf message into field -> [values]. Bytes values stay Uint8Array. */
export function decode(buf) {
  const fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n, s = 0n;
    while (i < buf.length) {
      const c = buf[i++];
      v |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return v;
      s += 7n;
    }
    throw new Error("truncated varint");
  };
  const add = (f, v) => { if (!fields.has(f)) fields.set(f, []); fields.get(f).push(v); };
  try {
    while (i < buf.length) {
      const k = Number(varint());
      const f = k >> 3, wire = k & 7;
      if (wire === 0) add(f, Number(varint()));
      else if (wire === 2) { const n = Number(varint()); add(f, buf.subarray(i, i + n)); i += n; }
      else if (wire === 5) { add(f, new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true)); i += 4; }
      else if (wire === 1) { add(f, new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true)); i += 8; }
      else return null;
    }
  } catch { return null; }
  const last = (f) => fields.get(f)?.at(-1);
  return {
    fields,
    has: (f) => fields.has(f),
    uint: (f) => (typeof last(f) === "number" ? last(f) : 0),
    num: (f) => (typeof last(f) === "number" ? last(f) : 0),
    string: (f) => (last(f) instanceof Uint8Array ? new TextDecoder().decode(last(f)) : ""),
    message: (f) => (last(f) instanceof Uint8Array ? decode(last(f)) : null),
  };
}

// ---------------------------------------------------------------- messages

const W = 576, H = 288;
const Cmd = { create: 0, deviceEvent: 2, textUpgrade: 5, rebuild: 7, heartbeat: 12, privateSystemEvent: 14 };

const hub = (cmd, magic, fn = () => {}) => PB.build((w) => { w.uint(1, cmd).uint(2, magic); fn(w); });

function textObject(m, { name, content, id = 1, x = 0, y = 0, width = W, height = H, capture = true }) {
  m.uint(1, x).uint(2, y).uint(3, width).uint(4, height).uint(9, id).string(10, name).bool(11, capture).string(12, content);
}

function listObject(m, { name, items, id = 1, x = 0, y = 0, width = W, height = H }) {
  m.uint(1, x).uint(2, y).uint(3, width).uint(4, height).uint(9, id).string(10, name);
  m.message(11, (it) => { it.uint(1, items.length).bool(3, true); for (const s of items) it.string(4, s); });
  m.bool(12, true);
}

const msg = {
  create: (magic, list) => hub(Cmd.create, magic, (w) => w.message(3, (m) => {
    m.uint(1, 1).message(2, (o) => listObject(o, list)).uint(5, 10000);
  })),
  rebuildText: (magic, text) => hub(Cmd.rebuild, magic, (w) => w.message(7, (m) => {
    m.uint(1, 1).message(3, (o) => textObject(o, text));
  })),
  rebuildList: (magic, list) => hub(Cmd.rebuild, magic, (w) => w.message(7, (m) => {
    m.uint(1, 1).message(2, (o) => listObject(o, list));
  })),
  textUpgrade: (magic, name, content) => hub(Cmd.textUpgrade, magic, (w) => w.message(9, (m) => {
    m.uint(1, 1).string(2, name).uint(4, new TextEncoder().encode(content).length).string(5, content);
  })),
  heartbeat: (magic) => hub(Cmd.heartbeat, magic, (w) => w.message(14, () => {})),
  statusQuery: (magic) => PB.build((w) => w.uint(1, 2).uint(2, magic).message(4, (m) => m.uint(1, 1))),
};

/** The Even app's sid=0x80 start-up exchange; without it the glasses drop the link after ~27 s. */
function handshake(now = Date.now()) {
  const clock = (magic) => PB.build((w) => w.uint(1, 128).uint(2, magic).message(128, (m) => {
    m.uint(1, Math.floor(now / 1000)).uint(2, 0xffffffffffffffe8n);
  }));
  return [
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x0c, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x20, new Uint8Array([0x08, 0x05, 0x10, 0x0e, 0x22, 0x02, 0x08, 0x02])],
    [0x20, clock(0x0f)],
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x10, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x11, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x20, new Uint8Array([0x08, 0x05, 0x10, 0x12, 0x22, 0x02, 0x08, 0x01])],
    [0x20, clock(0x13)],
  ];
}

/** sid=0x01 app-launch, verbatim from an Even app capture. Its ack echoes 156. */
const PRELUDE = new Uint8Array([
  0xaa, 0x21, 0x92, 0x13, 0x01, 0x01, 0x01, 0x20, 0x08, 0x02, 0x10, 0x9c, 0x01, 0x22, 0x0a, 0x1a,
  0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10, 0x00, 0xa1, 0x42,
]);

export const GESTURES = ["tap", "swipe-back", "swipe-forward", "double-tap", "foreground-enter",
  "foreground-exit", "abnormal-exit", "system-exit", "motion"];
const SOURCES = ["unknown", "right temple", "ring", "left temple"];

/** Decodes an async EvenHub event into { type, source?, container?, index?, item? }. */
function decodeEvent(payload) {
  const pb = decode(payload);
  if (!pb || pb.uint(1) !== Cmd.deviceEvent) return null;
  const dev = pb.message(13);
  if (!dev) return null;
  const list = dev.message(1), text = dev.message(2), sys = dev.message(3);
  if (list) return { type: GESTURES[list.uint(5)], container: list.string(2), index: list.uint(4), item: list.string(3) };
  if (text) return { type: GESTURES[text.uint(3)], container: text.string(2) };
  if (sys) {
    const ev = { type: GESTURES[sys.uint(1)], source: SOURCES[sys.uint(2)] };
    const imu = sys.message(3);
    if (imu) ev.motion = { x: imu.num(1), y: imu.num(2), z: imu.num(3) };
    return ev;
  }
  return { type: "tap", source: "unknown" };
}

// ---------------------------------------------------------------- session

/**
 * A connected pair of glasses (right temple). Events:
 *   "gesture"     detail: { type: "tap" | "swipe-forward" | "swipe-back" | ..., source, container, index, item }
 *   "status"      detail: { battery, charging, firmware }
 *   "disconnect"
 *   "log"         detail: string (protocol-level diagnostics)
 */
export class G2 extends EventTarget {
  #device; #write; #notify;
  #seq = 0x40; #magic = 100;
  #waiters = new Map();
  #writing = Promise.resolve();
  #rx = new Reassembler();
  #heartbeat = null;
  #textName = ""; #flip = false; #pageLive = false;
  #pendingText = null; #textBusy = null;
  #animation = null;
  status = null;

  static get supported() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }

  /**
   * Shows the browser's device picker (needs a user gesture) and connects.
   * Each temple is its own Bluetooth device, so the picker lists two; pass
   * `namePrefix` (e.g. from `G2.rightTemplePrefix(g2.name)`) to show only yours.
   */
  static async connect({ log, namePrefix } = {}) {
    if (!G2.supported) throw new Error("This browser has no Web Bluetooth. Use Chrome or Edge.");
    const device = await navigator.bluetooth.requestDevice({
      filters: namePrefix ? [{ namePrefix }] : [{ namePrefix: "Even G2" }, { namePrefix: "G2_" }],
      optionalServices: UUIDS.services,
    });
    const g2 = new G2();
    if (log) g2.addEventListener("log", (e) => log(e.detail));
    await g2.#open(device);
    return g2;
  }

  /** "Even G2_32_R_EB40AF" → "Even G2_32_R_": matches this pair's right temple only. */
  static rightTemplePrefix(name) {
    const m = /^(.*G\d+_\d+_)[LR]_/i.exec(name ?? "");
    return m ? `${m[1]}R_` : null;
  }

  get name() { return this.#device?.name ?? ""; }
  get connected() { return !!this.#device?.gatt.connected; }

  #log(s) { this.dispatchEvent(new CustomEvent("log", { detail: s })); }
  #nextMagic() { this.#magic = this.#magic >= 255 ? 100 : this.#magic + 1; return this.#magic; }

  async #open(device) {
    this.#device = device;
    if (/_L_/i.test(device.name ?? "")) this.#log("That's the left temple; events and the display session live on the right one (…_R_…).");
    device.addEventListener("gattserverdisconnected", () => this.#closed());
    const server = await device.gatt.connect();
    for (const s of await server.getPrimaryServices()) {
      for (const c of await s.getCharacteristics().catch(() => [])) {
        if (c.uuid === UUIDS.write) this.#write = c;
        if (c.uuid === UUIDS.notify) this.#notify = c;
      }
    }
    if (!this.#write || !this.#notify) throw new Error("These don't look like G2 glasses (no 5401/5402 characteristics).");
    this.#notify.addEventListener("characteristicvaluechanged", (e) => {
      const v = e.target.value;
      this.#received(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await this.#notify.startNotifications();
    await this.#startSession();
    this.#heartbeat = setInterval(() => {
      const m = this.#nextMagic();
      this.#send(SID.evenHub, msg.heartbeat(m), m, { timeout: 2000 }).catch(() => {});
    }, 5000);
    this.refreshStatus().catch(() => {});
  }

  async #startSession() {
    let acked = 0;
    for (const [flag, payload] of handshake()) {
      if (await this.#send(SID.handshake, payload, decode(payload).uint(2), { flag, timeout: 1000 })) acked++;
    }
    this.#log(`handshake ${acked}/7 acknowledged`);
    const launch = this.#waitFor(SID.app, 156, 4000);
    await this.#writeFrames([PRELUDE]);
    if (!(await launch)) throw new Error("The glasses didn't accept the session. Are they connected to another app or phone?");
    const m = this.#nextMagic();
    await this.#send(SID.evenHub, msg.create(m, { name: "g2web", items: ["G2 web"] }), m, { timeout: 4000 });
    this.#pageLive = true;
    this.#textName = "";
  }

  #closed() {
    clearInterval(this.#heartbeat);
    this.stop();
    for (const r of this.#waiters.values()) r(null);
    this.#waiters.clear();
    this.dispatchEvent(new Event("disconnect"));
  }

  disconnect() { this.#device?.gatt.disconnect(); }

  #writeFrames(list) {
    const run = this.#writing.then(async () => {
      for (const f of list) await this.#write.writeValueWithoutResponse(f);
    });
    this.#writing = run.catch(() => {});
    return run;
  }

  #waitFor(sid, magic, timeout) {
    const key = `${sid}:${magic}`;
    this.#waiters.get(key)?.(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.#waiters.get(key) === done) { this.#waiters.delete(key); resolve(null); } }, timeout);
      const done = (reply) => { clearTimeout(t); resolve(reply); };
      this.#waiters.set(key, done);
    });
  }

  /** Sends a payload and resolves with the decoded reply (or null on timeout). */
  async #send(sid, payload, magic, { flag = FLAG_REQUEST, timeout = 3000 } = {}) {
    if (!this.connected) throw new Error("not connected");
    const reply = this.#waitFor(sid, magic, timeout);
    const seq = this.#seq;
    this.#seq = (this.#seq + 1) & 0xff;
    await this.#writeFrames(frames(payload, { seq, sid, flag }));
    return reply;
  }

  #received(raw) {
    const m = this.#rx.push(raw);
    if (!m) return;
    const pb = decode(m.payload);
    if (m.flag !== FLAG_NOTIFY && pb?.has(2)) {
      const w = this.#waiters.get(`${m.sid}:${pb.uint(2)}`);
      if (w) { this.#waiters.delete(`${m.sid}:${pb.uint(2)}`); w(pb); return; }
    }
    if (m.flag !== FLAG_NOTIFY && m.flag !== 0x06) return;
    if (m.sid === SID.evenHub) {
      const ev = decodeEvent(m.payload);
      if (!ev) return;
      if (ev.type === "system-exit" || ev.type === "abnormal-exit") this.#pageLive = false;
      this.dispatchEvent(new CustomEvent("gesture", { detail: ev }));
    } else if (m.sid === SID.settings) {
      this.refreshStatus().catch(() => {});
    }
  }

  // -------------------------------------------------------------- display

  async #ensurePage() { if (!this.#pageLive) await this.#startSession(); }

  /** Shows text full-lens (≈10 lines × 50 chars). Stops any animation. */
  text(content) { this.stop(); return this.#queueText(content); }

  /** Coalesces: while a frame is in flight only the newest pending text is kept. */
  #queueText(content) {
    this.#pendingText = content;
    if (!this.#textBusy) {
      this.#textBusy = (async () => {
        while (this.#pendingText !== null) {
          const next = this.#pendingText;
          this.#pendingText = null;
          await this.#renderText(next).catch((e) => this.#log(`text failed: ${e.message}`));
        }
        this.#textBusy = null;
      })();
    }
    return this.#textBusy;
  }

  async #renderText(raw) {
    let content = raw || " ";
    while (new TextEncoder().encode(content).length > 990) content = content.slice(0, -1);
    await this.#ensurePage();
    if (this.#textName) {
      const m = this.#nextMagic();
      const ack = await this.#send(SID.evenHub, msg.textUpgrade(m, this.#textName, content), m);
      if (ack && ack.message(10)?.uint(1) !== 9) return;
    }
    this.#flip = !this.#flip;
    const name = `text-${this.#flip ? "a" : "b"}`;
    const m = this.#nextMagic();
    await this.#send(SID.evenHub, msg.rebuildText(m, { name, content }), m);
    this.#textName = name;
  }

  /** Shows a selectable list (≤ 20 items); choices arrive as "gesture" events with `item`. */
  async list(items) {
    this.stop();
    await this.#textBusy;
    await this.#ensurePage();
    this.#flip = !this.#flip;
    const m = this.#nextMagic();
    await this.#send(SID.evenHub, msg.rebuildList(m, { name: `list-${this.#flip ? "a" : "b"}`, items: items.slice(0, 20) }), m);
    this.#textName = "";
  }

  clear() { return this.text(" "); }

  /** Battery and firmware; also emitted as a "status" event. */
  async refreshStatus() {
    const m = this.#nextMagic();
    const reply = await this.#send(SID.settings, msg.statusQuery(m), m, { timeout: 4000 });
    const r = reply?.message(4);
    if (!r) return this.status;
    this.status = { battery: r.uint(12), charging: !!r.uint(13), firmware: r.string(6) };
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
    return this.status;
  }

  // -------------------------------------------------------------- animation

  /**
   * Plays an effect from `effects` (or any { fps, duration?, pausable?, frame(t, state) }).
   * A tap on the glasses pauses / resumes pausable effects. `text()` / `list()` stop it.
   */
  play(effect) {
    this.stop();
    const state = { paused: false, value: 0, elapsed: 0, finished: false };
    let last = 0, lastFrame = null, timer = null;
    const onGesture = (e) => { if (e.detail.type === "tap" && effect.pausable !== false) state.paused = !state.paused; };
    this.addEventListener("gesture", onGesture);
    const tick = async () => {
      const now = performance.now();
      if (!state.paused) state.elapsed += (now - last) / 1000;
      last = now;
      if (effect.duration != null && state.elapsed >= effect.duration) { state.elapsed = effect.duration; state.finished = true; }
      const frame = effect.frame(state.elapsed, state);
      if (frame !== lastFrame) { lastFrame = frame; await this.#queueText(frame); }
      if (this.#animation?.state !== state) return;
      if (state.finished) { this.removeEventListener("gesture", onGesture); return; }
      timer = setTimeout(tick, 1000 / effect.fps);
    };
    this.#animation = { state, stop: () => { clearTimeout(timer); this.removeEventListener("gesture", onGesture); } };
    last = performance.now();
    tick();
    return state; // set state.value (0…1) to drive a progress bar without a duration
  }

  /** Stops the animation, leaving its last frame on the lens. */
  stop() { this.#animation?.stop(); this.#animation = null; }
}

// ---------------------------------------------------------------- effects

// Only glyphs the firmware font has (Even Hub design guidelines); others are dropped.
const ROWS = 10, COLS = 44, BAR = 24;

const page = (lines) => {
  const top = Math.max(0, Math.floor((ROWS - lines.length) / 2));
  return "\n".repeat(top) + lines.map((l) => " ".repeat(Math.max(0, Math.floor((COLS - [...l].length) / 2))) + l).join("\n");
};
const bar = (f, w = BAR) => {
  const n = Math.round(Math.min(1, Math.max(0, f)) * w);
  return "━".repeat(n) + "─".repeat(w - n);
};
const clock = (t, tenths = false) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t) % 60;
  const p = (n) => String(n).padStart(2, "0");
  return (h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`) + (tenths ? `.${Math.floor(t * 10) % 10}` : "");
};
const paused = (s) => (s.paused ? ["", "■ paused - tap to resume"] : []);

/** Word-wraps to `cols` characters. */
export function wrap(text, cols = COLS) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let w of para.split(/ +/).filter(Boolean)) {
      while (w.length > cols) { if (line) { out.push(line); line = ""; } out.push(w.slice(0, cols)); w = w.slice(cols); }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= cols) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out;
}

const SPINNERS = {
  dots: ["●○○○", "○●○○", "○○●○", "○○○●", "○○●○", "○●○○"],
  bar: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
  line: ["|", "/", "─", "\\"],
  blocks: ["■□□□□", "□■□□□", "□□■□□", "□□□■□", "□□□□■", "□□□■□", "□□■□□", "□■□□□"],
  arrows: ["▶▷▷▷", "▷▶▷▷", "▷▷▶▷", "▷▷▷▶"],
};

export const effects = {
  spinner: ({ label = "", style = "dots" } = {}) => ({
    fps: 8,
    frame: (t, s) => { const f = SPINNERS[style] ?? SPINNERS.dots; const g = f[Math.floor(t * 8) % f.length]; return page(label ? [g, "", label, ...paused(s)] : [g]); },
  }),
  /** Without `seconds`, follows `state.value` (0…1) from the object `play()` returns. */
  progress: ({ label = "", seconds } = {}) => ({
    fps: 10, duration: seconds,
    frame: (t, s) => { const f = seconds ? t / seconds : s.value; return page([label, "", bar(f), `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`, ...paused(s)]); },
  }),
  countdown: ({ seconds = 300, label = "" } = {}) => ({
    fps: 10, duration: seconds + 6,
    frame: (t, s) => {
      const left = seconds - t;
      if (left <= 0) return page([label || "Time's up", "", Math.floor(t * 2) % 2 ? "☆  TIME'S UP  ☆" : "★  TIME'S UP  ★"]);
      return page([label, "", clock(Math.ceil(left)), "", bar(left / seconds), ...paused(s)]);
    },
  }),
  stopwatch: ({ label = "" } = {}) => ({ fps: 10, frame: (t, s) => page([label, "", clock(t, true), ...paused(s)]) }),
  clock: ({ seconds = true, date = true } = {}) => ({
    fps: 4, pausable: false,
    frame: () => {
      const now = new Date();
      const ascii = (x) => x.replace(/[  ]/g, " ");
      const time = ascii(now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }));
      const day = ascii(now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }));
      return page(date ? [time, "", day] : [time]);
    },
  }),
  ticker: ({ text = "", cps = 8 } = {}) => ({
    fps: Math.min(16, cps),
    frame: (t, s) => {
      const win = COLS - 4, loop = [...(" ".repeat(win) + text.replace(/\n/g, "   "))];
      const start = Math.floor(t * cps) % loop.length;
      const visible = Array.from({ length: win }, (_, i) => loop[(start + i) % loop.length]).join("");
      return page(["─".repeat(win), visible, "─".repeat(win), ...paused(s)]);
    },
  }),
  typewriter: ({ text = "", cps = 12 } = {}) => ({
    fps: Math.min(16, cps), duration: [...text].length / cps + 1.5,
    frame: (t) => {
      const chars = [...text], n = Math.min(chars.length, Math.floor(t * cps));
      const cursor = n < chars.length || Math.floor(t * 2) % 2 === 0 ? "█" : "";
      return wrap(chars.slice(0, n).join("") + cursor).slice(-(ROWS - 1)).join("\n");
    },
  }),
  breathe: ({ inhale = 4, hold = 2, exhale = 6 } = {}) => ({
    fps: 10,
    frame: (t, s) => {
      const cycle = inhale + hold + exhale + hold, p = t % cycle;
      const [word, f, left] = p < inhale ? ["Breathe in", p / inhale, inhale - p]
        : p < inhale + hold ? ["Hold", 1, inhale + hold - p]
        : p < inhale + hold + exhale ? ["Breathe out", 1 - (p - inhale - hold) / exhale, inhale + hold + exhale - p]
        : ["Hold", 0, cycle - p];
      return page([word, "", bar(f), String(Math.ceil(left)), ...paused(s)]);
    },
  }),
  equalizer: ({ label = "" } = {}) => ({
    fps: 12, pausable: false,
    frame: (t) => {
      const lv = "▁▂▃▄▅▆▇█";
      const bars = Array.from({ length: 20 }, (_, i) => {
        const v = 0.5 + 0.25 * Math.sin(t * 5.1 + i * 0.9) + 0.2 * Math.sin(t * 8.7 + i * 2.3) + 0.05 * Math.sin(t * 13 + i * 5);
        return lv[Math.min(7, Math.max(0, Math.floor(v * 8)))];
      }).join("");
      return page(label ? [bars, "", label] : [bars]);
    },
  }),
  /** Your own frames, cycled at `fps`. */
  frames: (list, { fps = 4, loop = true } = {}) => ({
    fps: Math.min(16, fps), duration: loop ? undefined : list.length / fps,
    frame: (t) => list[loop ? Math.floor(t * fps) % list.length : Math.min(list.length - 1, Math.floor(t * fps))] || " ",
  }),
};
