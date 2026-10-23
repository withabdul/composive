// Timeline: drawing (ruler, range, rows, clips, waveform, filmstrip, fades) and pointer interaction for the four tools.
import { $, S, bus, redraw, el, toast, clamp, kind, clipKind, DRAG_SRC, DRAG_TR, selectTransition, clips, findClip, trackOf, locked, withLinked, isSel, selIds, selected, setSel, snap, totalDur, stage, LABEL, ROW, MIN, EPS } from "../core/state.js";
import { pushUndo } from "../core/history.js";
import { commit, splitClip, removeClips, moveTrack, clampFades, carve, bump, addClip, reorderTrack, addTrack, deleteTrack, toggleTrack, toggleGlobal, renameTrack, setMarker, removeMarker, MARKER_COLOR, removeKeysAt, sceneTransition, setClipTransition, selTransition } from "../core/edit.js";
import { isGlobal, layout, end } from "../core/project.js";
import { clipTransitions, envelope } from "../canvas/stage.js";
import { seek, ui } from "../canvas/viewer.js";
import { strip, FRAME_H } from "./filmstrip.js";

const sc = $("#tlscroll"), inner = $("#tlinner"), snapLine = $("#snapline"), marquee = $("#marquee");
const shade = [el("div", "outside"), el("div", "outside")]; // dims the time before and after the scene shown
inner.append(...shade);
// earliest start of a clip: a scene clip stays inside its scene
const floor = (c) => (S.scene && !isGlobal(trackOf(c)) ? S.win.a : 0);

bus.addEventListener("redraw", () => drawTimeline());
let scrollFrame = 0; // only the visible part is drawn, so scrolling draws again (once per frame)
sc.addEventListener("scroll", () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(() => S.tl && drawTimeline()); });
new ResizeObserver(() => S.tl && drawTimeline()).observe(sc);

// Canvases by clip id, reused while their key (what they show) is the same. Rebuilt each draw,
// so clips that are gone or off screen drop out.
let cvCache = new Map(), cvNext = new Map();
function cached(c, key, make) {
  const h = cvCache.get(c.id + key);
  const cv = h ?? make();
  cvNext.set(c.id + key, cv);
  return cv;
}

function drawTimeline() {
  const dur = Math.max(totalDur() + 5, 20);
  inner.style.width = LABEL + dur * S.pps + "px";
  // seconds on screen, plus half a screen each side so a short scroll shows no empty edge
  const w = sc.clientWidth / S.pps, a = (sc.scrollLeft) / S.pps - w / 2, b = a + w * 2;
  const view = { a: Math.max(0, a), b };

  const ruler = $("#ruler");
  ruler.innerHTML = "";
  const corner = el("div", "corner"); // header column above the track headers: add-track buttons
  for (const [type, text] of [["video", "+ Video"], ["audio", "+ Audio"]]) {
    const b = el("button", "", text);
    b.dataset.act = "add-" + type;
    b.title = `Add a ${type} track`;
    b.tabIndex = -1;
    corner.append(b);
  }
  ruler.append(corner);
  const step = S.pps >= 160 ? 0.5 : S.pps >= 60 ? 1 : S.pps >= 25 ? 5 : 10;
  for (let s = Math.floor(view.a / step) * step; s <= Math.min(dur, view.b); s += step) {
    const t = el("div", "tick", s + "s");
    t.style.left = LABEL + s * S.pps + "px";
    ruler.append(t);
  }
  for (const m of S.tl.markers ?? []) {
    if (m.t < view.a || m.t > view.b) continue;
    const mk = el("i", "mk");
    mk.dataset.id = m.id;
    mk.style.left = LABEL + m.t * S.pps + "px";
    mk.style.setProperty("--c", m.color || MARKER_COLOR);
    mk.title = (m.name ? m.name + "\n" : "") + "Click: go here. Drag: move. Double-click: name and color. Alt+click or right-click: delete.";
    if (m.name) mk.append(el("span", "", m.name));
    ruler.append(mk);
  }
  const r = S.tl.range;
  if (r) {
    const a = r.in ?? 0, b = r.out ?? totalDur();
    const band = el("div", "range");
    band.title = "Export range (I / O to set, Alt+X to clear)";
    band.style.left = LABEL + a * S.pps + "px";
    band.style.width = Math.max(0, b - a) * S.pps + "px";
    ruler.append(band);
  }

  shade[0].hidden = shade[1].hidden = !S.scene;
  shade[0].style.left = LABEL + "px";
  shade[0].style.width = S.win.a * S.pps + "px";
  shade[1].style.left = LABEL + S.win.b * S.pps + "px";
  shade[1].style.width = Math.max(0, dur - S.win.b) * S.pps + "px";

  drawSceneBar();

  const rows = $("#rows");
  rows.innerHTML = "";
  const solo = S.tl.tracks.some((t) => t.type === "audio" && t.solo);
  const firstGlobal = S.tl.tracks.find(isGlobal);
  for (const tr of S.tl.tracks) {
    // "off" = not seen or heard: a hidden video track, a muted audio track, or one left out by solo
    const off = tr.type === "audio" ? (solo ? !tr.solo : tr.mute) : tr.hide;
    const dragging = S.drag?.type === "track" && S.drag.id === tr.id; // kept while reorder redraws the rows
    const row = el("div", `row ${tr.type}` + (off ? " off" : "") + (tr.lock ? " locked" : "") + (dragging ? " dragging" : "")
      + (tr === firstGlobal && tr !== S.tl.tracks[0] ? " gstart" : ""));
    row.dataset.track = tr.id;
    row.style.height = ROW[tr.type] + "px";
    row.append(header(tr));
    for (const c of tr.clips) if (c.start < view.b && c.start + c.duration > view.a) row.append(clipEl(c, view, tr));
    if (tr.type !== "audio") for (const x of clipTransitions(tr)) {
      if (x.a >= view.b || x.b <= view.a) continue;
      const [c, side] = x.to ? [x.to, "in"] : [x.from, "out"];
      const b = trBlock(x.x, x.a, x.b, S.trSel?.kind === "clip" && S.trSel.id === c.id && S.trSel.side === side, tr.lock);
      Object.assign(b.dataset, { id: c.id, side, mode: x.from && x.to ? "cut" : side });
      row.append(b);
    }
    rows.append(row);
  }
  const filler = el("div", "row filler"); // fills the space below the last track, header column included
  filler.append(el("div", "label"));
  rows.append(filler);
  [cvCache, cvNext] = [cvNext, new Map()];
  ui();
}

