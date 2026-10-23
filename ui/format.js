// Size button in the top bar (e.g. "1080×1920 · 30 fps"): a dialog sets the frame size (a preset or
// custom) and the fps of the whole video. A size change from anywhere (the dialog, undo, an outside edit
// of timeline.json) fits the viewer again and rebuilds the sidebar thumbnails.
import { $, S, bus, el } from "./core/state.js";
import { setFormat } from "./core/edit.js";
import { FORMATS, FPS, formatOf } from "./core/project.js";
import { fit } from "./canvas/viewer.js";
import { drawSide } from "./sidebar/sidebar.js";

const btn = $("#formatBtn");
const even = (v) => Math.max(2, Math.round(v / 2) * 2); // the H.264 export (yuv420p) needs even sizes

let last = "";
bus.addEventListener("redraw", () => {
  if (!S.tl) return;
  const f = formatOf(S.tl), key = `${S.tl.width}x${S.tl.height}`;
  btn.textContent = `${S.tl.width}×${S.tl.height} · ${S.tl.fps} fps`;
  btn.title = `Frame size and fps${f ? ` (${f.label})` : ""}. Click to change.`;
  if (key === last) return;
  const first = !last;
  last = key; // before drawSide: it may redraw
  if (!first) { fit(); drawSide(); }
});

// the dialog: resolves { width, height, fps } or null on Cancel / Esc / a click outside
function pick() {
  return new Promise((done) => {
    const d = el("dialog", "modal"), box = el("div"), btns = el("div", "mbtns");
    const preset = el("select"), w = el("input"), h = el("input"), fps = el("select");
    for (const f of FORMATS) preset.append(new Option(`${f.label}  (${f.width}×${f.height})`, f.id));
    preset.append(new Option("Custom", ""));
    for (const i of [w, h]) Object.assign(i, { type: "number", min: 2, step: 2 });
    w.value = S.tl.width; h.value = S.tl.height;
    for (const v of [...new Set([...FPS, S.tl.fps])].sort((a, b) => a - b)) fps.append(new Option(`${v} fps`, v));
    fps.value = S.tl.fps;
    const sync = () => (preset.value = formatOf({ width: +w.value, height: +h.value })?.id ?? "");
    sync();
    preset.onchange = () => { const f = FORMATS.find((x) => x.id === preset.value); if (f) { w.value = f.width; h.value = f.height; } };
    w.oninput = h.oninput = sync;
    const l1 = el("label", "", "Preset"), l2 = el("label", "", "Width (px)"), l3 = el("label", "", "Height (px)"), l4 = el("label", "", "Frame rate");
    l1.append(preset); l2.append(w); l3.append(h); l4.append(fps);
    const no = el("button", "", "Cancel"), yes = el("button", "on", "Apply");
    btns.append(no, yes);
    box.append(el("h3", "", "Video size"),
      el("p", "", "For the whole video. Clip positions are fractions of the frame, so they keep their place."), l1, l2, l3, l4, btns);
    d.append(box);
    document.body.append(d);
    const close = (v) => { d.close(); d.remove(); done(v); };
    no.onclick = () => close(null);
    yes.onclick = () => {
      if (!(+w.value > 0 && +h.value > 0)) return;
      close({ width: even(+w.value), height: even(+h.value), fps: +fps.value });
    };
    d.oncancel = (e) => { e.preventDefault(); close(null); }; // Esc
    d.onclick = (e) => { if (e.target === d) close(null); };
    d.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") yes.click(); }; // app shortcuts must not run behind it
    d.showModal();
    preset.focus();
  });
}

btn.onclick = async () => {
  btn.blur();
  const f = await pick();
  if (f) setFormat(f);
};
