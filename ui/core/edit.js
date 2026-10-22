// All timeline mutations. Every change ends in commit(): re-sort, re-render, repaint, save.
import { S, stage, MIN, EPS, clamp, uid, kind, clips, findClip, trackOf, locked, withLinked, isSel, selected, setSel, metaDur, el, redraw, snap } from "./state.js";
import { H, record } from "./history.js";
import { loadAudio, startAudio } from "../timeline/audio.js";

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch("/api/timeline", { method: "PUT", body: JSON.stringify(S.tl) }), 200);
}

export function commit() {
  for (const tr of S.tl.tracks) tr.clips.sort((a, b) => a.start - b.start);
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

// Clips may not overlap on a track. `group` = [{ c, o }] (o = the clip before the move). Returns `want`
// if the group fits there, else the nearest shift that fits (next to a blocking clip), else null.
export function freeDt(group, want) {
  const moving = new Set(group.map((g) => g.c));
  const fits = (dt) => group.every(({ c, o }) => {
    const s = o.start + dt, e = s + o.duration;
    return s >= -EPS && trackOf(c).clips.every((x) => moving.has(x) || x.start >= e - EPS || x.start + x.duration <= s + EPS);
  });
  if (fits(want)) return want;
  const tries = [];
  for (const { c, o } of group) {
    for (const x of trackOf(c).clips) if (!moving.has(x)) tries.push(x.start - o.duration - o.start, x.start + x.duration - o.start);
  }
  return tries.filter(fits).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] ?? null;
}

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

// New clips that may overlap others: overwrite mode cuts the others; else shift the new clips
// as a group to the nearest free place, else after everything.
function place(made) {
  if (S.overwrite) return carve(made);
  const group = made.map((c) => ({ c, o: { ...c } }));
  let dt = freeDt(group, 0);
  if (dt === null) {
    const others = clips().filter((x) => !made.includes(x));
    dt = Math.max(0, ...others.map((x) => x.start + x.duration)) - Math.min(...made.map((c) => c.start));
  }
  for (const c of made) c.start = snap(c.start + dt);
}

/* ---------- tracks ---------- */

// first free id like V3 or A2
function nextId(prefix) {
  let n = 1;
  while (S.tl.tracks.some((t) => t.id === prefix + n)) n++;
  return prefix + n;
}

// an unlocked track of this type (the first, or one free over start..end), else a new one
function trackFor(type, start, end) {
  const ok = (t) => t.type === type && !t.lock;
  const free = (t) => end === undefined || t.clips.every((x) => x.start >= end - EPS || x.start + x.duration <= start + EPS);
  let tr = S.tl.tracks.find((t) => ok(t) && free(t));
  if (!tr) {
    tr = { id: nextId(type === "audio" ? "A" : "V"), type, clips: [] };
    type === "audio" ? S.tl.tracks.push(tr) : S.tl.tracks.unshift(tr); // new video goes on top, new audio at the bottom
  }
  return tr;
}

// a new empty track next to `tr`: above it for video (a layer in front), below it for audio
function trackNextTo(tr) {
  const nt = { id: nextId(tr.type === "audio" ? "A" : "V"), type: tr.type, clips: [] };
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
  const tr = { id: nextId(type === "audio" ? "A" : "V"), type, clips: [] };
  type === "audio" ? S.tl.tracks.push(tr) : S.tl.tracks.unshift(tr);
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
    const url = src[0] === "@" ? `/ui/builtin/${src.slice(1)}.html` : "/p/" + src; // "@text" = a built-in scene
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

// A video with sound also gets its sound as a linked clip on an audio track (free at that time).
// shortcut: the sound is found by decoding the whole file; for very large videos ask the server (ffprobe)
// `at` = { t, track } for a drop on the timeline: start at t on that track. Where it is used, Overwrite
// cuts the clips there, else the clip goes to a new track next to it. A drop below the tracks (no track)
// makes a new track. Without `at`: the end of the first track of its type.
export async function addClip(src, at) {
  const k = kind(src), type = k === "audio" ? "audio" : "video";
  const duration = await probe(src);
  if (k === "video") await loadAudio(src); // fails quietly when the file has no sound
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
      tr = { id: nextId(type === "audio" ? "A" : "V"), type, clips: [] };
      const lastVideo = S.tl.tracks.findLastIndex((t) => t.type !== "audio");
      S.tl.tracks.splice(type === "audio" ? S.tl.tracks.length : lastVideo + 1, 0, tr);
    }
    tr ??= trackFor(type, start, start + duration); // a track of the other type, or locked: a free one of this type
  }
  const c = { id: uid(), src, start, duration };
  tr.clips.push(c);
  if (at) S.overwrite ? carve([c]) : bump([c]);
  if (sound) {
    const a = { id: uid(), src, start, duration, link: uid() };
    c.link = a.link;
    trackFor("audio", start, start + duration).clips.push(a);
    setSel([a.id, c.id]);
  } else S.sel = c.id;
  commit();
}

// A built-in scene (ui/builtin/<name>.html, src "@name") at the playhead, like a drop there: overlays
// (text, shape, lower third) on the top video track, a solid on the bottom one (a background).
export function addBuiltin(name) {
  const videos = S.tl.tracks.filter((t) => t.type === "video");
  return addClip("@" + name, { t: snap(S.t), track: (name === "solid" ? videos.at(-1) : videos[0])?.id });
}

export function removeEmptyTracks() {
  if (S.tl.tracks.every((t) => t.clips.length)) return;
  record();
  S.tl.tracks = S.tl.tracks.filter((t) => t.clips.length);
  commit();
}

function step(from, to) {
  if (!from.length || S.drag) return;
  to.push(JSON.stringify(S.tl));
  S.tl = JSON.parse(from.pop());
  if (!findClip(S.sel)) S.sel = null;
  commit();
}
export const undo = () => step(H.undo, H.redo);
export const redo = () => step(H.redo, H.undo);