// Where the scenes are now: the scene shown uses its live length (its timeline.json is saved a bit later).
const sceneLayout = () => layout(S.project, (s) => (s.slug === S.scene ? S.win.b - S.win.a : end(s.timeline)));

// A transition block from a to b (video time); dataset a, b for the duration drag.
function trBlock(x, a, b, sel, ro) {
  const d = el("div", "trb" + (sel ? " sel" : "") + (ro ? " ro" : ""), x.type);
  d.style.left = LABEL + a * S.pps + "px";
  d.style.width = Math.max(4, (b - a) * S.pps) + "px";
  Object.assign(d.dataset, { a, b });
  d.title = `${x.type} ${(b - a).toFixed(2)} s\nClick: select (right panel). Drag: duration. Delete or right-click: remove.`;
  return d;
}

// Scene bar: a block per scene (double-click opens it), the scene transitions: on the seams (between two
// scenes), at the start (in, alone) or at the end (out) of a scene.
function drawSceneBar() {
  const bar = $("#scenebar");
  bar.hidden = !S.project.scenes.length;
  bar.replaceChildren(el("div", "corner", "Scenes"));
  const L = sceneLayout();
  L.forEach((w, i) => {
    const s = el("div", "sblk" + (w.slug === S.scene ? " on" : ""), w.slug);
    s.dataset.scene = w.slug;
    s.style.left = LABEL + w.a * S.pps + "px";
    s.style.width = Math.max(0, w.b - w.a) * S.pps + "px";
    s.title = `${w.slug}\nDouble-click: open this scene`;
    bar.append(s);
    const sel = (side) => S.trSel?.kind === "scene" && S.trSel.slug === w.slug && S.trSel.side === side;
    const add = (x, a, b, side, mode) => {
      const blk = trBlock(x, a, b, sel(side));
      Object.assign(blk.dataset, { scene: w.slug, side, mode });
      bar.append(blk);
    };
    if (w.x) add(w.x, w.a, L[i - 1].b, "in", "seam");
    if (w.in) add(w.in, w.a, w.a + w.in.duration, "in", "in");
    if (w.out) add(w.out, w.b - w.out.duration, w.b, "out", "out");
  });
}

const ICON = {
  hide: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};

// Track header: name (double-click to rename), flag buttons, delete; drag it up or down to reorder.
function header(tr) {
  const h = el("div", "label");
  if (tr.ro) { // all scenes: a scene's track, shown only (edit it in its scene)
    h.title = "Scene track. Pick the scene in the top bar to edit it.";
    h.append(el("span", "tname", tr.name ? `${tr.id.split("/")[0]}/${tr.name}` : tr.id));
    return h;
  }
  h.dataset.track = tr.id;
  h.title = "Drag to reorder. Double-click the name to rename.";
  const btns = el("div", "tbtns");
  const keys = tr.type === "audio"
    ? [["mute", "M", "Mute"], ["solo", "S", "Solo: hear only solo tracks"], ["lock", ICON.lock, "Lock: no edits"]]
    : [["hide", ICON.hide, "Hide: not in preview or export"], ["lock", ICON.lock, "Lock: no edits"]];
  if (S.scene) keys.push(["global", "G", "Global: on for the whole video (e.g. music). Off: only in this scene"]);
  for (const [key, html, tip] of [...keys, ["del", "×", "Delete track and its clips"]]) {
    const b = el("button", ((key === "global" ? isGlobal(tr) : tr[key]) ? "on " : "") + key);
    b.innerHTML = html;
    b.title = tip;
    b.dataset.act = key;
    b.tabIndex = -1;
    btns.append(b);
  }
  h.append(el("span", "tname", tr.name || tr.id), btns);
  return h;
}

