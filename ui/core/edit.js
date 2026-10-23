// All timeline mutations. Every change ends in commit(): re-sort, re-render, repaint, save.
import { S, stage, bus, MIN, EPS, clamp, uid, kind, clips, findClip, trackOf, locked, withLinked, isSel, selected, setSel, metaDur, el, redraw, snap, toast, clipKind } from "./state.js";
import { H, record, snapshot as projectSnapshot } from "./history.js";
import { split, compose, isGlobal, withSceneFields } from "./project.js";
import { loadAudio, startAudio } from "../timeline/audio.js";

// The global part goes to timeline.json, the scene shown to scenes/<slug>/timeline.json. S.project
// keeps the same data, so a switch to another scene builds its view from the latest state.
let saveTimer = null;
const sent = new Map(); // url -> last body sent: an unchanged part is not written again
let writes = Promise.resolve();
function put(url, data) {
  const body = JSON.stringify(data);
  if (sent.get(url) === body) return;
  sent.set(url, body);
  writes = Promise.all([writes, fetch(url, { method: "PUT", body }).catch(() => {})]);
}
// every edit is on disk (the export reads the files)
export function saved() { flushSave(); return writes; }
export function flushSave() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const { global, scene } = split(S.tl, S.project.timeline, S.scene, S.win.a);
  S.project.timeline = global;
  put("/api/timeline", global);
  const s = scene && S.project.scenes.find((x) => x.slug === S.scene);
  if (s) { // gone when its folder was deleted on disk
    s.timeline = withSceneFields(scene, s.timeline);
    put("/api/timeline?scene=" + S.scene, scene);
  }
}

// A transition of scene `slug`: side "in" (`transition` in its timeline.json: from the scene before, or alone)
// or "out" (`out`); null removes it. It can move scene starts, so app.js builds the view again ("scenetr" event).
export function setTransition(slug, x, side = "in") {
  flushSave();
  const s = S.project.scenes.find((sc) => sc.slug === slug), key = side === "out" ? "out" : "transition";
  if (!s) return;
  if (x) s.timeline[key] = x; else delete s.timeline[key];
  put("/api/timeline?scene=" + slug, s.timeline);
}
export const sceneTransition = (slug, x, side = "in") => bus.dispatchEvent(new CustomEvent("scenetr", { detail: { slug, x, side } }));

// A clip transition: side "in" (at its start; at a cut, the transition between the two clips) or "out"
// (at its end); null removes it. One undo step.
export function setClipTransition(c, side, x) {
  if (locked(c)) return;
  record();
  if (x) c[side] = x; else delete c[side];
  commit();
}

// The selected transition (S.trSel), as { x, c, set } with set(next) storing it (null = delete), or null.
export function selTransition() {
  const t = S.trSel;
  if (t?.kind === "scene") {
    const x = S.project.scenes.find((s) => s.slug === t.slug)?.timeline[t.side === "out" ? "out" : "transition"];
    return x && { x, set: (n) => sceneTransition(t.slug, n, t.side) };
  }
  const c = t && findClip(t.id);
  return c?.[t.side] ? { x: c[t.side], c, set: (n) => setClipTransition(c, t.side, n) } : null;
}
// S.tl for the scene S.scene: its tracks in video time, the global tracks below. "" = all scenes:
// every scene's tracks read-only (`ro`, locked, not saved), the global tracks editable.
export function view() {
  if (S.scene && !S.project.scenes.some((s) => s.slug === S.scene)) S.scene = ""; // its folder is gone
  const { tl, a, b } = compose(S.project, S.scene || undefined);
  if (!S.scene) for (const tr of tl.tracks) if (!isGlobal(tr)) tr.lock = tr.ro = true;
  S.tl = tl;
  S.win = { a, b };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200);
}

export function commit() {
  S.tl.tracks.sort((a, b) => isGlobal(a) - isGlobal(b)); // scene tracks on top, global tracks below them
  for (const tr of S.tl.tracks) {
    // a scene clip cannot start before its scene (one rule here, for every edit that moves clips)
    if (S.scene && !isGlobal(tr)) for (const c of tr.clips) c.start = Math.max(c.start, S.win.a);
    tr.clips.sort((a, b) => a.start - b.start);
  }
  if (S.scene) S.win.b = Math.max(S.win.a, ...S.tl.tracks.filter((t) => !isGlobal(t)).flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  if (S.playing) startAudio(S.t);
  stage.setTimeline(S.tl);
  stage.render(S.t, S.playing);
  redraw();
  save();
}

export function clampFades(c) {
  c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration);
  c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration - c.fadeIn);
  if (!c.fadeIn) delete c.fadeIn;
  if (!c.fadeOut) delete c.fadeOut;
}

