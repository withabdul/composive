// Scenes <-> one timeline. Shared by the editor and the export (no DOM here).
//
// On disk: <project>/timeline.json holds fps, size, range, markers and the global tracks (ids start
// with "G", e.g. "GA1" for the music). Each scenes/###-slug/timeline.json holds that scene's tracks,
// with times from 0. A scene starts where the scene before it ends (the end of its last clip).
// In memory the editor works on one timeline in video time: compose() builds it, split() takes it apart.
import { normalize } from "../canvas/stage.js";

export const SCENE = /^\d{3}-[a-z0-9][a-z0-9-]*$/; // folder name of a scene, e.g. 001-hook
export const isGlobal = (tr) => tr.id.startsWith("G");
const end = (tl) => Math.max(0, ...tl.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
const round = (t) => Math.round(t * 1e6) / 1e6; // 0.1 + 0.2 must not be saved as 0.30000000000000004

// p = { timeline, scenes: [{ slug, timeline }] } (the /api/project answer).
// slug: that scene and the global tracks; no slug: every scene (track ids "001-hook/V1") and the global tracks.
// a, b = the time window of that scene (or of the whole video) in video time.
export function compose(p, slug) {
  const tl = normalize(structuredClone(p.timeline));
  for (const tr of tl.tracks) if (!isGlobal(tr)) tr.id = "G" + tr.id;
  const own = [];
  let t = 0, a = 0, b = 0;
  for (const s of p.scenes) {
    const st = normalize(structuredClone(s.timeline)), o = t;
    t += end(st);
    if (slug && slug !== s.slug) continue;
    for (const c of st.tracks.flatMap((tr) => tr.clips)) c.start = round(c.start + o);
    if (slug) {
      tl.markers = (st.markers ?? []).map((m) => ({ ...m, t: round(m.t + o) }));
      [a, b] = [o, t];
    } else for (const tr of st.tracks) tr.id = `${s.slug}/${tr.id}`;
    own.push(...st.tracks);
  }
  if (!slug) b = t;
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