function clipEl(c, view, tr) {
  const k = tr.type === "audio" ? "audio" : kind(c.src); // the sound of a video file is drawn as audio
  const d = el("div", `clip ${k}` + (isSel(c.id) ? " sel" : "") + (c.link ? " linked" : ""));
  d.dataset.id = c.id;
  d.style.left = LABEL + c.start * S.pps + "px";
  d.style.width = c.duration * S.pps + "px";
  // canvases cover only the part of the clip in view: a long clip would pass the browser's canvas size limit
  const from = Math.max(c.start, view.a), to = Math.min(c.start + c.duration, view.b);
  if (to > from) {
    const key = `|${S.pps}|${from}|${to}|${c.offset || 0}|${c.duration}`;
    if (k === "audio") {
      // its gain line (keys, volume, ducking by the voice tracks); a plain clip has none, and costs nothing
      const plain = !c.keys?.volume?.length && (c.volume ?? 1) === 1 && !(tr.duck >= 0);
      const P = plain ? [] : envelope(S.tl, c);
      d.append(cached(c, `${key}|${c.fadeIn}|${c.fadeOut}|${!!S.peaks.get(c.src)}|${JSON.stringify(P)}`, () => waveCanvas(c, from, to, P)));
    }
    if (k === "video") d.append(cached(c, `${key}|${!!strip(c.src)}`, () => filmCanvas(c, from, to)));
  }
  const parts = c.src.split("/");
  const label = c.src[0] === "@" ? c.props?.text || c.src.slice(1) : k === "scene" ? parts.at(-2) : parts.at(-1);
  d.append(el("span", "name", label));
  d.append(el("i", "edge l"), el("i", "edge r"));
  // keyframes: one ◆ per key time (all props), at the bottom of the clip
  for (const kt of new Set(Object.values(c.keys ?? {}).flat().map((k) => k.t))) {
    const x = (kt - (c.offset || 0)) * S.pps;
    if (x < -1 || x > c.duration * S.pps + 1) continue; // trimmed away
    const kf = el("i", "kf");
    kf.dataset.kt = kt;
    kf.style.left = x + "px";
    kf.title = "Keyframe. Click: go here. Drag: move. Alt+click or right-click: delete.";
    d.append(kf);
  }
  if (k === "audio") {
    const fi = el("i", "fh in"), fo = el("i", "fh out");
    fi.style.left = (c.fadeIn || 0) * S.pps + "px";
    fo.style.right = (c.fadeOut || 0) * S.pps + "px";
    d.append(fi, fo);
  }
  return d;
}

// Canvas for the part from..to (timeline seconds) of clip c. `dx` = its left edge inside the clip, px;
// drawing code uses clip x coordinates, the context is shifted by -dx.
function clipCanvas(c, h, from, to) {
  const w = Math.max(1, Math.round((to - from) * S.pps)), dx = Math.round((from - c.start) * S.pps), r = devicePixelRatio || 1;
  const cv = el("canvas");
  cv.width = w * r; cv.height = h * r;
  cv.style.width = w + "px"; cv.style.height = h + "px"; cv.style.left = dx + "px";
  const g = cv.getContext("2d");
  g.scale(r, r);
  g.translate(-dx, 0);
  return { cv, g, x0: dx, x1: dx + w, cw: Math.round(c.duration * S.pps) };
}

function waveCanvas(c, from, to, P) {
  const h = ROW.audio - 8, { cv, g, x0, x1, cw } = clipCanvas(c, h, from, to);
  const p = S.peaks.get(c.src), off = c.offset || 0;
  g.fillStyle = "rgba(255,255,255,.7)";
  if (p) for (let x = x0; x < x1; x++) {
    const bh = Math.max(1, (p[Math.floor((off + x / S.pps) * 100)] ?? 0) * h);
    g.fillRect(x, (h - bh) / 2, 1, bh);
  }
  g.fillStyle = "rgba(0,0,0,.5)"; // dimmed area above the fade envelope
  const fi = (c.fadeIn || 0) * S.pps, fo = (c.fadeOut || 0) * S.pps;
  if (fi > 0) { g.beginPath(); g.moveTo(0, 0); g.lineTo(fi, 0); g.lineTo(0, h); g.fill(); }
  if (fo > 0) { g.beginPath(); g.moveTo(cw, 0); g.lineTo(cw - fo, 0); g.lineTo(cw, h); g.fill(); }
  // gain line (volume, keys, ducking; top = 1 or more)
  if (P.length) {
    g.strokeStyle = "#ffd84d";
    g.lineWidth = 1.5;
    g.beginPath();
    P.forEach((p, i) => g[i ? "lineTo" : "moveTo"]((p.t - c.start) * S.pps, 1 + (h - 2) * (1 - Math.min(1, p.v))));
    g.stroke();
  }
  return cv;
}

function filmCanvas(c, from, to) {
  const { cv, g, x0, x1 } = clipCanvas(c, FRAME_H, from, to);
  cv.className = "film";
  const s = strip(c.src);
  if (s) for (let x = Math.floor(x0 / s.w) * s.w; x < x1; x += s.w) { // tiles stay on the clip's grid
    const i = clamp(Math.floor(((c.offset || 0) + x / S.pps) / s.step), 0, s.frames.length - 1);
    g.drawImage(s.frames[i], x, 0);
  }
  return cv;
}

/* ---------- pointer interaction ---------- */

const timeAt = (x) => (x - inner.getBoundingClientRect().left - LABEL) / S.pps;

// Magnetic snap: move `edges` (times) by dt; if one lands within 8 px of a target, pull it there.
// Else snap to whole frames (`base` = the time that should land on a frame). Alt = frames only.
function magnet(d, edges, dt, base, e) {
  let best = null;
  if (!e.altKey) {
    for (const x of edges) for (const t of d.targets) {
      const off = t - (x + dt);
      if (Math.abs(off) * S.pps < 8 && (!best || Math.abs(off) < Math.abs(best.off))) best = { off, t };
    }
  }
  snapLine.hidden = !best;
  if (best) { snapLine.style.left = LABEL + best.t * S.pps + "px"; return dt + best.off; }
  return snap(base + dt) - base;
}