// Split at ts; linked clips (a video and its sound) split too and the right halves stay linked.
export function splitClip(c, ts, linked = true) {
  const cs = (linked ? withLinked([c]) : [c]).filter((x) => ts > x.start + MIN && ts < x.start + x.duration - MIN);
  if (!cs.includes(c) || locked(c)) return;
  record();
  const link = cs.length > 1 ? uid() : undefined;
  for (const x of cs) {
    const b = { ...x, id: uid(), start: ts, duration: x.start + x.duration - ts, offset: (x.offset || 0) + ts - x.start, fadeIn: 0 };
    if (link) b.link = link; else delete b.link; // a half split alone is not linked to the other's sound
    if (x.keys) b.keys = structuredClone(x.keys); // each half gets its own keys (same times: they use content time)
    delete b.in; delete x.out; // the transition in stays at the start, the transition out at the end
    b.total = x.total ?? x.duration; // scene keeps its original length so motion continues across the split
    x.total = b.total;
    x.duration = ts - x.start;
    x.fadeOut = 0;
    clampFades(x); clampFades(b);
    trackOf(x).clips.push(b);
    if (x === c) S.sel = b.id;
  }
  commit();
}

// Removes the clips and the clips linked to them (unless linked = false); locked tracks are kept.
// Ripple: on each track, later clips move left to close the gap.
export function removeClips(cs, ripple = false, linked = true) {
  cs = (linked ? withLinked(cs) : cs).filter((c) => !locked(c));
  if (!cs.length) return;
  record();
  for (const c of [...cs].sort((a, b) => b.start - a.start)) { // last first, so ripple shifts add up right
    const tr = trackOf(c);
    tr.clips.splice(tr.clips.indexOf(c), 1);
    if (ripple) for (const x of tr.clips) if (x.start >= c.start + c.duration - EPS) x.start = Math.max(0, x.start - c.duration);
  }
  if (cs.some((c) => isSel(c.id))) S.sel = null;
  commit();
}
export const removeClip = (c) => removeClips([c]);

// Overwrite: the `top` clips cut the parts of other clips on their track that they cover
// (trim a head or tail, split if covered in the middle, remove if covered fully).
export function carve(top) {
  const keep = new Set(top);
  for (const t of top) {
    const tr = trackOf(t), s = t.start, e = t.start + t.duration;
    for (const x of [...tr.clips]) {
      const xs = x.start, xe = x.start + x.duration;
      if (keep.has(x) || xe <= s + EPS || xs >= e - EPS) continue;
      if (xs >= s - EPS && xe <= e + EPS) { tr.clips.splice(tr.clips.indexOf(x), 1); continue; }
      x.total ??= x.duration; // a scene keeps its motion timing, as with split
      if (xs < s && xe > e) {
        const right = { ...structuredClone(x), id: uid(), start: e, duration: xe - e, offset: (x.offset || 0) + e - xs, fadeIn: 0 };
        delete right.link; // its linked sound was not cut
        delete right.in; delete x.out; // as with split
        x.duration = s - xs;
        x.fadeOut = 0;
        clampFades(right);
        tr.clips.push(right);
      } else if (xs < s) {
        x.duration = s - xs;
      } else {
        x.offset = (x.offset || 0) + e - xs;
        x.duration = xe - e;
        x.start = e;
      }
      clampFades(x);
    }
  }
}

// Clips that landed on a used spot (a drop, paste, panel edit): Overwrite cuts the clips there, else
// they go to a new track next to it. Clips never overlap on a track.
export const place = (cs) => (S.overwrite ? carve : bump)(cs);

/* ---------- tracks ---------- */

// first free id like V3 or A2; a global track gets a "G" in front (GA1). In "all scenes" new tracks are global.
function nextId(type, global = !S.scene) {
  const prefix = (global ? "G" : "") + (type === "audio" ? "A" : "V");
  let n = 1;
  while (S.tl.tracks.some((t) => t.id === prefix + n)) n++;
  return prefix + n;
}

