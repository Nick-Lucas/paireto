import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const TL = createRequire(import.meta.url)("./timeline.cjs");

const SR = 48000;
const DUR = TL.duration;
const N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
let OL = L, OR = R;
const revIn = new Float32Array(N);
const dlyIn = new Float32Array(N);
const duck = new Float32Array(N).fill(1);
const BEAT = 60 / TL.bpm;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(i, v, pan = 0, rev = 0, dly = 0) {
  if (i < 0 || i >= N) return;
  const a = (pan + 1) * Math.PI / 4;
  OL[i] += v * Math.cos(a);
  OR[i] += v * Math.sin(a);
  revIn[i] += v * rev;
  dlyIn[i] += v * dly;
}

function biquad(type, f, q) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b0, b1, b2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function bq(st, x) {
  const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
  st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
  return y;
}
function retune(st, type, f, q) { Object.assign(st, { ...biquad(type, f, q), x1: st.x1, x2: st.x2, y1: st.y1, y2: st.y2 }); }

function pad(t0, t1, notes, gain) {
  const a = 0.35, r = 0.9;
  for (const m of notes) {
    for (const det of [-0.07, 0.07]) {
      const f = mtof(m + det);
      const pan = det < 0 ? -0.35 : 0.35;
      const i0 = Math.floor(t0 * SR), i1 = Math.min(N, Math.floor((t1 + r) * SR));
      for (let i = i0; i < i1; i++) {
        const t = i / SR - t0;
        const env = Math.min(1, t / a) * (i / SR > t1 ? Math.max(0, 1 - (i / SR - t1) / r) : 1);
        let v = 0;
        for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * f * k * t + k) / (k * k);
        add(i, v * env * gain * duck[i], pan, 0.35);
      }
    }
  }
}

function pluck(t0, m, gain, pan = 0, rev = 0.3, dly = 0.25, bright = 1) {
  const f = mtof(m), i0 = Math.floor(t0 * SR), len = Math.floor(1.6 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f * k * t) * Math.exp(-t * (5 + k * 7 / bright)) / k;
    v *= Math.min(1, t / 0.003);
    add(i0 + j, v * gain, pan, rev, dly);
  }
}

function bell(t0, m, gain, pan = 0, decay = 1.6, rev = 0.5) {
  const f = mtof(m), i0 = Math.floor(t0 * SR), len = Math.floor(decay * 2.2 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const idx = 1.6 * Math.exp(-t * 5);
    const v = Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * f * 3.5 * t)) * Math.exp(-t * 3 / decay) * Math.min(1, t / 0.002);
    add(i0 + j, v * gain, pan, rev, 0.15);
  }
}

function kick(t0, gain) {
  const i0 = Math.floor(t0 * SR), len = Math.floor(0.45 * SR);
  let ph = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const f = 44 + 90 * Math.exp(-t * 28);
    ph += 2 * Math.PI * f / SR;
    const v = Math.sin(ph) * Math.exp(-t * 7.5) + 0.25 * Math.sin(ph * 2) * Math.exp(-t * 40);
    add(i0 + j, Math.tanh(v * 1.4) * gain, 0, 0.02);
  }
  for (let j = 0; j < Math.floor(0.42 * SR); j++) {
    const i = i0 + j;
    if (i < N) duck[i] = Math.min(duck[i], 0.45 + 0.55 * Math.min(1, j / (0.42 * SR)) ** 0.7);
  }
}

function noiseHit(t0, gain, dur, type, f, q, pan = 0, rev = 0.1, decayK = 60) {
  const st = biquad(type, f, q), i0 = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    add(i0 + j, bq(st, rnd()) * Math.exp(-t * decayK) * gain, pan, rev);
  }
}