// playhead, 0, markers and the edges of every clip not being dragged
function targets(skip) {
  const out = [0, S.t];
  for (const m of S.tl.markers ?? []) if (!skip.has(m)) out.push(m.t);
  for (const c of clips()) if (!skip.has(c)) out.push(c.start, c.start + c.duration);
  return out;
}

// end of the clip before / start of the clip after `c` on its track
function neighbors(c) {
  let prev = 0, next = Infinity;
  for (const x of trackOf(c).clips) {
    if (x === c) continue;
    if (x.start + x.duration <= c.start + EPS) prev = Math.max(prev, x.start + x.duration);
    else if (x.start >= c.start + c.duration - EPS) next = Math.min(next, x.start);
  }
  return { prev, next };
}

sc.addEventListener("pointerdown", (e) => {
  const head = e.target.closest(".label, .corner"); // track headers are not a place to seek or box-select
  if (e.button || head) {
    // no pointer capture here: it would send the double-click (rename) to the timeline instead of the name
    if (!e.button && head.dataset.track && !e.target.closest("button, input")) {
      S.drag = { type: "track", id: head.dataset.track, snap: JSON.stringify(S.tl) };
      head.parentElement.classList.add("dragging"); // a class, not a redraw: a redraw here would break the double-click
    }
    return;
  }
  S.focus = "timeline";
  sc.setPointerCapture(e.pointerId);
  if (S.tool === "pan") {
    S.drag = { type: "pan", x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop };
    return;
  }
  const tb = e.target.closest(".trb");
  if (tb) return trDown(tb, e);
  const mk = e.target.closest(".mk");
  if (mk) {
    const m = S.tl.markers.find((x) => x.id === mk.dataset.id);
    if (e.altKey) return removeMarker(m.id);
    S.drag = { type: "marker", id: m.id, x: e.clientX, t0: m.t, moved: false, snap: JSON.stringify(S.tl), targets: targets(new Set([m])) };
    return;
  }
  const node = e.target.closest(".clip");
  if (!node) {
    if (e.target.closest("#ruler, #scenebar")) {
      seek(timeAt(e.clientX));
      S.drag = { type: "scrub" };
      return;
    }
    // empty track area: drag = box select; a plain click seeks and deselects
    const r = inner.getBoundingClientRect();
    S.drag = { type: "box", x: e.clientX - r.left, y: e.clientY - r.top, base: e.shiftKey ? selIds() : [], moved: false };
    return;
  }
  const c = findClip(node.dataset.id);
  if (locked(c)) return;
  const kf = e.target.closest(".kf");
  if (kf) { // a keyframe ◆: select its clip; drag moves the keys at that time, Alt+click deletes them
    const kt = Number(kf.dataset.kt);
    if (!isSel(c.id)) setSel([c.id]);
    if (e.altKey) return removeKeysAt(c, kt);
    S.drag = { type: "kf", id: c.id, kt, x: e.clientX, moved: false, snap: JSON.stringify(S.tl) };
    redraw();
    return;
  }
  const one = e.altKey; // Alt: this clip only, without the clip linked to it
  const grp = (one ? [c] : withLinked([c])).map((x) => x.id); // c and its linked clips
  const others = grp.filter((i) => i !== c.id);
  if (S.tool === "cut") return removeClips([c], S.magnet !== e.shiftKey, !one);
  if (S.tool === "split") {
    const t = timeAt(e.clientX);
    return splitClip(c, Math.abs(t - S.t) * S.pps < 6 ? S.t : snap(t), !one); // click near the playhead snaps to it
  }
  if (e.shiftKey) { // add to or take out of the selection
    const ids = selIds();
    setSel(ids.includes(c.id) ? ids.filter((i) => !grp.includes(i)) : [...ids.filter((i) => !grp.includes(i)), ...others, c.id]);
    redraw();
    return;
  }
  // keep the selected group (so it can be dragged together), make c the main clip
  setSel(isSel(c.id) ? [...selIds().filter((i) => i !== c.id), c.id] : [...others, c.id]);
  const cl = e.target.classList;
  const type = cl.contains("fh") ? (cl.contains("in") ? "fin" : "fout")
    : cl.contains("edge") ? (cl.contains("l") ? "trimL" : "trimR") : "move";
  const group = type !== "move" ? [c] : one ? [c] : selected();
  S.drag = {
    type, id: c.id, x: e.clientX, o: { ...c }, ids: group.map((g) => g.id), snap: JSON.stringify(S.tl), one,
    partners: type === "trimL" || type === "trimR" ? others : [], // trims change the linked clips the same way
    targets: targets(new Set([...group, ...others.map(findClip)])),
  };
  redraw(); // not drawTimeline(): the panel also listens to this event
});