// an unlocked track of this type in the group being edited (the first, or one free over start..end), else a new one
function trackFor(type, start, end) {
  const ok = (t) => t.type === type && !t.lock && isGlobal(t) === !S.scene;
  const free = (t) => end === undefined || t.clips.every((x) => x.start >= end - EPS || x.start + x.duration <= start + EPS);
  let tr = S.tl.tracks.find((t) => ok(t) && free(t));
  if (!tr) {
    tr = { id: nextId(type), type, clips: [] };
    type === "audio" ? S.tl.tracks.push(tr) : S.tl.tracks.unshift(tr); // new video goes on top, new audio at the bottom
  }
  return tr;
}

// a new empty track next to `tr` (in its group): above it for video (a layer in front), below it for audio
function trackNextTo(tr) {
  const nt = { id: nextId(tr.type, isGlobal(tr)), type: tr.type, clips: [] };
  const i = S.tl.tracks.indexOf(tr);
  S.tl.tracks.splice(tr.type === "audio" ? i + 1 : i, 0, nt);
  return nt;
}

// Overwrite off: where clips now cover other clips, they go (with the rest of the group on that
// track) to a new track next to it, so nothing is cut or pushed away.
export function bump(cs) {
  const skip = new Set(cs);
  const covers = (c) => trackOf(c).clips.some((x) => !skip.has(x) && x.start < c.start + c.duration - EPS && x.start + x.duration > c.start + EPS);
  for (const tr of new Set(cs.filter(covers).map(trackOf))) {
    const nt = trackNextTo(tr);
    for (const c of cs) if (trackOf(c) === tr) { tr.clips.splice(tr.clips.indexOf(c), 1); nt.clips.push(c); }
  }
}

export function addTrack(type) {
  record();
  const tr = { id: nextId(type), type, clips: [] };
  type === "audio" ? S.tl.tracks.push(tr) : S.tl.tracks.unshift(tr);
  commit();
}

// G button on a track header (scene view): the track moves between this scene and the global tracks.
// Clips keep their video time; a global track made a scene track has its clips held inside the scene by commit().
export function toggleGlobal(id) {
  const tr = S.tl.tracks.find((t) => t.id === id);
  if (!tr || !S.scene) return;
  record();
  tr.id = nextId(tr.type, !isGlobal(tr));
  commit();
}

export function deleteTrack(id) {
  record();
  S.tl.tracks = S.tl.tracks.filter((t) => t.id !== id);
  if (S.sel && !findClip(S.sel)) S.sel = null;
  commit();
}

// toggles a track flag: hide (video), mute / solo (audio), lock
export function toggleTrack(id, key) {
  const tr = S.tl.tracks.find((t) => t.id === id);
  record();
  if (tr[key]) delete tr[key]; else tr[key] = true;
  if (key === "lock" && tr.lock && selected().some((c) => trackOf(c) === tr)) S.sel = null; // locked clips cannot stay selected
  commit();
}

// ducking of an audio track: the gain it goes down to while a voice track plays (null = off). One undo step.
export function setDuck(id, v) {
  const tr = S.tl.tracks.find((t) => t.id === id);
  if (!tr || (tr.duck ?? null) === v) return;
  record();
  if (v == null) delete tr.duck; else tr.duck = clamp(v, 0, 0.99);
  commit();
}

export function renameTrack(id, name) {
  const tr = S.tl.tracks.find((t) => t.id === id);
  name = name.trim();
  if ((tr.name ?? "") === name) return;
  record();
  if (name && name !== tr.id) tr.name = name; else delete tr.name;
  commit();
}

// moves track `id` to the place of track `to` (a drag on the track header)
export function reorderTrack(id, to) {
  const ts = S.tl.tracks, i = ts.findIndex((t) => t.id === id), j = ts.findIndex((t) => t.id === to);
  if (i < 0 || j < 0 || i === j) return false;
  ts.splice(j, 0, ts.splice(i, 1)[0]);
  return true;
}

/* ---------- link ---------- */

// Ctrl+L: unlink the selected linked clips, or link the selection (2 or more clips) into one group.
export function toggleLink() {
  const cs = selected();
  if (!cs.length) return;
  const linked = cs.filter((c) => c.link);
  if (!linked.length && cs.length < 2) return;
  record();
  if (linked.length) {
    const ids = new Set(linked.map((c) => c.link));
    for (const c of clips()) if (ids.has(c.link)) delete c.link;
  } else {
    const link = uid();
    for (const c of cs) c.link = link;
  }
  commit();
}