function hat(t0, gain, pan) { noiseHit(t0, gain, 0.08, "hp", 8000, 0.7, pan, 0.05, 70); }
function clap(t0, gain) {
  for (const [o, g] of [[0, 0.6], [0.011, 0.7], [0.022, 1]]) noiseHit(t0 + o, gain * g, 0.22, "bp", 1500, 1.2, 0, 0.35, 22);
}
function tick(t0, gain, m = 86, pan = 0.2) {
  noiseHit(t0, gain * 0.6, 0.03, "bp", 3200, 2, pan, 0.08, 220);
  const f = mtof(m), i0 = Math.floor(t0 * SR);
  for (let j = 0; j < 0.08 * SR; j++) { const t = j / SR; add(i0 + j, Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 70) * gain * 0.5, pan, 0.15); }
}
function keyThock(t0, gain, m) {
  noiseHit(t0, gain, 0.09, "bp", 900, 1.5, 0, 0.12, 55);
  const f = mtof(m), i0 = Math.floor(t0 * SR);
  for (let j = 0; j < 0.18 * SR; j++) { const t = j / SR; add(i0 + j, Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 26) * gain * 0.9, 0, 0.15); }
}

function whoosh(tPeak, gain, up = 0.42, down = 0.35, pan = 0) {
  const t0 = tPeak - up, i0 = Math.floor(t0 * SR), len = Math.floor((up + down) * SR);
  const st = biquad("bp", 400, 0.9);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const p = t < up ? t / up : 1 - (t - up) / down;
    if (j % 32 === 0) retune(st, "bp", 300 + 2600 * (t < up ? (t / up) ** 2 : 1 - 0.5 * (t - up) / down), 0.9);
    const env = Math.pow(Math.max(0, p), 2.2);
    add(i0 + j, bq(st, rnd()) * env * gain, pan + 0.4 * Math.sin(t * 3), 0.25);
  }
}

function riser(t0, t1, gain) {
  const i0 = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR);
  const st = biquad("bp", 300, 1.2);
  for (let j = 0; j < len; j++) {
    const p = j / len;
    if (j % 32 === 0) retune(st, "bp", 300 + 5000 * p * p, 1.2);
    add(i0 + j, bq(st, rnd()) * p ** 2.5 * gain, 0, 0.4);
  }
}

function bassNote(t0, dur, m, gain) {
  const f = mtof(m), i0 = Math.floor(t0 * SR), len = Math.floor((dur + 0.05) * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR, i = i0 + j;
    const env = Math.min(1, t / 0.006) * Math.exp(-t * 2.2) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.05) : 1);
    const v = Math.sin(2 * Math.PI * f * t) + 0.32 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t);
    add(i, Math.tanh(v * 1.1) * env * gain * (i < N ? duck[i] : 1), 0, 0.03);
  }
}

const S16 = BEAT / 4;
const SWING = 0.2 * S16;
const BAR = 4 * BEAT;
const st = (bar, s) => bar * BAR + s * S16 + (s % 2 ? SWING : 0);
const DROP = TL.scenes.s2[0];
const END = TL.scenes.s7[0];
const BARS = Math.round(END / BAR);

const DL = new Float32Array(N), DR = new Float32Array(N);
function onBus(fn) { OL = DL; OR = DR; fn(); OL = L; OR = R; }

const DM9 = [53, 57, 60, 64], G13 = [53, 57, 59, 64], BB = [53, 57, 60, 62], A7 = [55, 61, 64, 67];
const PROG = [[DM9, 38], [G13, 31], [DM9, 38], [BB, 34]];

function ep(t0, dur, m, gain, rev = 0.22) {
  const f = mtof(m), i0 = Math.floor(t0 * SR), len = Math.floor((dur + 0.5) * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR, i = i0 + j;
    const rel = t > dur ? Math.exp(-(t - dur) * 10) : 1;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 1.2) * rel;
    const I = 1.3 * Math.exp(-t * 4.5) + 0.22;
    let v = Math.sin(2 * Math.PI * f * t + I * Math.sin(2 * Math.PI * f * t));
    v += 0.18 * Math.sin(2 * Math.PI * f * 14 * t) * Math.exp(-t * 30);
    const abs = i / SR;
    add(i, v * env * gain * (i < N ? 0.75 + 0.25 * duck[i] : 1), 0.45 * Math.sin(2 * Math.PI * 4.4 * abs), rev, 0.08);
  }
}
function chord(t0, dur, notes, gain) { notes.forEach((m, k) => ep(t0 + k * 0.009, dur, m, gain * (k === notes.length - 1 ? 1.1 : 1))); }

