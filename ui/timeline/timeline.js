// Timeline: drawing (ruler, range, rows, clips, waveform, filmstrip, fades) and pointer interaction for the four tools.
import { $, S, bus, redraw, el, clamp, kind, clipKind, DRAG_SRC, clips, findClip, trackOf, locked, withLinked, isSel, selIds, selected, setSel, snap, totalDur, stage, LABEL, ROW, MIN, EPS } from "../core/state.js";
import { pushUndo } from "../core/history.js";
import { commit, splitClip, removeClips, moveTrack, clampFades, carve, bump, addClip, reorderTrack, addTrack, deleteTrack, toggleTrack, renameTrack, setMarker, removeMarker, MARKER_COLOR } from "../core/edit.js";
import { seek, ui } from "../canvas/viewer.js";
import { strip, FRAME_H } from "./filmstrip.js";

const sc = $("#tlscroll"), inner = $("#tlinner"), snapLine = $("#snapline"), marquee = $("#marquee");

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

  const rows = $("#rows");
  rows.innerHTML = "";
  const solo = S.tl.tracks.some((t) => t.type === "audio" && t.solo);
  for (const tr of S.tl.tracks) {
    // "off" = not seen or heard: a hidden video track, a muted audio track, or one left out by solo
    const off = tr.type === "audio" ? (solo ? !tr.solo : tr.mute) : tr.hide;
    const dragging = S.drag?.type === "track" && S.drag.id === tr.id; // kept while reorder redraws the rows
    const row = el("div", `row ${tr.type}` + (off ? " off" : "") + (tr.lock ? " locked" : "") + (dragging ? " dragging" : ""));
    row.dataset.track = tr.id;
    row.style.height = ROW[tr.type] + "px";
    row.append(header(tr));
    for (const c of tr.clips) if (c.start < view.b && c.start + c.duration > view.a) row.append(clipEl(c, view, tr));
    rows.append(row);
  }
  const filler = el("div", "row filler"); // fills the space below the last track, header column included
  filler.append(el("div", "label"));
  rows.append(filler);
  [cvCache, cvNext] = [cvNext, new Map()];
  ui();
}

const ICON = {
  hide: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};

// Track header: name (double-click to rename), flag buttons, delete; drag it up or down to reorder.
function header(tr) {
  const h = el("div", "label");
  h.dataset.track = tr.id;
  h.title = "Drag to reorder. Double-click the name to rename.";
  const btns = el("div", "tbtns");
  const keys = tr.type === "audio"
    ? [["mute", "M", "Mute"], ["solo", "S", "Solo: hear only solo tracks"], ["lock", ICON.lock, "Lock: no edits"]]
    : [["hide", ICON.hide, "Hide: not in preview or export"], ["lock", ICON.lock, "Lock: no edits"]];
  for (const [key, html, tip] of [...keys, ["del", "×", "Delete track and its clips"]]) {
    const b = el("button", (tr[key] ? "on " : "") + key);
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
      d.append(cached(c, `${key}|${c.fadeIn}|${c.fadeOut}|${!!S.peaks.get(c.src)}`, () => waveCanvas(c, from, to)));
    }
    if (k === "video") d.append(cached(c, `${key}|${!!strip(c.src)}`, () => filmCanvas(c, from, to)));
  }
  const parts = c.src.split("/");
  const label = c.src[0] === "@" ? c.props?.text || "text" : k === "scene" ? parts.at(-2) : parts.at(-1);
  d.append(el("span", "name", label));
  d.append(el("i", "edge l"), el("i", "edge r"));
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

function waveCanvas(c, from, to) {
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
  const mk = e.target.closest(".mk");
  if (mk) {
    const m = S.tl.markers.find((x) => x.id === mk.dataset.id);
    if (e.altKey) return removeMarker(m.id);
    S.drag = { type: "marker", id: m.id, x: e.clientX, t0: m.t, moved: false, snap: JSON.stringify(S.tl), targets: targets(new Set([m])) };
    return;
  }
  const node = e.target.closest(".clip");
  if (!node) {
    if (e.target.closest("#ruler")) {
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
  if (d.type === "box") return boxSelect(d, e);
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
    // vertical move: the one group clip of that track's type goes there (a video with its sound: the
    // video follows over video tracks, the sound over audio tracks); a bigger group stays put
    const type = S.tl.tracks.find((t) => t.id === id)?.type, same = group.filter((g) => trackOf(g.c).type === type);
    if (same.length === 1) moveTrack(same[0].c, id);
    const want = magnet(d, group.flatMap((g) => [g.o.start, g.o.start + g.o.duration]), dt, o.start, e);
    const lo = -Math.min(...group.map((g) => g.o.start)); // nothing goes before 0
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
      const lo = Math.max(...all.map((x) => Math.max(-(x.offset || 0), over ? -x.start : neighbors(x).prev - x.start)));
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
  if (d?.type === "marker") {
    if (d.moved) S.tl.markers.sort((a, b) => a.t - b.t);
    else seek(d.t0); // a click on a marker goes there
  }
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
  const mk = markerAt(e);
  if (!mk) return;
  e.preventDefault();
  removeMarker(mk.dataset.id);
});

// double-click: a small box under the marker with its name, color and Delete
sc.addEventListener("dblclick", (e) => {
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
  const src = e.dataTransfer.getData(DRAG_SRC);
  if (!src) return;
  e.preventDefault();
  clearDrop();
  S.focus = "timeline";
  addClip(src, { t: snap(Math.max(0, timeAt(e.clientX))), track: rowAt(e)?.dataset.track });
});

/* ---------- track header buttons and rename ---------- */

$("#tl").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const a = b.dataset.act, id = b.closest(".label")?.dataset.track;
  if (a.startsWith("add-")) addTrack(a.slice(4));
  else if (a === "del") deleteTrack(id);
  else toggleTrack(id, a);
});

$("#rows").addEventListener("dblclick", (e) => {
  const name = e.target.closest(".tname");
  if (!name) return;
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
export function zoomFit() {
  setZoom((sc.clientWidth - LABEL - 24) / Math.max(1, totalDur()));
  sc.scrollLeft = 0;
}
$("#zoom").addEventListener("input", (e) => setZoom(Number(e.target.value)));
$("#zoom").addEventListener("change", (e) => e.target.blur()); // a focused slider would swallow shortcuts
sc.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(S.pps * (e.deltaY < 0 ? 1.15 : 0.87));
}, { passive: false });
