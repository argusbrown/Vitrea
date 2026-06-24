'use strict';

// Vitrea — sound effects. Pure Web Audio synthesis, zero audio assets.
// Runs in the browser; loads safely under Node (tests) as a no-op so the
// test runner can require() it. Mirrors engine.js's UMD wrapper.
//
//   processEvents() (app.js)              sfx.js
//   ───────────────────────              ──────────────────────────────
//   for each game event ev:              SOUND_MAP[ev.type] -> recipe
//     VitreaSfx.play(ev.type, opts) ───►   muted? ─ yes ─► (silent, no nodes)
//                                          mineOnly && !mine ─► skip
//                                          within MIN_INTERVAL of last? ─► skip
//                                          chime: sum of inharmonic sine
//                                                 partials, risk-scaled pitch
//                                          shatter: noise crack + fading shards
//
// All cues are synthesized at call time and garbage-collected after stop().

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VitreaSfx = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

const MUTE_KEY = 'vitrea-muted';   // hyphen, matching vitrea-session / vitrea-name
const MASTER_GAIN = 0.25;
const MIN_INTERVAL_MS = 70;        // collapse same-tick repeats + throttle bursts

// --- environment guards: load safely under Node / no-Web-Audio ---
const AC = typeof AudioContext !== 'undefined' ? AudioContext
  : typeof webkitAudioContext !== 'undefined' ? webkitAudioContext
  : null;
const canStore = (() => { try { return typeof localStorage !== 'undefined'; } catch { return false; } })();

let ctx = null;
let master = null;
let muted = readMuted();          // absent key -> false -> sound plays (default ON)
let noiseBuf = null;
const lastPlayed = Object.create(null); // cue name -> timestamp (ms)

// BC_bright glass timbre: warm body + bright crystal upper partials.
// [freq-multiplier, amplitude]; the non-integer ratios make it "glass".
const GLASS = [[1, 0.6], [2.70, 0.26], [4.97, 0.15], [7.1, 0.07]];
const DULL = [[1, 0.5], [2.1, 0.18]]; // softer, for discard / skip / pass
const MARIMBA = [[1, 0.6], [4, 0.12]]; // round + woody (fundamental + soft 2-octave), for placement

// event type -> synth recipe. The ONLY place event->sound is bound.
const SOUND_MAP = {
  // draw: pitch climbs with bust risk (opts.intensity), plus per-draw detune.
  reveal:   { kind: 'chime', partials: GLASS, base: 440, dur: 0.9, attack: 0.005, detune: 18, scaleByIntensity: true },
  // placement: round marimba-like tone with a soft 20ms attack (no harsh transient).
  placed:   { kind: 'chime', partials: MARIMBA, base: 330, dur: 0.7, attack: 0.020 },
  // score (reward): a soft two-note marimba "ta-da" rising a fifth, not a sharp chime.
  score:    { kind: 'chime', partials: MARIMBA, base: 660, dur: 0.5, attack: 0.012, seq: [{ m: 1, t: 0 }, { m: 1.5, t: 0.10 }] },
  spectrum: { kind: 'chime', partials: GLASS, base: 880, dur: 1.1, attack: 0.004 },
  // partial spectrum (bank 4–5 colours): softer, lower cousin of the spectrum chime.
  radiance: { kind: 'chime', partials: GLASS, base: 660, dur: 0.8, attack: 0.005 },
  shield:   { kind: 'chime', partials: GLASS, base: 550, dur: 0.7, attack: 0.004 },
  finish:   { kind: 'chime', partials: GLASS, base: 740, dur: 1.0, attack: 0.004 },
  turn:     { kind: 'chime', partials: GLASS, base: 520, dur: 0.6, attack: 0.004, mineOnly: true },
  // who-goes-first reveal at game start: a brighter two-note flourish for everyone.
  firstPlayer: { kind: 'chime', partials: GLASS, base: 587, dur: 0.9, attack: 0.004, seq: [{ m: 1, t: 0 }, { m: 1.5, t: 0.12 }] },
  discard:  { kind: 'chime', partials: DULL,  base: 240, dur: 0.4, attack: 0.004 },
  skipped:  { kind: 'chime', partials: DULL,  base: 200, dur: 0.4, attack: 0.004 },
  pass:     { kind: 'chime', partials: DULL,  base: 280, dur: 0.35, attack: 0.004 },
  bust:     { kind: 'shatter' },
  // NB: a busting draw (reveal with crack:true) is silenced by app.js — the
  // 'bust' event owns the shatter, so there is exactly one shatter per bust.
};