function boom(t0, gain) {
  const i0 = Math.floor(t0 * SR), len = Math.floor(0.5 * SR);
  let ph = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    ph += 2 * Math.PI * (47 + 85 * Math.exp(-t * 32)) / SR;
    const v = Math.sin(ph) * Math.exp(-t * 6) + 0.3 * Math.sin(ph * 2.01) * Math.exp(-t * 45);
    add(i0 + j, v * 0.9 * gain, 0, 0.02);
  }
  for (let j = 0; j < Math.floor(0.4 * SR); j++) {
    const i = i0 + j;
    if (i < N) duck[i] = Math.min(duck[i], 0.5 + 0.5 * Math.min(1, j / (0.4 * SR)) ** 0.7);
  }
}
function snare(t0, gain) {
  const i0 = Math.floor(t0 * SR), len = Math.floor(0.32 * SR);
  const bp = biquad("bp", 1900, 0.6), hp = biquad("hp", 900, 0.7);
  let ph = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    ph += 2 * Math.PI * (175 + 40 * Math.exp(-t * 60)) / SR;
    const body = Math.sin(ph) * Math.exp(-t * 28) * 0.8;
    const nz = bq(hp, bq(bp, rnd())) * Math.exp(-t * 15) * 1.6;
    add(i0 + j, (body + nz) * 0.8 * gain, 0.05, 0.2);
  }
}
function ghost(t0, gain) { noiseHit(t0, gain, 0.07, "bp", 2300, 1.1, 0.1, 0.1, 55); }
function shat(t0, gain, open = false) { noiseHit(t0, gain, open ? 0.35 : 0.06, "hp", 7600, 0.7, 0.3, 0.04, open ? 9 : 75); }
function crash(t0, gain) { noiseHit(t0, gain, 2.2, "hp", 5200, 0.6, -0.1, 0.35, 2.2); }

function sub(t0, dur, m, gain) {
  const f = mtof(m), i0 = Math.floor(t0 * SR), len = Math.floor((dur + 0.08) * SR);
  let ph = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR, i = i0 + j;
    ph += 2 * Math.PI * f / SR;
    const env = Math.min(1, t / 0.012) * Math.exp(-t * 0.9) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.08) : 1);
    const v = (Math.sin(ph) + 0.18 * Math.sin(2 * ph)) * 0.9;
    add(i, v * env * gain * (i < N ? duck[i] : 1), 0, 0);
  }
}

const KICKS = [[0, 1], [7, 0.55], [10, 0.9]];
const KICKS_B = [[0, 1], [3, 0.4], [10, 0.9], [13, 0.5]];
const HATV = [1, 0.32, 0.6, 0.38];

onBus(() => {
  for (let bar = 2; bar < BARS; bar++) {
    const full = bar * BAR >= DROP;
    const g = full ? 1 : 0.7;
    for (const [s, v] of bar % 2 ? KICKS_B : KICKS) boom(st(bar, s), 0.36 * v * g);
    if (full || bar === 2) {
      snare(st(bar, 4), 0.38 * g);
      snare(st(bar, 12), 0.38 * g);
      if (bar % 2) ghost(st(bar, 15), 0.06);
      ghost(st(bar, 6), 0.035);
      ghost(st(bar, 9), 0.03);
    }
    for (let s = 0; s < 16; s++) {
      const open = s === 14 && bar % 2 === 1 && full;
      if (s === 15 && bar % 2 === 1 && full) continue;
      shat(st(bar, s), (open ? 0.09 : 0.11) * HATV[s % 4] * g, open);
    }
  }
  boom(END, 0.45);
  crash(DROP, 0.05);
  crash(END, 0.04);
});