/* ---------- copy, paste, duplicate ---------- */

// items: [{ track, type, c }]; the earliest clip lands at `at`, the others keep their distance to it.
function insertCopies(items, at) {
  if (!items.length) return;
  record();
  const t0 = Math.min(...items.map((x) => x.c.start));
  const links = new Map(); // copies get their own link ids, so they do not join the originals
  const made = items.map(({ track, type, c }) => {
    let tr = S.tl.tracks.find((t) => t.id === track);
    if (!tr || tr.lock) tr = trackFor(type);
    const copy = { ...structuredClone(c), id: uid(), start: c.start - t0 + at };
    if (copy.link) {
      if (!links.has(copy.link)) links.set(copy.link, uid());
      copy.link = links.get(copy.link);
    }
    tr.clips.push(copy);
    return copy;
  });
  place(made);
  setSel(made.map((c) => c.id));
  commit();
}

const snapshot = (cs) => cs.map((c) => ({ track: trackOf(c).id, type: trackOf(c).type, c: structuredClone(c) }));
let clipboard = [];
export function copySel() { clipboard = snapshot(selected()); }
export const paste = () => insertCopies(clipboard, snap(S.t));
export function duplicate(cs) {
  if (cs.length) insertCopies(snapshot(cs), Math.max(...cs.map((c) => c.start + c.duration)));
}
export const duplicateClip = (c) => duplicate(withLinked([c]));

/* ---------- keyframes (clip.keys, see canvas/stage.js) ---------- */

// clip-local time of timeline time t (the time keyframes use), on a whole frame
export const localAt = (c, t = S.t) => snap(t) - c.start + (c.offset || 0);
const keyAt = (ks, lt) => ks?.find((k) => Math.abs(k.t - lt) < EPS);
// the fixed (not animated) value of a keyable value: an audio clip's volume is c.volume, the rest is in c.props
function fixed(c, key, v) {
  if (key === "volume" && clipKind(c) === "audio") c.volume = v;
  else c.props = { ...c.props, [key]: v };
}

// Writes a prop at the playhead: into its keyframes when it has some (auto-key: a key there is
// changed or added), else as the clip's fixed value. The caller commits.
export function setProp(c, key, v) {
  if (typeof v === "number" && !Number.isFinite(v)) return; // NaN would be saved as null (e.g. resize of a 0-size box)
  const ks = c.keys?.[key];
  if (!ks?.length) return fixed(c, key, v);
  const lt = localAt(c), k = keyAt(ks, lt);
  if (k) k.v = v;
  else { ks.push({ t: lt, v }); ks.sort((a, b) => a.t - b.t); }
}

// ◆ in the panel: add a key at the playhead with the value seen now, or remove the key there.
// Removing the last key keeps its value as the clip's fixed value.
export function toggleKey(c, key, now) {
  record();
  const lt = localAt(c), ks = ((c.keys ??= {})[key] ??= []), k = keyAt(ks, lt);
  if (!k) { ks.push({ t: lt, v: now }); ks.sort((a, b) => a.t - b.t); }
  else {
    ks.splice(ks.indexOf(k), 1);
    if (!ks.length) {
      delete c.keys[key];
      fixed(c, key, k.v);
    }
  }
  if (!Object.keys(c.keys).length) delete c.keys;
  commit();
}

export function setEase(c, key, ease) {
  const k = keyAt(c.keys?.[key], localAt(c));
  if (!k || (k.ease ?? "linear") === ease) return;
  record();
  if (ease === "linear") delete k.ease; else k.ease = ease;
  commit();
}

// all keys of a clip at clip-local time lt (a ◆ on the timeline)
export function removeKeysAt(c, lt) {
  record();
  for (const [key, ks] of Object.entries(c.keys ?? {})) {
    const left = ks.filter((k) => Math.abs(k.t - lt) >= EPS);
    if (left.length) c.keys[key] = left;
    else { fixed(c, key, ks.find((k) => Math.abs(k.t - lt) < EPS).v); delete c.keys[key]; }
  }
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  commit();
}

/* ---------- markers ---------- */