sc.addEventListener("pointermove", (e) => {
  const d = S.drag;
  if (!d) return;
  if (d.type === "pan") {
    sc.scrollLeft = d.sl - (e.clientX - d.x);
    sc.scrollTop = d.st - (e.clientY - d.y);
    return;
  }
  if (d.type === "scrub") return seek(timeAt(e.clientX));
  if (d.type === "trdur") return trMove(d, e);
  if (d.type === "box") return boxSelect(d, e);
  if (d.type === "kf") { // keys at d.kt move together, on whole frames, inside the clip
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    S.tl = JSON.parse(d.snap);
    const c = findClip(d.id), lo = c.offset || 0;
    const t = clamp(snap(c.start + d.kt - lo + (e.clientX - d.x) / S.pps) - c.start + lo, lo, lo + c.duration);
    for (const [key, ks] of Object.entries(c.keys)) {
      const k = ks.find((x) => Math.abs(x.t - d.kt) < EPS);
      if (!k) continue;
      c.keys[key] = ks.filter((x) => x === k || Math.abs(x.t - t) >= EPS); // a key already there gives way
      k.t = t;
      c.keys[key].sort((a, b) => a.t - b.t);
    }
    commit();
    return;
  }
  if (d.type === "marker") { // snaps like a clip edge; a move under 3 px is still a click
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    S.tl.markers.find((x) => x.id === d.id).t = Math.max(0, d.t0 + magnet(d, [d.t0], (e.clientX - d.x) / S.pps, d.t0, e));
    commit();
    return;
  }
  if (d.type === "track") { // reorder: take the place of the track under the pointer once past its middle
    if (!e.buttons) { S.drag = null; endTrackDrag(); return; } // released outside the timeline (no capture), so no pointerup came
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest(".row[data-track]");
    if (!row || row.dataset.track === d.id) return;
    const ts = S.tl.tracks, i = ts.findIndex((t) => t.id === d.id), j = ts.findIndex((t) => t.id === row.dataset.track);
    const q = row.getBoundingClientRect(), mid = q.top + q.height / 2;
    if ((j > i && e.clientY > mid) || (j < i && e.clientY < mid)) { reorderTrack(d.id, row.dataset.track); commit(); }
    return;
  }
  // Every move starts again from the timeline as it was at drag start, so clips that were
  // cut (overwrite) or pushed (ripple) on the way come back when the pointer moves on.
  S.tl = JSON.parse(d.snap);
  const c = findClip(d.id), o = d.o, dt = (e.clientX - d.x) / S.pps;
  const ripple = S.magnet !== e.shiftKey, over = S.overwrite;
  const all = [c, ...d.partners.map(findClip).filter(Boolean)]; // trims: c and its linked clips
  // ripple: on x's track, the clips that started at or after `end` move by `by`
  const shiftLater = (x, end, by) => { for (const y of trackOf(x).clips) if (!all.includes(y) && y.start >= end - EPS) y.start += by; };
  if (d.type === "move") {
    const group = d.ids.map(findClip).map((g) => ({ c: g, o: { ...g } }));
    const from = new Map(group.map((g) => [g.c, trackOf(g.c)])); // each clip's track before this move
    let id = document.elementFromPoint(e.clientX, e.clientY)?.closest(".row")?.dataset.track;
    // the row under the pointer may be a track that bump() made in the last move (gone after the
    // restore above): keep aiming at the last real track, or the clip would jump back and forth
    if (id && !S.tl.tracks.some((t) => t.id === id)) id = d.to;
    else if (id) d.to = id;
    // vertical move: the group clips of the hovered track's type move by the same number of tracks as
    // the lead clip (the held clip, or the group clip of that type: a video's sound over audio tracks).
    // The other type stays. Stops at the first/last track; no move when a target track is locked.
    const type = S.tl.tracks.find((t) => t.id === id)?.type, same = group.filter((g) => trackOf(g.c).type === type);
    const lead = same.find((g) => g.c === c) ?? same[0];
    if (lead) {
      const ts = S.tl.tracks.filter((t) => t.type === type), at = (g) => ts.indexOf(trackOf(g.c));
      const idx = same.map(at);
      const k = clamp(ts.findIndex((t) => t.id === id) - at(lead), -Math.min(...idx), ts.length - 1 - Math.max(...idx));
      if (k && !idx.some((i) => ts[i + k].lock)) same.forEach((g, n) => moveTrack(g.c, ts[idx[n] + k].id));
    }
    const want = magnet(d, group.flatMap((g) => [g.o.start, g.o.start + g.o.duration]), dt, o.start, e);
    const lo = Math.max(...group.map((g) => floor(g.c) - g.o.start)); // nothing goes before 0, a scene clip not before its scene
    // magnet: a clip that left its track leaves no gap there, the clips after it close up
    // (not within the same track: those clips would close up into the moved clip itself)
    if (ripple) {
      const moving = new Set(group.map((g) => g.c));
      for (const g of [...group].sort((a, b) => b.o.start - a.o.start)) {
        if (from.get(g.c) === trackOf(g.c)) continue;
        for (const x of from.get(g.c).clips) {
          if (!moving.has(x) && x.start >= g.o.start + g.o.duration - EPS) x.start -= g.o.duration;
        }
      }
    }
    for (const g of group) g.c.start = g.o.start + Math.max(lo, want);
    // on a used spot: Overwrite cuts the clips there, else the moved clips go to a new track next to it
    (over ? carve : bump)(group.map((g) => g.c));
  } else if (d.type === "trimL") {
    // delta = how far the left edge moves; every clip in `all` must allow it
    const hi = Math.min(...all.map((x) => x.duration - MIN));
    if (ripple) { // the clips keep their start; the clips after them follow the change
      const lo = Math.max(...all.map((x) => -(x.offset || 0)));
      const delta = clamp(snap(o.start + dt) - o.start, lo, hi);
      for (const x of all) {
        const end = x.start + x.duration;
        x.offset = (x.offset || 0) + delta; x.duration -= delta;
        shiftLater(x, end, -delta);
      }
    } else {
      // not before the source start, nor (unless overwrite) into the clip before
      const lo = Math.max(...all.map((x) => Math.max(-(x.offset || 0), over ? floor(x) - x.start : Math.max(floor(x), neighbors(x).prev) - x.start)));
      const delta = clamp(magnet(d, [o.start], dt, o.start, e), lo, hi);
      for (const x of all) { x.start += delta; x.offset = (x.offset || 0) + delta; x.duration -= delta; }
      if (over) carve(all);
    }
  } else if (d.type === "trimR") {
    // how much longer each clip may get: not past its source end, nor (unless ripple or overwrite) into the next clip
    const room = (x) => {
      const k = clipKind(x);
      const src = k === "audio" ? S.bufs.get(x.src)?.duration ?? Infinity : k === "video" ? stage.srcDuration(x.id) : Infinity;
      const r = src - (x.offset || 0) - x.duration;
      return ripple || over ? r : Math.min(r, neighbors(x).next - x.start - x.duration);
    };
    const end = o.start + o.duration;
    const delta = clamp(magnet(d, [end], dt, end, e), Math.max(...all.map((x) => MIN - x.duration)), Math.min(...all.map(room)));
    for (const x of all) {
      const xEnd = x.start + x.duration;
      x.duration += delta;
      if (ripple) shiftLater(x, xEnd, delta);
    }
    if (!ripple && over) carve(all);
  } else if (d.type === "fin") {
    c.fadeIn = clamp((o.fadeIn || 0) + dt, 0, c.duration - (c.fadeOut || 0));
  } else if (d.type === "fout") {
    c.fadeOut = clamp((o.fadeOut || 0) - dt, 0, c.duration - (c.fadeIn || 0));
  }
  if (d.type !== "fin" && d.type !== "fout") all.forEach(clampFades);
  commit();
});

