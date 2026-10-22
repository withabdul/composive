// Left sidebar: Scenes tab (the clips of the scene shown, then the templates), Media tab (import, search, media grid),
// and the scene list in the top bar (the switch itself is in app.js).
import { $, S, el, clips, kind, fmt, metaDur, redraw, toast, DRAG_SRC } from "../core/state.js";
import { addClip, addTemplate, mediaUses, removeMedia } from "../core/edit.js";
import { ask } from "../timeline/timeline.js";
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
  tpls.delete(name.match(/^templates\/([^/]+)\//)?.[1]); // a file in that template's folder
  for (const path of cards.keys()) if (name.startsWith(path.slice(0, path.lastIndexOf("/") + 1))) cards.delete(path); // a file in that scene's folder
}

// put `nodes` into `box` only when they differ: re-inserting an iframe would reload it
function fill(box, nodes) {
  if (nodes.length !== box.children.length || nodes.some((n, i) => box.children[i] !== n)) box.replaceChildren(...nodes);
}

export function drawSide() {
  const pick = $("#scenePick");
  pick.innerHTML = "";
  pick.append(new Option("All scenes", ""));
  for (const s of S.project.scenes) pick.append(new Option(s.slug, s.slug));
  pick.value = S.scene;
  $("#scenePath").textContent = S.scene ? `scenes/${S.scene}/` : "-";
  // cards: the HTML clips of the scene shown (scenes/<slug>/<clip>/index.html)
  const shown = S.project.scenes.find((s) => s.slug === S.scene)?.clips ?? [];
  $("#scenes").dataset.empty = S.scene ? `No clips yet. Add scenes/${S.scene}/<clip>/index.html` : "Pick a scene to see its clips.";
  const size = `${S.tl.width}x${S.tl.height}`; // card thumbnails are scaled to the frame size
  cards = new Map(shown.map((s) => {
    const old = cards.get(s.path);
    return [s.path, old?.dataset.size === size ? old : card(s, size)];
  }));
  tiles = new Map(S.project.media.map((m) => [m, tiles.get(m) ?? tile(m)]));
  fill($("#scenes"), [...cards.values()]);
  drawTemplates(size);
  fill($("#media"), [...tiles.values()]);
  $('[data-tab="media"]').textContent = `Media (${S.project.media.length})`;
  filter();
}

function card(s, size) {
  const k = 198 / S.tl.width;
  const card = el("div", "card");
  card.dataset.size = size;
  card.title = s.path + "\nDrag onto the timeline to add";
  card.onclick = () => selectClip(s.path);
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
  const rm = el("button", "rm", "×");
  rm.tabIndex = -1;
  rm.title = "Delete (moves the file to .trash/)";
  rm.onclick = (e) => { e.stopPropagation(); askRemove(m); };
  t.ondblclick = () => addClip(m);
  th.append(rm);
  t.append(th, el("span", "mname", name));
  return t;
}

async function askRemove(m) {
  const uses = mediaUses(m), n = uses.reduce((s, u) => s + u.n, 0), name = m.split("/").pop();
  const text = n
    ? `It is used by ${n} clip${n > 1 ? "s" : ""} (${uses.map((u) => u.name).join(", ")}). They will be deleted too. The file goes to .trash/.`
    : "The file goes to .trash/ in the project folder.";
  if (await ask(`Delete ${name}?`, text, "Delete")) removeMedia(m);
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

// a click on a clip card: select that clip on the timeline and go to it
function selectClip(path) {
  const c = clips().find((x) => x.src === path);
  if (!c) return toast("Not in the timeline yet. Use + or drag it there.");
  S.sel = c.id;
  seek(c.start);
  redraw();
}

document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("#msearch").oninput = filter;
$("#mtype").onchange = (e) => { filter(); e.target.blur(); }; // a focused select would swallow shortcuts
// one card per templates/<slug>/: a preview at its middle with the default props.
// Kept between redraws like the clip cards; forgetSide() drops one whose files changed.
let tpls = new Map();
function drawTemplates(size) {
  tpls = new Map((S.project.templates ?? []).map((t) => {
    const key = `${t.slug}|${t.label}|${t.bottom}|${size}`, old = tpls.get(t.slug);
    return [t.slug, old?.dataset.key === key ? old : tplCard(t, key)];
  }));
  fill($("#templates"), [...tpls.values()]);
}

function tplCard(t, key) {
  const c = el("div", "tile"), th = el("div", "mthumb"), f = el("iframe");
  c.dataset.key = key;
  c.title = `${t.label}\ntemplates/${t.slug}/ (src "@${t.slug}")\nClick: add at the playhead. Drag: drop on the timeline.`;
  c.onclick = () => addTemplate(t);
  draggable(c, "@" + t.slug);
  th.style.aspectRatio = `${S.tl.width} / ${S.tl.height}`;
  f.src = `/t/${t.slug}/index.html`;
  f.style.width = S.tl.width + "px"; f.style.height = S.tl.height + "px";
  new ResizeObserver(() => (f.style.transform = `scale(${th.clientWidth / S.tl.width})`)).observe(th);
  let dur = 0, p = {}, raf = 0;
  const show = (time) => f.contentWindow?.seek?.(time, dur, p);
  f.onload = () => {
    const d = f.contentDocument;
    dur = metaDur(d);
    try { p = JSON.parse(d.querySelector('meta[name="props"]')?.content ?? "{}"); } catch { p = {}; }
    show(dur / 2);
  };
  // hover: play it in a loop from the start; leave: back to the middle frame
  c.onmouseenter = () => {
    if (!dur) return;
    const t0 = performance.now();
    const tick = (now) => { show(((now - t0) / 1000) % dur); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  };
  c.onmouseleave = () => { cancelAnimationFrame(raf); if (dur) show(dur / 2); };
  th.append(f);
  c.append(th, el("span", "mname", t.label));
  return c;
}

