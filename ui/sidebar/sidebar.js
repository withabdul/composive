// Left sidebar: Scenes tab (presets, scene thumbnails), Media tab (import, search, media grid),
// and the scene picker in the top bar.
import { $, S, el, clips, kind, fmt, metaDur, redraw, DRAG_SRC } from "../core/state.js";
import { addClip, addBuiltin } from "../core/edit.js";
import { seek } from "../canvas/viewer.js";

export function showTab(name) {
  for (const b of document.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== name;
}

// Cards and tiles are kept between redraws (a redraw happens on every file change), so their
// thumbnails, iframes and metadata load once. forgetSide() drops the ones whose file changed.
let cards = new Map(), tiles = new Map();
export function forgetSide(name) {
  tiles.delete(name);
  for (const path of cards.keys()) if (name.startsWith(path.slice(0, path.lastIndexOf("/") + 1))) cards.delete(path); // a file in that scene's folder
}

// put `nodes` into `box` only when they differ: re-inserting an iframe would reload it
function fill(box, nodes) {
  if (nodes.length !== box.children.length || nodes.some((n, i) => box.children[i] !== n)) box.replaceChildren(...nodes);
}

export function drawSide() {
  const pick = $("#scenePick");
  pick.innerHTML = "";
  for (const s of S.project.scenes) pick.append(new Option(s.name, s.path));
  const size = `${S.tl.width}x${S.tl.height}`; // card thumbnails are scaled to the frame size
  cards = new Map(S.project.scenes.map((s) => {
    const old = cards.get(s.path);
    return [s.path, old?.dataset.size === size ? old : card(s, size)];
  }));
  tiles = new Map(S.project.media.map((m) => [m, tiles.get(m) ?? tile(m)]));
  fill($("#scenes"), [...cards.values()]);
  fill($("#media"), [...tiles.values()]);
  $('[data-tab="media"]').textContent = `Media (${S.project.media.length})`;
  filter();
}

function card(s, size) {
  const k = 198 / S.tl.width;
  const card = el("div", "card");
  card.dataset.size = size;
  card.title = s.path + "\nDrag onto the timeline to add";
  card.onclick = () => openScene(s.path);
  draggable(card, s.path);
  const th = el("div", "thumb");
  th.style.height = S.tl.height * k + "px";
  const f = el("iframe");
  f.loading = "lazy"; // loads only when the Scenes tab shows it
  f.src = "/p/" + s.path;
  f.style.width = S.tl.width + "px"; f.style.height = S.tl.height + "px";
  f.style.transform = `scale(${k})`;
  f.onload = () => { const d = metaDur(f.contentDocument); f.contentWindow.seek?.(Math.min(1, d / 2), d); };
  th.append(f);
  const row = el("div", "cardrow");
  const add = el("button", "", "+");
  add.tabIndex = -1;
  add.onclick = (e) => { e.stopPropagation(); addClip(s.path); };
  row.append(el("span", "", s.name), add);
  card.append(th, row);
  return card;
}

function tile(m) {
  const k = kind(m), name = m.split("/").pop();
  const t = el("div", "tile " + k), th = el("div", "mthumb"), dur = el("span", "dur");
  t.title = m + "\nDouble-click to add, or drag onto the timeline";
  draggable(t, m);
  t.dataset.name = name.toLowerCase();
  t.dataset.kind = k;
  const showDur = (d) => { if (Number.isFinite(d)) dur.textContent = fmt(d).slice(0, -3); };
  if (k === "image") {
    const i = el("img");
    i.loading = "lazy";
    i.src = "/p/" + m;
    th.append(i);
  } else if (k === "video") {
    const v = el("video");
    v.muted = true;
    v.preload = "metadata";
    v.onloadedmetadata = () => showDur(v.duration);
    v.src = "/p/" + m + "#t=0.5"; // shows a frame from 0.5 s in
    th.append(v);
  } else {
    th.append(el("span", "icon", "♪"));
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => showDur(a.duration);
    a.src = "/p/" + m;
  }
  const add = el("button", "add", "+");
  add.tabIndex = -1;
  add.title = "Add to timeline";
  add.onclick = (e) => { e.stopPropagation(); addClip(m); };
  th.append(el("span", "badge", k), dur, add);
  t.ondblclick = () => addClip(m);
  t.append(th, el("span", "mname", name));
  return t;
}

// drag a tile onto the timeline (timeline.js reads DRAG_SRC on drop)
function draggable(node, src) {
  node.draggable = true;
  node.ondragstart = (e) => {
    e.dataTransfer.setData(DRAG_SRC, src);
    e.dataTransfer.effectAllowed = "copy";
  };
}

function filter() {
  const q = $("#msearch").value.trim().toLowerCase(), type = $("#mtype").value;
  let shown = 0;
  for (const t of $("#media").children) {
    t.hidden = (q && !t.dataset.name.includes(q)) || (type && t.dataset.kind !== type);
    if (!t.hidden) shown++;
  }
  const empty = $("#mempty");
  empty.hidden = shown > 0;
  empty.textContent = S.project.media.length ? "No match." : "No media yet. Drop files here or use Files / Folder.";
}

function openScene(path) {
  const c = clips().find((x) => x.src === path);
  if (!c) { $("#scenePath").textContent = path + " (not in timeline, use +)"; return; }
  S.sel = c.id;
  seek(c.start);
  redraw();
}

document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("#msearch").oninput = filter;
$("#mtype").onchange = (e) => { filter(); e.target.blur(); }; // a focused select would swallow shortcuts
$("#scenePick").onchange = (e) => openScene(e.target.value);
for (const b of document.querySelectorAll("[data-preset]")) {
  b.onclick = () => addBuiltin(b.dataset.preset);
  draggable(b, "@" + b.dataset.preset);
}