for (let bar = 0; bar < BARS; bar++) {
  const [notes, root] = PROG[bar % 4];
  const t0 = bar * BAR;
  const g = t0 < DROP ? 0.085 : 0.065;
  if (bar % 4 === 3) {
    chord(st(bar, 0), 6 * S16, BB, g);
    chord(st(bar, 6), 1.5 * S16, BB, g * 0.6);
    chord(st(bar, 8), 4 * S16, A7, g);
    chord(st(bar, 14), 1.5 * S16, A7, g * 0.55);
  } else {
    chord(st(bar, 0), 5 * S16, notes, g);
    chord(st(bar, 6), 1.5 * S16, notes, g * 0.6);
    chord(st(bar, 10), 4 * S16, notes, g * 0.85);
  }
  pad(t0, t0 + BAR, bar % 4 === 3 ? [50, 57, 62] : notes.map((m) => m - 12).slice(0, 3), t0 < DROP ? 0.012 : 0.016);
  if (t0 < BAR * 2) continue;
  const bg = t0 < DROP ? 0.09 : 0.105;
  if (bar % 4 === 3) {
    sub(st(bar, 0), 6 * S16, 34, bg);
    sub(st(bar, 7), 1 * S16, 34, bg * 0.8);
    sub(st(bar, 8), 6 * S16, 33, bg);
    sub(st(bar, 14), 1.5 * S16, 45, bg * 0.7);
  } else {
    sub(st(bar, 0), 6 * S16, root, bg);
    sub(st(bar, 7), 2 * S16, root, bg * 0.8);
    sub(st(bar, 10), 4 * S16, root - 2, bg * 0.9);
  }
}
chord(END, 2.6, [54, 57, 61, 64, 69], 0.05);
sub(END, 2.4, 38, 0.11);
pad(END, END + 2.6, [50, 57, 62, 66], 0.02);

{
  const fl = biquad("lp", 400, 0.8), fr = biquad("lp", 400, 0.8);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (i % 64 === 0) {
      const sweep = t < DROP - BEAT ? 520 : t < DROP ? 520 + 3200 * ((t - (DROP - BEAT)) / BEAT) ** 2 : 8500;
      retune(fl, "lp", sweep, 0.8); retune(fr, "lp", sweep, 0.8);
    }
    const dl = bq(fl, DL[i]), dr = bq(fr, DR[i]);
    L[i] += dl; R[i] += dr;
  }
}

const HOOK_NOTES = [74, 77, 81, 79, 77, 72, 74, 76, 81, 84, 86];
TL.hook.forEach(([, t], k) => pluck(t, HOOK_NOTES[k], k >= 8 ? 0.07 : 0.06, (k % 3 - 1) * 0.3, 0.35, 0.3, 1.2));
bell(TL.hookAttr, 86, 0.045, -0.2, 2.0);
bell(TL.hookAttr, 93, 0.03, 0.2, 2.0);
riser(DROP - 2 * BEAT, DROP, 0.045);
riser(END - 2 * BEAT, END, 0.035);

for (const [id, [c]] of Object.entries(TL.scenes)) if (c > 0) whoosh(c, c === DROP || c === END ? 0.09 : 0.065);

bell(TL.s2.word, 93, 0.035, 0.3, 1.2);
[0, 1, 2, 3, 4].forEach((i) => pluck(TL.s2.chips + i * BEAT / 4, [74, 77, 79, 81, 84][i], 0.04, -0.4 + i * 0.2, 0.3, 0.2, 1));

function typing(t0, step, text, gain = 0.03) {
  for (let k = 0; k < text.length; k++) {
    if (text[k] === " ") continue;
    noiseHit(t0 + k * step, gain + (k % 3) * 0.006, 0.025, "bp", 2400 + (k % 4) * 300, 2.5, 0.25, 0.05, 260);
  }
}

const T3 = TL.s3;
tick(T3.clickLine, 0.12);
typing(T3.typeStart, T3.step, T3.comment);
tick(T3.clickSave, 0.12);
pluck(T3.clickSave, 81, 0.045, 0.2, 0.3, 0.2, 1);
pluck(T3.swap, 86, 0.035, 0.3, 0.3, 0.2, 1);
tick(T3.clickSend, 0.12);
bell(T3.clickSend, 86, 0.05, 0.2, 1.0);
bell(T3.clickSend + BEAT / 2, 81, 0.045, -0.2, 1.0);
bell(T3.revised, 81, 0.035, -0.2, 1.2);
bell(T3.revised + S16 * 2, 86, 0.03, 0.2, 1.2);
tick(T3.clickApprove, 0.12);
[81, 86, 88, 93].forEach((m, k) => bell(T3.clickApprove + k * S16, m, 0.05, -0.3 + k * 0.2, 1.6));

const T4 = TL.s4;
tick(T4.clickWord, 0.11);
T4.keys.forEach((t, k) => keyThock(t, 0.15, [50, 57][k]));
typing(T4.typeStart, T4.step, T4.name);
keyThock(T4.enter, 0.15, 50);
[81, 84, 86].forEach((m, k) => pluck(T4.enter + k * S16, m, 0.04, -0.2 + k * 0.2, 0.3, 0.2, 1));
tick(T4.clickApprove, 0.12);
[81, 86, 88, 93].forEach((m, k) => bell(T4.clickApprove + k * S16, m, 0.05, -0.3 + k * 0.2, 1.6));

