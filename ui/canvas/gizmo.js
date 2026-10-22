// Canvas editing in the viewer. A clip with numeric x and y props (fractions of the frame: video,
// image, the built-in text) moves with the pointer. Corner handles change "scale", the round handle
// changes "rotation", when the clip has those props. Click empty space to deselect.
import { $, S, el, stage, clips, findClip, locked, clamp, redraw } from "../core/state.js";
import { pushUndo, record } from "../core/history.js";
import { commit } from "../core/edit.js";

const ov = $("#overlay");
const round = (v) => Math.round(v * 1e4) / 1e4;
const num = (v) => typeof v === "number";
const val = (c, k) => c.props?.[k] ?? stage.defaults(c.id)[k];

const box = el("div");
box.id = "selbox";
box.hidden = true;
for (const pos of ["tl", "tr", "bl", "br"]) { const h = el("i", pos); h.dataset.h = "scale"; box.append(h); }
const rh = el("i", "rot");
rh.dataset.h = "rot";
box.append(rh);
const gv = el("div", "guide v"), gh = el("div", "guide h");
gv.hidden = gh.hidden = true;
ov.append(box, gv, gh);

function draggable(c) {
  const d = stage.defaults(c.id);
  return num(d.x) && num(d.y) && !locked(c);
}

// pointer position in stage pixels
function px(e) {
  const r = $("#stage").getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * S.tl.width, y: ((e.clientY - r.top) / r.height) * S.tl.height };
}

// the selected clip if it is under the pointer, else the topmost one (tracks are ordered top first)
function pick(e) {
  const p = px(e);
  const on = (c) => S.t >= c.start && S.t < c.start + c.duration && draggable(c) && stage.hit(c.id, p.x, p.y);
  const sel = S.sel && findClip(S.sel);
  return sel && on(sel) ? sel : clips().find(on);
}

export function drawBox() {
  const c = S.sel && findClip(S.sel);
  const b = c && stage.box(c.id);
  box.hidden = !b;
  if (!b) return;
  Object.assign(box.style, {
    left: b.cx - b.w / 2 + "px", top: b.cy - b.h / 2 + "px",
    width: b.w + "px", height: b.h + "px", transform: `rotate(${b.rot}deg)`,
  });
  const d = stage.defaults(c.id);
  box.classList.toggle("scalable", num(d.scale));
  box.classList.toggle("rotatable", num(d.rotation));
}

// Snap one axis of a box (center c, size) to the frame edges and center. Returns { off, at } or null.
function snapAxis(c, size, full) {
  const th = (8 * S.tl.width) / $("#stage").getBoundingClientRect().width; // 8 screen pixels
  let best = null;
  for (const e of [c - size / 2, c, c + size / 2]) {
    for (const t of [0, full / 2, full]) {
      if (Math.abs(t - e) < th && (!best || Math.abs(t - e) < Math.abs(best.off))) best = { off: t - e, at: t };
    }
  }
  return best;
}

const angle = (p, b) => (Math.atan2(p.y - b.cy, p.x - b.cx) * 180) / Math.PI;

ov.addEventListener("pointerdown", (e) => {
  if (e.button) return;
  S.focus = "canvas";
  const sel = S.sel && findClip(S.sel);
  const type = e.target.dataset.h && sel ? e.target.dataset.h : "move";
  const c = type === "move" ? pick(e) : sel;
  if (!c) { S.sel = null; redraw(); return; }
  ov.setPointerCapture(e.pointerId);
  S.sel = c.id;
  const b = stage.box(c.id), p = px(e);
  S.drag = {
    type, id: c.id, p0: p, b, snap: JSON.stringify(S.tl),
    x0: val(c, "x"), y0: val(c, "y"), s0: val(c, "scale"), r0: val(c, "rotation"),
    a0: b && angle(p, b), dist0: b && Math.hypot(p.x - b.cx, p.y - b.cy),
  };
  redraw();
});

ov.addEventListener("pointermove", (e) => {
  const d = S.drag;
  if (!d) { ov.style.cursor = pick(e) ? "move" : ""; return; }
  if (!["move", "scale", "rot"].includes(d.type)) return;
  const p = px(e), c = findClip(d.id), W = S.tl.width, H = S.tl.height;
  const next = {};
  if (d.type === "move") {
    let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    const sx = !e.altKey && d.b && snapAxis(d.b.cx + dx, aabb(d.b).w, W);
    const sy = !e.altKey && d.b && snapAxis(d.b.cy + dy, aabb(d.b).h, H);
    if (sx) dx += sx.off;
    if (sy) dy += sy.off;
    guide(gv, "left", sx && sx.at);
    guide(gh, "top", sy && sy.at);
    next.x = round(clamp(d.x0 + dx / W, 0, 1));
    next.y = round(clamp(d.y0 + dy / H, 0, 1));
  } else if (d.type === "scale" && d.dist0) {
    next.scale = round(clamp((d.s0 * Math.hypot(p.x - d.b.cx, p.y - d.b.cy)) / d.dist0, 0.01, 20));
  } else if (d.type === "rot" && d.b) {
    let r = d.r0 + angle(p, d.b) - d.a0;
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    next.rotation = Math.round((((r % 360) + 540) % 360 - 180) * 10) / 10; // keep in -180..180
  }
  c.props = { ...c.props, ...next };
  commit();
});

ov.addEventListener("pointerup", () => {
  const d = S.drag;
  if (!d || !["move", "scale", "rot"].includes(d.type)) return;
  if (JSON.stringify(S.tl) !== d.snap) pushUndo(d.snap); // one drag = one undo step
  S.drag = null;
  gv.hidden = gh.hidden = true;
  redraw();
});

// axis-aligned size of a rotated box
function aabb(b) {
  const a = (b.rot * Math.PI) / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
  return { w: b.w * cos + b.h * sin, h: b.w * sin + b.h * cos };
}

function guide(g, side, at) {
  g.hidden = at == null || at === false;
  if (!g.hidden) g.style[side] = at + "px";
}

// Arrow keys move the selected clip by 1 stage pixel (10 with Shift). Returns false if it cannot move.
// A held key repeats: only its first press records an undo step, so one hold = one step.
export function nudge(dx, dy, repeat = false) {
  const c = S.sel && findClip(S.sel);
  if (!c || !draggable(c) || !(S.t >= c.start && S.t < c.start + c.duration)) return false;
  if (!repeat) record();
  c.props = {
    ...c.props,
    x: round(clamp(val(c, "x") + dx / S.tl.width, 0, 1)),
    y: round(clamp(val(c, "y") + dy / S.tl.height, 0, 1)),
  };
  commit();
  return true;
}