// Markers (`timeline.markers`: { id, t, name?, color? }) are named points in time on the ruler.
export const MARKER_COLOR = "#ff9f43";

export function addMarker(t) {
  t = snap(t);
  if (S.tl.markers?.some((m) => Math.abs(m.t - t) < EPS)) return; // one marker per frame
  record();
  (S.tl.markers ??= []).push({ id: uid(), t });
  S.tl.markers.sort((a, b) => a.t - b.t);
  commit();
}

export function setMarker(id, patch) {
  const m = S.tl.markers?.find((x) => x.id === id);
  if (!m) return;
  const next = { ...m, ...patch };
  if (!next.name) delete next.name;
  if (!next.color || next.color === MARKER_COLOR) delete next.color;
  if (JSON.stringify(next) === JSON.stringify(m)) return;
  record();
  Object.assign(m, next);
  for (const k of ["name", "color"]) if (!(k in next)) delete m[k];
  commit();
}

export function removeMarker(id) {
  if (!S.tl.markers?.some((m) => m.id === id)) return;
  record();
  S.tl.markers = S.tl.markers.filter((m) => m.id !== id);
  if (!S.tl.markers.length) delete S.tl.markers;
  commit();
}

/* ---------- range ---------- */

// In/out markers (`timeline.range`): the export renders only this part.
export function setRange(which) {
  record();
  const r = { ...S.tl.range, [which]: snap(S.t) };
  if (r.in != null && r.out != null && r.out <= r.in) delete r[which === "in" ? "out" : "in"]; // keep in < out
  S.tl.range = r;
  commit();
}
export function clearRange() {
  if (!S.tl.range) return;
  record();
  delete S.tl.range;
  commit();
}

/* ---------- frame size ---------- */

// Frame size and fps of the whole video (the global timeline.json). Positions are fractions of the frame,
// so clips keep their place; HTML clips draw at the new size.
export function setFormat({ width, height, fps }) {
  if (width === S.tl.width && height === S.tl.height && fps === S.tl.fps) return;
  record();
  Object.assign(S.tl, { width, height, fps });
  commit();
}

/* ---------- add ---------- */

// Dragging a clip vertically moves it to track `id` (the one under the pointer) if unlocked and of the same type.
export function moveTrack(c, id) {
  const to = S.tl.tracks.find((t) => t.id === id), from = trackOf(c);
  if (!to || to === from || to.type !== from.type || to.lock) return;
  from.clips.splice(from.clips.indexOf(c), 1);
  to.clips.push(c);
}