/* ---------- transitions: select, duration drag, drop from the sidebar ---------- */

// A click selects the transition; a drag changes its duration. The pointer's side of a cut sets the way:
// right of the middle, a move right makes it longer (both sides grow); an in grows right, an out and a
// transition on a scene seam grow left.
const trOf = (tb) => tb.dataset.scene ? { kind: "scene", slug: tb.dataset.scene, side: tb.dataset.side } : { kind: "clip", id: tb.dataset.id, side: tb.dataset.side };
function trDown(tb, e) {
  const t = trOf(tb);
  selectTransition(t);
  const st = selTransition();
  if (st && !tb.classList.contains("ro")) {
    const a = +tb.dataset.a, b = +tb.dataset.b, mode = tb.dataset.mode;
    const k = mode === "cut" ? (timeAt(e.clientX) > (a + b) / 2 ? 2 : -2) : mode === "in" ? 1 : -1;
    S.drag = { type: "trdur", t, k, mode, d0: b - a, a, b, x0: st.x, x: e.clientX, moved: false, snap: JSON.stringify(S.tl) };
  }
  redraw();
}

function trMove(d, e) {
  if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
  d.moved = true;
  d.dur = Math.max(MIN, snap(d.d0 + d.k * (e.clientX - d.x) / S.pps));
  if (d.t.kind === "scene") { // only drawn now; set on release (it moves scene starts)
    const b = $(`#scenebar .trb[data-scene="${d.t.slug}"][data-side="${d.t.side}"]`);
    if (b) {
      b.style.left = LABEL + (d.mode === "in" ? d.a : d.b - d.dur) * S.pps + "px";
      b.style.width = d.dur * S.pps + "px";
      b.textContent = d.dur.toFixed(2) + " s";
    }
    return;
  }
  S.tl = JSON.parse(d.snap);
  const c = findClip(d.t.id);
  if (c) c[d.t.side] = { ...d.x0, duration: d.dur };
  commit();
}

// What a transition dropped at the pointer goes on, for a scene (scene bar) or a clip: on a seam or a cut
// (8 px around it): the transition between the two (pair: the next one's "in"); on the left half: "in" (only
// this one when there is one before it); on the right half: "out" (only this one). t = where the line shows.
function trTarget(e) {
  const t = timeAt(e.clientX), near = (s) => Math.abs(s - t) * S.pps < 8;
  if (document.elementFromPoint(e.clientX, e.clientY)?.closest("#scenebar")) {
    const L = sceneLayout(), i = L.findIndex((w, i) => i && near(L[i - 1].b));
    if (i > 0) return { kind: "scene", slug: L[i].slug, side: "in", t: L[i - 1].b, pair: true };
    const w = L.findLast((w) => t >= w.a && t < w.b); // the later scene is on top in an overlap
    if (!w) return null;
    return t - w.a < w.b - t ? { kind: "scene", slug: w.slug, side: "in", t: w.a, only: L.indexOf(w) > 0 }
      : { kind: "scene", slug: w.slug, side: "out", t: w.b };
  }
  // the clip may be under a transition block
  const c = findClip(document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList.contains("clip"))?.dataset.id);
  if (!c || locked(c) || trackOf(c).type === "audio") return null;
  const e1 = c.start + c.duration, cs = trackOf(c).clips;
  const prev = cs.find((x) => Math.abs(x.start + x.duration - c.start) < EPS), next = cs.find((x) => Math.abs(x.start - e1) < EPS);
  if (prev && near(c.start)) return { kind: "clip", id: c.id, side: "in", t: c.start, pair: true };
  if (next && near(e1)) return { kind: "clip", id: next.id, side: "in", t: e1, pair: true };
  return t - c.start < e1 - t ? { kind: "clip", id: c.id, side: "in", t: c.start, only: !!prev }
    : { kind: "clip", id: c.id, side: "out", t: e1 };
}

