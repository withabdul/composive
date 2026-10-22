// Audio: decode + waveform peaks, scheduled playback with fades, output level meter.
// The audio clock drives playback time, see viewer.js.
import { $, S, clamp, redraw } from "../core/state.js";
import { audible } from "../canvas/stage.js";

export const actx = new AudioContext();
const master = actx.createGain();
const analyser = actx.createAnalyser();
analyser.fftSize = 1024;
master.connect(analyser);
analyser.connect(actx.destination);

export async function loadAudio(src) {
  if (S.bufs.has(src)) return;
  S.bufs.set(src, null); // mark in-flight
  try {
    const ab = await (await fetch("/p/" + src)).arrayBuffer();
    const b = await actx.decodeAudioData(ab);
    S.bufs.set(src, b);
    S.peaks.set(src, peaksOf(b));
    redraw();
  } catch {
    S.bufs.delete(src);
  }
}

// 100 peaks per second, max over all channels
function peaksOf(b) {
  const n = Math.ceil(b.duration * 100), step = b.sampleRate / 100, out = new Float32Array(n);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = out[i];
      for (let j = Math.floor(i * step), e = Math.min(d.length, Math.floor((i + 1) * step)); j < e; j++) m = Math.max(m, Math.abs(d[j]));
      out[i] = m;
    }
  }
  return out;
}

function gainAt(c, x) {
  const fi = c.fadeIn || 0, fo = c.fadeOut || 0;
  return Math.min(1, fi ? x / fi : 1, fo ? (c.duration - x) / fo : 1);
}

export function startAudio(t0) {
  stopAudio();
  S.t0 = t0;
  S.ctxT0 = actx.currentTime + 0.05;
  for (const c of audible(S.tl)) { // mute and solo apply
    const buf = S.bufs.get(c.src);
    if (!buf || c.start + c.duration <= t0) continue;
    const skip = Math.max(0, t0 - c.start), dur = c.duration - skip;
    const when = S.ctxT0 + Math.max(0, c.start - t0), vol = c.volume ?? 1;
    const src = actx.createBufferSource(), g = actx.createGain();
    src.buffer = buf;
    g.gain.setValueAtTime(gainAt(c, skip) * vol, when);
    const fi = c.fadeIn || 0, fo = c.fadeOut || 0;
    if (fi > skip) g.gain.linearRampToValueAtTime(vol, when + fi - skip);
    if (fo) {
      const fs = c.duration - fo;
      if (fs > skip) g.gain.setValueAtTime(vol, when + fs - skip);
      g.gain.linearRampToValueAtTime(0, when + dur);
    }
    src.connect(g).connect(master);
    src.start(when, (c.offset || 0) + skip, dur);
    S.srcs.push(src);
  }
}

export function stopAudio() {
  for (const s of S.srcs) { try { s.stop(); } catch {} s.disconnect(); }
  S.srcs = [];
}

const lvlBuf = new Float32Array(1024);
let lvl = 0;

export function drawMeter() {
  analyser.getFloatTimeDomainData(lvlBuf);
  let pk = 0;
  for (const v of lvlBuf) pk = Math.max(pk, Math.abs(v));
  const db = 20 * Math.log10(pk || 1e-5);
  lvl = Math.max(clamp((db + 60) / 60, 0, 1), lvl * 0.9);
  $("#meter i").style.width = lvl * 100 + "%";
}

export function resetMeter() {
  lvl = 0;
  $("#meter i").style.width = "0";
}