const T5 = TL.s5;
typing(T5.typeStart, T5.step, T5.cmd);
keyThock(T5.enter, 0.14, 50);
const ROW = [74, 76, 77, 79, 81, 83, 84, 86, 88, 89];
T5.rows.forEach((t, k) => pluck(t, ROW[k], 0.045, -0.3 + (k % 3) * 0.3, 0.3, 0.25, 1));
tick(T5.clickCs, 0.12);

const T6 = TL.s6;
for (const t of [T6.clickCompare, T6.clickModes]) { tick(t, 0.11); bell(t, 86, 0.03, 0, 1.0); }
for (const t of [T6.pickMerge, T6.pickDelta, T6.pickReview]) { tick(t, 0.1, 93, 0.1); pluck(t, 81, 0.035, 0.2, 0.3, 0.2, 1); }
T6.checks.forEach((t, k) => { tick(t, 0.09); pluck(t, [86, 88][k], 0.035, -0.2, 0.3, 0.2, 1); });

const T7 = TL.s7;
[74, 78, 81, 85, 86].forEach((m, k) => bell(T7.logo + k * BEAT / 2, m, 0.04, -0.4 + k * 0.2, 2.4, 0.6));

{
  const d = Math.floor(0.375 * SR);
  for (let i = d; i < N; i++) dlyIn[i] += dlyIn[i - d] * 0.32;
  for (let i = 0; i < N; i++) { L[i] += dlyIn[i] * 0.45; R[i] += (i >= 240 ? dlyIn[i - 240] : 0) * 0.45; revIn[i] += dlyIn[i] * 0.3; }
}

function reverb(input, combs, aps) {
  const out = new Float32Array(N);
  const lp = 0.25, fb = 0.83;
  for (const len of combs) {
    const buf = new Float32Array(len); let p = 0, z = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[p];
      z = y * (1 - lp) + z * lp;
      buf[p] = input[i] + z * fb;
      out[i] += y;
      p = (p + 1) % len;
    }
  }
  for (const len of aps) {
    const buf = new Float32Array(len); let p = 0;
    for (let i = 0; i < N; i++) {
      const bo = buf[p]; const x = out[i];
      buf[p] = x + bo * 0.5;
      out[i] = bo - x;
      p = (p + 1) % len;
    }
  }
  return out;
}
const pre = Math.floor(0.02 * SR);
const revSrc = new Float32Array(N);
for (let i = pre; i < N; i++) revSrc[i] = revIn[i - pre];
const k = SR / 44100;
const rl = reverb(revSrc, [1116, 1188, 1277, 1356, 1422, 1491].map((x) => Math.floor(x * k * 1.3)), [556, 441, 341].map((x) => Math.floor(x * k)));
const rr = reverb(revSrc, [1139, 1211, 1300, 1379, 1445, 1514].map((x) => Math.floor(x * k * 1.3)), [579, 464, 364].map((x) => Math.floor(x * k)));
for (let i = 0; i < N; i++) { L[i] += rl[i] * 0.11; R[i] += rr[i] * 0.11; }

const hpL = biquad("hp", 28, 0.7), hpR = biquad("hp", 28, 0.7);
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = bq(hpL, L[i]); R[i] = bq(hpR, R[i]);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const fadeStart = DUR - 1.4;
const norm = 0.6 / peak;
let peak2 = 0, sumSq = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const f = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / (DUR - fadeStart)) ** 1.5 : 1;
  const fi = Math.min(1, t / 0.01);
  L[i] = L[i] * norm * f * fi;
  R[i] = R[i] * norm * f * fi;
  peak2 = Math.max(peak2, Math.abs(L[i]), Math.abs(R[i]));
  sumSq += L[i] * L[i] + R[i] * R[i];
}
const g = 0.89 / peak2;
console.log("peak", peak2.toFixed(3), "rms dBFS", (20 * Math.log10(Math.sqrt(sumSq / (2 * N)) * g)).toFixed(1));

const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
}
writeFileSync(new URL("./music.wav", import.meta.url), buf);
