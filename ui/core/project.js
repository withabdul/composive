// Scenes <-> one timeline. Shared by the editor and the export (no DOM here).
//
// On disk: <project>/timeline.json holds fps, size, range, markers and the global tracks (ids start
// with "G", e.g. "GA1" for the music). Each scenes/###-slug/timeline.json holds that scene's tracks,
// with times from 0. A scene starts where the scene before it ends (the end of its last clip).
// In memory the editor works on one timeline in video time: compose() builds it, split() takes it apart.
import { normalize } from "../canvas/stage.js";

export const SCENE = /^\d{3}-[a-z0-9][a-z0-9-]*$/; // folder name of a scene, e.g. 001-hook

// Frame sizes for `composive new --preset` and the editor's size dialog.
export const FORMATS = [
  { id: "youtube", label: "YouTube, 16:9", width: 1920, height: 1080 },
  { id: "reels", label: "Reels / TikTok / Shorts, 9:16", width: 1080, height: 1920 },
  { id: "square", label: "Square, 1:1", width: 1080, height: 1080 },
  { id: "portrait", label: "Instagram feed, 4:5", width: 1080, height: 1350 },
  { id: "4k", label: "4K, 16:9", width: 3840, height: 2160 },
];
export const FPS = [24, 25, 30, 50, 60];
export const formatOf = (tl) => FORMATS.find((f) => f.width === tl.width && f.height === tl.height);
export const isGlobal = (tr) => tr.id.startsWith("G");
export const end = (tl) => Math.max(0, ...(tl.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.start + c.duration)));
const round = (t) => Math.round(t * 1e6) / 1e6; // 0.1 + 0.2 must not be saved as 0.30000000000000004

// Fields of a scene's timeline.json that the view timeline does not hold (split leaves them out).
export function withSceneFields(scene, old) {
  for (const k of ["transition", "out"]) if (old?.[k]) scene[k] = old[k];
  return scene;
}

// Where each scene is in video time: [{ slug, a, b, x, in, out }], each transition with the duration used.
// A scene's `transition` ({ type, duration, ease, ... }) after another scene is x: the scene starts `duration`
// earlier, over the end of the scene before (never longer than this scene, nor than the part of the scene
// before that its own transition leaves). On the first scene, or with `only: true`, it is `in` instead: no
// overlap, it plays over the start of this scene only. `out` plays over the end of this scene, unless the
// next scene's x uses that seam. len(s) = the length of scene s (default: the end of its last clip).
export function layout(p, len = (s) => end(s.timeline)) {
  let t = 0, free = 0;
  const L = p.scenes.map((s, i) => {
    const l = len(s), x = s.timeline.transition, o = s.timeline.out, pair = x?.type && i && !x.only;
    const d = pair ? Math.max(0, Math.min(x.duration ?? 0.6, l, t - free)) : 0;
    const a = round(t - d);
    free = t;
    t = round(a + l);
    const solo = (y) => (y?.type ? { ...y, duration: Math.min(y.duration ?? 0.6, l) } : null);
    return { slug: s.slug, a, b: t, x: d > 0 ? { ...x, duration: d } : null, in: pair ? null : solo(x), out: solo(o) };
  });
  L.forEach((w, i) => { if (L[i + 1]?.x) w.out = null; });
  return L;
}

// p = { timeline, scenes: [{ slug, timeline }] } (the /api/project answer).
// slug: that scene and the global tracks; no slug: every scene (track ids "001-hook/V1") and the global tracks.
// a, b = the time window of that scene (or of the whole video) in video time.
// tl.transitions lists the scene transitions { ...x, a, b, from, to } (both views); from = null: an `in` of
// scene `to` alone, to = null: an `out` of scene `from` alone. tl.view is the scene shown.
export function compose(p, slug) {
  const tl = normalize(structuredClone(p.timeline));
  for (const tr of tl.tracks) if (!isGlobal(tr)) tr.id = "G" + tr.id;
  const own = [], L = layout(p);
  tl.transitions = L.flatMap((w, i) => [
    ...(w.x ? [{ ...w.x, a: w.a, b: L[i - 1].b, from: L[i - 1].slug, to: w.slug }] : []),
    ...(w.in ? [{ ...w.in, a: w.a, b: w.a + w.in.duration, from: null, to: w.slug }] : []),
    ...(w.out ? [{ ...w.out, a: w.b - w.out.duration, b: w.b, from: w.slug, to: null }] : []),
  ]);
  tl.view = slug;
  let a = 0, b = 0;
  for (const [i, s] of p.scenes.entries()) {
    const st = normalize(structuredClone(s.timeline)), o = L[i].a, t = L[i].b;
    if (slug && slug !== s.slug) continue;
    for (const c of st.tracks.flatMap((tr) => tr.clips)) c.start = round(c.start + o);
    if (slug) {
      tl.markers = (st.markers ?? []).map((m) => ({ ...m, t: round(m.t + o) }));
      [a, b] = [o, t];
    } else for (const tr of st.tracks) tr.id = `${s.slug}/${tr.id}`;
    own.push(...st.tracks);
  }
  if (!slug) b = L.at(-1)?.b ?? 0;
  if (!tl.markers?.length) delete tl.markers;
  tl.tracks = [...own, ...tl.tracks];
  return { tl, a, b };
}

// The editor timeline back to files. slug: the scene shown (its clips start at `a`); no slug: only the
// global part is saved (the scene tracks are shown read-only). `base` = the global timeline as on disk.
export function split(tl, base, slug, a) {
  const global = { ...base, fps: tl.fps, width: tl.width, height: tl.height, tracks: tl.tracks.filter(isGlobal) };
  if (tl.range) global.range = tl.range; else delete global.range;
  if (!slug) {
    if (tl.markers?.length) global.markers = tl.markers; else delete global.markers;
    return { global };
  }
  const scene = {
    tracks: tl.tracks.filter((t) => !isGlobal(t)).map((tr) => ({
      ...tr, clips: tr.clips.map((c) => ({ ...c, start: round(Math.max(0, c.start - a)) })),
    })),
  };
  if (tl.markers?.length) scene.markers = tl.markers.map((m) => ({ ...m, t: round(Math.max(0, m.t - a)) }));
  return { global, scene };
}