async function probe(src) {
  const k = kind(src);
  if (k === "scene") {
    const url = src[0] === "@" ? `/t/${src.slice(1)}/index.html` : "/p/" + src; // "@text" = templates/text/index.html
    return metaDur(new DOMParser().parseFromString(await (await fetch(url)).text(), "text/html"));
  }
  if (k === "audio") { await loadAudio(src); return S.bufs.get(src)?.duration ?? 3; }
  if (k === "video") {
    return new Promise((r) => {
      const v = el("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => r(v.duration);
      v.onerror = () => r(3);
      v.src = "/p/" + src;
    });
  }
  return 3;
}

// The server says if a file has sound (ffprobe), so a silent video is not decoded; without ffprobe
// the browser tries to decode it, which fails quietly when there is no sound.
async function hasSound(src) {
  const r = await fetch("/api/probe?src=" + encodeURIComponent(src)).catch(() => null);
  return r?.ok ? (await r.json()).audio : true; // unknown: try to decode
}

// A video with sound also gets its sound as a linked clip on an audio track (free at that time).
// `at` = { t, track } for a drop on the timeline: start at t on that track. Where it is used, Overwrite
// cuts the clips there, else the clip goes to a new track next to it. A drop below the tracks (no track)
// makes a new track. Without `at`: the end of the first track of its type.
export async function addClip(src, at) {
  const k = kind(src), type = k === "audio" ? "audio" : "video";
  const duration = await probe(src);
  if (k === "video" && (await hasSound(src))) await loadAudio(src);
  const sound = k === "video" && !!S.bufs.get(src);
  record();
  let tr, start;
  if (!at) {
    tr = trackFor(type);
    start = tr.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  } else {
    start = Math.max(0, at.t);
    tr = S.tl.tracks.find((t) => t.id === at.track && t.type === type && !t.lock);
    if (!tr && at.track === undefined) { // below the tracks: a new last track of this type
      tr = { id: nextId(type), type, clips: [] };
      const lastVideo = S.tl.tracks.findLastIndex((t) => t.type !== "audio");
      S.tl.tracks.splice(type === "audio" ? S.tl.tracks.length : lastVideo + 1, 0, tr);
    }
    tr ??= trackFor(type, start, start + duration); // a track of the other type, or locked: a free one of this type
  }
  const c = { id: uid(), src, start, duration };
  tr.clips.push(c);
  if (at) place([c]);
  if (sound) {
    const a = { id: uid(), src, start, duration, link: uid() };
    c.link = a.link;
    trackFor("audio", start, start + duration).clips.push(a);
    setSel([a.id, c.id]);
  } else S.sel = c.id;
  commit();
}

// A template (templates/<slug>/index.html, src "@slug") at the playhead, like a drop there: on the top
// video track, or the bottom one when the template says so (a background, e.g. solid).
export function addTemplate({ slug, bottom }) {
  const videos = S.tl.tracks.filter((t) => t.type === "video");
  return addClip("@" + slug, { t: snap(S.t), track: (bottom ? videos.at(-1) : videos[0])?.id });
}

// Where media `src` is used: [{ name, n }] per scene file ("global" = the global tracks), from the saved state.
export function mediaUses(src) {
  flushSave(); // S.project then holds the edits shown
  const count = (tl) => tl.tracks.flatMap((t) => t.clips).filter((c) => c.src === src).length;
  return [{ name: "global", n: count(S.project.timeline) }, ...S.project.scenes.map((s) => ({ name: s.slug, n: count(s.timeline) }))]
    .filter((u) => u.n);
}

// Deletes a media file (the server moves it to .trash/) and every clip that uses it, in all scenes.
// The clips in the view shown can be undone; those of the other scenes are saved at once.
export async function removeMedia(src) {
  const used = (c) => c.src === src;
  if (clips().some(used)) {
    record();
    for (const tr of S.tl.tracks) tr.clips = tr.clips.filter((c) => !used(c));
    if (S.sel && !findClip(S.sel)) S.sel = null;
    commit();
  }
  flushSave();
  for (const s of S.project.scenes) {
    if (s.slug === S.scene || !s.timeline.tracks.some((t) => t.clips.some(used))) continue;
    for (const tr of s.timeline.tracks) tr.clips = tr.clips.filter((c) => !used(c));
    await fetch("/api/timeline?scene=" + s.slug, { method: "PUT", body: JSON.stringify(s.timeline) });
  }
  const res = await fetch("/api/media?src=" + encodeURIComponent(src), { method: "DELETE" });
  toast(res.ok ? `Moved ${src.split("/").pop()} to .trash/` : "Could not delete: " + (await res.text()));
}

export function removeEmptyTracks() {
  if (S.tl.tracks.every((t) => t.clips.length)) return;
  record();
  S.tl.tracks = S.tl.tracks.filter((t) => t.clips.length);
  commit();
}

// Undo/redo: put a project snapshot back. Only the timeline files that differ are written; the view stays
// on the scene shown, and the toast names the other scenes that changed.
function step(from, to, name) {
  if (S.drag) return;
  if (!from.length) return toast(`Nothing to ${name.toLowerCase()}`);
  to.push(projectSnapshot());
  const p = JSON.parse(from.pop()), changed = [];
  clearTimeout(saveTimer);
  saveTimer = null;
  if (JSON.stringify(p.timeline) !== JSON.stringify(S.project.timeline)) {
    S.project.timeline = p.timeline;
    put("/api/timeline", p.timeline);
  }
  for (const s of S.project.scenes) { // a scene made or deleted since the snapshot is left as it is
    const t = p.scenes[s.slug];
    if (!t || JSON.stringify(t) === JSON.stringify(s.timeline)) continue;
    s.timeline = t;
    put("/api/timeline?scene=" + s.slug, t);
    changed.push(s.slug);
  }
  view();
  if (!findClip(S.sel)) S.sel = null;
  if (S.trSel && !selTransition()) S.trSel = null;
  commit();
  const other = changed.filter((s) => s !== S.scene);
  toast(other.length ? `${name} (${other.join(", ")})` : name);
}
export const undo = () => step(H.undo, H.redo, "Undo");
export const redo = () => step(H.redo, H.undo, "Redo");