function trDrop(e, type) {
  const g = trTarget(e);
  if (!g) return;
  const old = g.kind === "scene" ? S.project.scenes.find((s) => s.slug === g.slug)?.timeline[g.side === "out" ? "out" : "transition"]
    : findClip(g.id)[g.side];
  const x = { duration: 0.6, ease: "inout", ...old, type };
  if (old?.type !== type) { delete x.dir; delete x.color; } // another type has other options
  if (g.only) x.only = true; else delete x.only;
  const t = { kind: g.kind, id: g.id, slug: g.slug, side: g.side };
  selectTransition(t);
  if (g.kind === "scene") sceneTransition(g.slug, x, g.side);
  else setClipTransition(findClip(g.id), g.side, x);
  if (g.side === "out" && pairAfter(g)) toast("Not used: the next one has a transition on this cut. Remove it, or set it to only.");
}

// does the next clip or scene use the cut or seam at the end of this one (an `in` that is not `only`)?
function pairAfter(g) {
  if (g.kind === "scene") {
    const L = sceneLayout();
    return !!L[L.findIndex((w) => w.slug === g.slug) + 1]?.x;
  }
  const c = findClip(g.id), e1 = c.start + c.duration;
  return trackOf(c).clips.some((x) => Math.abs(x.start - e1) < EPS && x.in?.type && !x.in.only);
}

function boxSelect(d, e) {
  const r = inner.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (!d.moved && Math.hypot(x - d.x, y - d.y) < 4) return;
  d.moved = true;
  const l = Math.min(x, d.x), t = Math.min(y, d.y), w = Math.abs(x - d.x), h = Math.abs(y - d.y);
  Object.assign(marquee.style, { left: l + "px", top: t + "px", width: w + "px", height: h + "px" });
  marquee.hidden = false;
  const hit = [...$("#rows").querySelectorAll(".clip")].filter((n) => {
    const q = n.getBoundingClientRect(), ql = q.left - r.left, qt = q.top - r.top;
    return ql < l + w && ql + q.width > l && qt < t + h && qt + q.height > t;
  }).map((n) => findClip(n.dataset.id)).filter((c) => c && !locked(c));
  setSel([...new Set([...d.base, ...withLinked(hit).map((c) => c.id)])]);
  redraw();
}

sc.addEventListener("pointerup", (e) => {
  const d = S.drag;
  if (d?.type === "trdur" && d.moved && d.t.kind === "scene") sceneTransition(d.t.slug, { ...d.x0, duration: d.dur }, d.t.side);
  if (d?.type === "marker") {
    if (d.moved) S.tl.markers.sort((a, b) => a.t - b.t);
    else seek(d.t0); // a click on a marker goes there
  }
  if (d?.type === "kf" && !d.moved) { const c = findClip(d.id); seek(c.start + d.kt - (c.offset || 0)); } // a click on a ◆ goes there
  if (d?.type === "box" && !d.moved) {
    if (!e.shiftKey) S.sel = null;
    seek(timeAt(e.clientX));
    redraw();
  }
  // one drag = one undo step, and a click that changed nothing records nothing
  const changed = d?.snap && JSON.stringify(S.tl) !== d.snap;
  if (changed) pushUndo(d.snap);
  else if (d?.type === "move" && d.ids.length > 1) { // a plain click in a group selects only that clip (and its linked ones)
    const c = findClip(d.id);
    setSel([...(d.one ? [] : withLinked([c]).filter((x) => x !== c).map((x) => x.id)), c.id]);
    redraw();
  }
  S.drag = null;
  snapLine.hidden = marquee.hidden = true;
  if (d?.type === "track") endTrackDrag();
  ui();
});

const endTrackDrag = () => $("#rows .row.dragging")?.classList.remove("dragging");

/* ---------- markers: edit and delete ---------- */

// the marker under the pointer (a click on the ruler is captured by the timeline, so look it up by position)
const markerAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest(".mk");

sc.addEventListener("contextmenu", (e) => {
  const at = document.elementFromPoint(e.clientX, e.clientY);
  const mk = at?.closest(".mk"), kf = at?.closest(".kf"), tb = at?.closest(".trb:not(.ro)");
  if (tb) {
    S.trSel = trOf(tb);
    selTransition()?.set(null);
    S.trSel = null;
    redraw();
  } else if (mk) removeMarker(mk.dataset.id);
  else if (kf) removeKeysAt(findClip(kf.closest(".clip").dataset.id), Number(kf.dataset.kt));
  else return;
  e.preventDefault();
});

// double-click: a small box under the marker with its name, color and Delete
sc.addEventListener("dblclick", (e) => {
  const blk = document.elementFromPoint(e.clientX, e.clientY)?.closest(".sblk");
  if (blk && blk.dataset.scene !== S.scene) { // open that scene, as the top bar list does
    const pick = $("#scenePick");
    pick.value = blk.dataset.scene;
    pick.dispatchEvent(new Event("change"));
    return;
  }
  const mk = markerAt(e);
  if (!mk) return;
  const m = S.tl.markers.find((x) => x.id === mk.dataset.id), q = mk.getBoundingClientRect();
  const pop = el("div", "mkpop"), name = el("input"), color = el("input"), del = el("button", "", "Delete");
  name.placeholder = "Marker name";
  name.value = m.name ?? "";
  color.type = "color";
  color.value = m.color ?? MARKER_COLOR;
  del.tabIndex = -1;
  pop.style.left = q.left + "px";
  pop.style.top = q.bottom + 4 + "px";
  pop.append(name, color, del);
  document.body.append(pop);
  name.focus();
  const close = (save) => {
    removeEventListener("pointerdown", outside, true);
    pop.remove();
    if (save) setMarker(m.id, { name: name.value.trim(), color: color.value });
  };
  const outside = (p) => { if (!pop.contains(p.target)) close(true); };
  addEventListener("pointerdown", outside, true);
  name.onkeydown = (k) => {
    k.stopPropagation(); // typing must not trigger shortcuts
    if (k.key === "Enter") close(true);
    else if (k.key === "Escape") close(false);
  };
  del.onclick = () => { close(false); removeMarker(m.id); };
});