function readMuted() {
  if (!canStore) return false;
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

// Lazily create + resume the AudioContext, and unlock iOS by playing a
// 1-sample silent buffer inside the user gesture. Idempotent: safe to call
// from every button handler and the global first-tap listener.
function ensureAudio() {
  if (!AC) return; // Node / no Web Audio
  if (!ctx) {
    try {
      ctx = new AC();
    } catch { ctx = null; return; }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* unlock is best-effort */ }
}

function setMuted(v) {
  muted = !!v;
  if (canStore) { try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {} }
  if (master) master.gain.value = muted ? 0 : MASTER_GAIN; // silences in-flight cues too
  return muted;
}
function isMuted() { return muted; }
function toggleMute() { return setMuted(!muted); }

function getNoise() {
  if (!noiseBuf && ctx) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function playChime(recipe, opts) {
  const t = ctx.currentTime;
  let base = recipe.base;
  if (recipe.scaleByIntensity) {
    const k = Math.max(0, Math.min(1, opts.intensity || 0));
    base *= Math.pow(2, k); // 0 risk = base, full risk = +1 octave
  }
  if (recipe.detune) {
    const cents = (Math.random() * 2 - 1) * recipe.detune;
    base *= Math.pow(2, cents / 1200);
  }
  // A recipe may be one note, or a short sequence: seq = [{m,t}, ...] where
  // m scales the base pitch and t offsets the start (a little rising "ta-da").
  const notes = recipe.seq || [{ m: 1, t: 0 }];
  for (const note of notes) {
    const start = t + (note.t || 0);
    for (const [mult, amp] of recipe.partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = base * note.m * mult;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(amp, start + (recipe.attack || 0.005));
      g.gain.exponentialRampToValueAtTime(0.0001, start + recipe.dur);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + recipe.dur + 0.05);
    }
  }
}

// Sharp noise-burst crack, then ~24 high "shard" grains that fall and fade.
function playShatter() {
  const t0 = ctx.currentTime;
  const SPREAD = 1.4;
  const COUNT = 24;

  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.9, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  src.connect(hp).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + 0.2);

  for (let i = 0; i < COUNT; i++) {
    const frac = Math.random();
    const t = t0 + 0.03 + frac * SPREAD;
    const fade = 1 - frac; // later shards land quieter (the pane "settles")
    const osc = ctx.createOscillator();
    const gg = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 2000 + Math.random() * 4000;
    const amp = (0.04 + Math.random() * 0.12) * fade;
    gg.gain.setValueAtTime(0, t);
    gg.gain.linearRampToValueAtTime(amp, t + 0.003);
    gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + Math.random() * 0.1);
    osc.connect(gg).connect(master);
    osc.start(t);
    osc.stop(t + 0.4);
  }
}

// Play the cue mapped to `name`. opts: { mine?, intensity? }.
function play(name, opts) {
  opts = opts || {};
  if (muted) return;                          // early-out before building nodes
  const recipe = SOUND_MAP[name];
  if (!recipe) return;                        // unmapped event -> silent no-op
  if (recipe.mineOnly && !opts.mine) return;
  if (!ctx || !master) return;                // not unlocked yet / no Web Audio
  const ts = nowMs();                         // throttle: collapse same-tick repeats + bursts
  if (lastPlayed[name] && ts - lastPlayed[name] < MIN_INTERVAL_MS) return;
  lastPlayed[name] = ts;
  try {
    if (recipe.kind === 'shatter') playShatter();
    else playChime(recipe, opts);
  } catch { /* never let audio break the game */ }
}

return { ensureAudio, play, setMuted, isMuted, toggleMute };
});
