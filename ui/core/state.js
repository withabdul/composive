// Leaf module: shared state and tiny helpers. Imports nothing from the other ui modules.
import { createStage, normalize, kind, MEDIA } from "../canvas/stage.js";
export { normalize, kind, MEDIA };

export const $ = (s) => document.querySelector(s);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Short message in the bottom-right corner, gone after 1.5 s. A new message replaces the one shown.
let toastEl, toastTimer;
export function toast(text) {
  if (!toastEl) {
    toastEl = el("div", "toast");
    toastEl.setAttribute("role", "status"); // screen readers read it out
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1500);
}
export const uid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

export const LABEL = 104; // width of the track header column, px (same as --label in style.css)
export const ROW = { video: 52, audio: 68 }; // track heights, px
export const MIN = 0.1; // shortest clip, seconds
export const DRAG_SRC = "application/x-composive-src"; // drag data: a scene or media path from the sidebar

export const S = {
  tl: null, project: null,
  t: 0, playing: false, tool: "view", pps: 80,
  // Selection: `sel` is the main clip (panel, canvas); `extra` holds the other selected clips.
  // Setting `sel` clears `extra`, so plain code that selects one clip needs no change.
  _sel: null, extra: new Set(),
  get sel() { return this._sel; },
  set sel(v) { this._sel = v; this.extra.clear(); },
  drag: null, // active pointer drag, see timeline.js and gizmo.js
  magnet: false, // on: delete and trim close gaps (ripple); Shift does the other way
  overwrite: false, // on: a clip moved, trimmed or pasted onto another cuts it; off: it goes to a free spot
  focus: "timeline",// "canvas" when the viewer was clicked last: arrow keys then move the selected clip
  bufs: new Map(), peaks: new Map(), // decoded audio by src
  srcs: [], t0: 0, ctxT0: 0, // playing audio sources and clock anchors
};

export const stage = createStage($("#stage"));

// Lets lower modules ask the timeline to repaint without importing it.
export const bus = new EventTarget();
export const redraw = () => bus.dispatchEvent(new Event("redraw"));

export const clips = () => S.tl.tracks.flatMap((t) => t.clips);
// clips on audio tracks (also the sound of a video file), muted or not
export const audioClips = () => S.tl.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clips);
export const findClip = (id) => clips().find((c) => c.id === id);
export const trackOf = (c) => S.tl.tracks.find((t) => t.clips.includes(c));
export const locked = (c) => !!trackOf(c)?.lock;
// what a clip is on the timeline: on an audio track always "audio", even when its src is a video file
export const clipKind = (c) => (trackOf(c)?.type === "audio" ? "audio" : kind(c.src));
// the clips plus the unlocked clips linked to them (same `link` id: a video and its sound)
export function withLinked(cs) {
  const ids = new Set(cs.map((c) => c.link).filter(Boolean));
  return [...new Set([...cs, ...clips().filter((x) => x.link && ids.has(x.link) && !locked(x))])];
}
export const selIds = () => (S.sel ? [...S.extra, S.sel] : []); // main clip last
export const isSel = (id) => id === S.sel || S.extra.has(id);
export const selected = () => selIds().map(findClip).filter(Boolean);
export function setSel(ids) {
  S.sel = ids.at(-1) ?? null;
  for (const id of ids.slice(0, -1)) S.extra.add(id);
}
export const EPS = 1e-6;
export const totalDur = () =>Math.max(0, ...clips().map((c) => c.start + c.duration));
export const snap = (t) => Math.round(t * S.tl.fps) / S.tl.fps;
export const metaDur = (doc) => Number(doc?.querySelector('meta[name="duration"]')?.content) || 3;