/* ---------- drop from the sidebar ---------- */

// A scene or media tile dragged from the sidebar lands on the track and time under the pointer.
const rowAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest(".row");
const clearDrop = () => { $("#rows .row.droptarget")?.classList.remove("droptarget"); snapLine.hidden = true; };
sc.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes(DRAG_TR)) { // a transition: the snap line shows where it goes
    const g = trTarget(e);
    snapLine.hidden = !g;
    if (!g) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    snapLine.style.left = LABEL + g.t * S.pps + "px";
    return;
  }
  if (!e.dataTransfer.types.includes(DRAG_SRC)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const row = rowAt(e);
  if (!row?.classList.contains("droptarget")) { clearDrop(); row?.classList.add("droptarget"); }
  snapLine.hidden = false;
  snapLine.style.left = LABEL + snap(Math.max(0, timeAt(e.clientX))) * S.pps + "px";
});
sc.addEventListener("dragleave", (e) => { if (!sc.contains(e.relatedTarget)) clearDrop(); });
sc.addEventListener("drop", (e) => {
  const type = e.dataTransfer.getData(DRAG_TR);
  if (type) { e.preventDefault(); clearDrop(); S.focus = "timeline"; return trDrop(e, type); }
  const src = e.dataTransfer.getData(DRAG_SRC);
  if (!src) return;
  e.preventDefault();
  clearDrop();
  S.focus = "timeline";
  addClip(src, { t: snap(Math.max(0, timeAt(e.clientX))), track: rowAt(e)?.dataset.track });
});

// Modal question with Cancel and a red action button. Resolves true on the action; Esc, Cancel or a click
// outside resolve false. Cancel has the focus, so Enter does not delete by mistake.
export function ask(title, text, action) {
  return new Promise((done) => {
    const d = el("dialog", "modal"), box = el("div"), btns = el("div", "mbtns");
    const no = el("button", "", "Cancel"), yes = el("button", "danger", action);
    btns.append(no, yes);
    box.append(el("h3", "", title), el("p", "", text), btns);
    d.append(box);
    document.body.append(d);
    const close = (v) => { d.close(); d.remove(); done(v); };
    no.onclick = () => close(false);
    yes.onclick = () => close(true);
    d.oncancel = (e) => { e.preventDefault(); close(false); }; // Esc
    d.onclick = (e) => { if (e.target === d) close(false); }; // the dialog itself is hit only outside the box
    d.onkeydown = (e) => e.stopPropagation(); // app shortcuts must not run behind the modal
    d.showModal();
    no.focus();
  });
}

/* ---------- track header buttons and rename ---------- */

$("#tl").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const a = b.dataset.act, id = b.closest(".label")?.dataset.track;
  if (a.startsWith("add-")) addTrack(a.slice(4));
  else if (a === "global") toggleGlobal(id);
  else if (a === "del") {
    const tr = S.tl.tracks.find((t) => t.id === id), n = tr?.clips.length ?? 0;
    if (!n) return deleteTrack(id);
    ask(`Delete track ${tr.name || tr.id}?`, `Its ${n} clip${n > 1 ? "s" : ""} will be deleted too. Undo brings them back.`, "Delete")
      .then((yes) => yes && deleteTrack(id));
  }
  else toggleTrack(id, a);
});

$("#rows").addEventListener("dblclick", (e) => {
  const name = e.target.closest(".tname");
  if (!name?.closest(".label").dataset.track) return; // a read-only scene track has no rename
  const id = name.closest(".label").dataset.track, tr = S.tl.tracks.find((t) => t.id === id);
  const input = el("input", "tedit");
  input.value = tr.name || tr.id;
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) renameTrack(id, input.value);
    drawTimeline(); // puts the name back (renameTrack draws only when the name changed)
  };
  input.onkeydown = (k) => {
    k.stopPropagation(); // typing a name must not trigger shortcuts
    if (k.key === "Enter") finish(true);
    else if (k.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
});

/* ---------- zoom ---------- */

function setZoom(v) {
  S.pps = clamp(v, 10, 400);
  $("#zoom").value = S.pps;
  drawTimeline();
}
// fits the scene shown (or the whole video) into the view
export function zoomFit() {
  const { a, b } = S.scene ? S.win : { a: 0, b: totalDur() };
  setZoom((sc.clientWidth - LABEL - 24) / Math.max(1, b - a));
  sc.scrollLeft = a * S.pps;
}
$("#zoom").addEventListener("input", (e) => setZoom(Number(e.target.value)));
$("#zoom").addEventListener("change", (e) => e.target.blur()); // a focused slider would swallow shortcuts
sc.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(S.pps * (e.deltaY < 0 ? 1.15 : 0.87));
}, { passive: false });
