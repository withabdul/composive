// Entry point: load the project, wire controls and shortcuts, live-reload on disk changes.
import { $, S, stage, audioClips, clips, locked, selected, setSel, totalDur, redraw, toast, EPS } from "./core/state.js";
import { H, pushUndo, useHistory, dropHistory } from "./core/history.js";
import { compose, isGlobal } from "./core/project.js";
import { loadAudio } from "./timeline/audio.js";
import { fit, ui, play, pause, seek, playReverse } from "./canvas/viewer.js";
import { removeClips, undo, redo, copySel, paste, duplicate, setRange, clearRange, toggleLink, removeEmptyTracks, addMarker, flushSave } from "./core/edit.js";
import { drawSide, forgetSide } from "./sidebar/sidebar.js";
import { zoomFit } from "./timeline/timeline.js"; // timeline, import and panel also register their own listeners
import { forgetStrip } from "./timeline/filmstrip.js";
import "./sidebar/import.js";
import "./panel/panel.js";
import { nudge } from "./canvas/gizmo.js";

// S.tl for the scene S.scene: its tracks in video time, the global tracks below. "" = all scenes:
// every scene's tracks read-only (`ro`, locked, not saved), the global tracks editable.
function view() {
  if (S.scene && !S.project.scenes.some((s) => s.slug === S.scene)) S.scene = ""; // its folder is gone
  const { tl, a, b } = compose(S.project, S.scene || undefined);
  if (!S.scene) for (const tr of tl.tracks) if (!isGlobal(tr)) tr.lock = tr.ro = true;
  S.tl = tl;
  S.win = { a, b };
}

// What this view shares with the other views (see useHistory): the scene start, and the global
// tracks (scene view) or the scene tracks (all scenes).
const sig = () => JSON.stringify([S.win.a, S.tl.tracks.filter((t) => (S.scene ? isGlobal(t) : t.ro))]);

// takeTimeline=false keeps the in-memory timeline: it may hold edits not yet saved to disk.
async function fetchProject(takeTimeline = true) {
  const res = await fetch("/api/project");
  if (!res.ok) return false; // timeline.json may be mid-edit; keep last good state
  S.project = await res.json();
  if (takeTimeline) view();
  return true;
}

const sceneKey = () => "composive.scene." + S.project.name;
async function openScene(slug) {
  flushSave(); // the pending save belongs to the scene shown now
  if (S.tl) H.sig = sig(); // not on the first open
  S.scene = slug;
  S.sel = null;
  view();
  useHistory(S.scene, sig());
  try { localStorage.setItem(sceneKey(), S.scene); } catch {}
  drawSide();
  await refresh();
  zoomFit();
  seek(S.win.a);
}

$("#scenePick").onchange = (e) => { openScene(e.target.value); e.target.blur(); }; // a focused select would swallow shortcuts
$("#addScene").onclick = async () => {
  const name = prompt("New scene name (e.g. hook):")?.trim();
  if (!name) return;
  const res = await fetch("/api/scene?name=" + encodeURIComponent(name), { method: "POST" });
  if (!res.ok) return toast("Could not make the scene: " + (await res.text()));
  const { slug } = await res.json();
  if (await fetchProject(false)) await openScene(slug);
};

async function refresh() {
  stage.setTimeline(S.tl); // first: a seek while the audio still decodes needs the stage ready
  await Promise.all(audioClips().map((c) => loadAudio(c.src)));
  fit();
  redraw();
  await stage.ready();
  await stage.render(S.t, false);
  redraw(); // scenes are loaded now, so the panel can list their props
  ui();
}

/* ---------- controls ---------- */

$("#play").onclick = () => (S.playing ? pause() : play());
$("#undo").onclick = undo;
$("#redo").onclick = redo;
// Magnet and Overwrite stay as set after a reload (this browser only; storage may be blocked)
try {
  const m = JSON.parse(localStorage.getItem("composive.modes")) ?? {};
  S.magnet = !!m.magnet;
  S.overwrite = !!m.overwrite;
} catch {}
const saveModes = () => { try { localStorage.setItem("composive.modes", JSON.stringify({ magnet: S.magnet, overwrite: S.overwrite })); } catch {} };
const toggleMagnet = () => { S.magnet = !S.magnet; saveModes(); ui(); };
const toggleOverwrite = () => { S.overwrite = !S.overwrite; saveModes(); ui(); };
$("#magnet").onclick = toggleMagnet;
$("#overwrite").onclick = toggleOverwrite;
$("#cleanTracks").onclick = removeEmptyTracks;
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => { S.tool = b.dataset.tool; ui(); }));

addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input:not([type=range]), select")) return; // fields keep their native keys (Backspace, Ctrl+Z)
  const k = e.key.toLowerCase();
  const marks = (S.tl.markers ?? []).map((m) => m.t);
  // keyframe times on the timeline, of the selected clips (or all clips)
  const kfTimes = (selected().length ? selected() : clips()).flatMap((c) => Object.values(c.keys ?? {}).flat()
    .map((k) => c.start + k.t - (c.offset || 0)).filter((t) => t >= c.start - EPS && t <= c.start + c.duration + EPS))
    .sort((a, b) => a - b);
  if (e.ctrlKey || e.metaKey) {
    const keys = {
      z: () => (e.shiftKey ? redo() : undo()), y: redo,
      c: copySel, x: () => { copySel(); removeClips(selected(), S.magnet); }, v: paste,
      d: () => duplicate(selected()), a: () => { setSel(clips().filter((c) => !locked(c)).map((c) => c.id)); redraw(); },
      l: toggleLink,
      m: () => e.shiftKey && seek(marks.findLast((t) => t < S.t - EPS) ?? S.t), // Ctrl+Shift+M: previous marker
      k: () => e.shiftKey && seek(kfTimes.findLast((t) => t < S.t - EPS) ?? S.t), // Ctrl+Shift+K: previous keyframe
    };
    if (keys[k]) { e.preventDefault(); keys[k](); }
    return;
  }
  if (e.target.matches("input, select")) return;
  const tools = { v: "view", h: "pan", x: "cut", s: "split" };
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  const step = e.shiftKey ? 10 : 1;
  const edges = [...new Set([...marks, ...clips().flatMap((c) => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
  if (arrows[k] && S.focus === "canvas" && nudge(arrows[k][0] * step, arrows[k][1] * step, e.repeat)) e.preventDefault();
  else if (k === "escape") { S.sel = null; redraw(); }
  else if (k === " ") { e.preventDefault(); S.playing ? pause() : play(); }
  else if (k === "j") playReverse();
  else if (k === "k" && e.shiftKey) seek(kfTimes.find((t) => t > S.t + EPS) ?? S.t); // next keyframe
  else if (k === "k") pause();
  else if (k === "l") play();
  else if (k === "i") setRange("in");
  else if (k === "o") setRange("out");
  else if (k === "x" && e.altKey) { e.preventDefault(); clearRange(); }
  else if (k === "m" && e.shiftKey) seek(marks.find((t) => t > S.t + EPS) ?? S.t); // next marker
  else if (k === "m") addMarker(S.t);
  else if (k === "n") toggleMagnet();
  else if (k === "w") toggleOverwrite();
  else if (tools[k]) { S.tool = tools[k]; ui(); }
  else if (k === "delete" || k === "backspace") removeClips(selected(), S.magnet !== e.shiftKey); // ripple when magnet is on; Shift = the other way
  else if (k === "home") seek(S.win.a);
  else if (k === "end") seek(S.scene ? S.win.b : totalDur());
  else if (k === "arrowleft") seek(S.t - (e.shiftKey ? 1 : 1 / S.tl.fps));
  else if (k === "arrowright") seek(S.t + (e.shiftKey ? 1 : 1 / S.tl.fps));
  else if (k === "arrowup") { e.preventDefault(); seek(edges.findLast((t) => t < S.t - EPS) ?? 0); }
  else if (k === "arrowdown") { e.preventDefault(); seek(edges.find((t) => t > S.t + EPS) ?? S.t); }
  else if (k === "\\") zoomFit();
});

/* ---------- live reload (AI edits files on disk) ---------- */

let pending = null;
new EventSource("/api/events").onmessage = (e) => {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    if (S.drag) return;
    const name = e.data;
    if (S.bufs.delete(name)) S.peaks.delete(name);
    forgetStrip(name);
    forgetSide(name);
    const isTimeline = name === "timeline.json" || /^scenes\/[^/]+\/timeline\.json$/.test(name);
    const before = JSON.stringify(S.tl), a0 = S.win.a;
    if (!(await fetchProject(isTimeline))) return;
    // an outside edit (the AI) to the timeline can be undone too; when it moved this scene's start
    // (a scene before it changed length) the old snapshots have the wrong times, so they go
    if (isTimeline && S.win.a !== a0) { dropHistory(S.scene); useHistory(S.scene, sig()); }
    else if (isTimeline && JSON.stringify(S.tl) !== before) pushUndo(before);
    drawSide();
    if (/\.(html|css|js)$/.test(name)) stage.reloadScenes();
    await refresh();
  }, 150);
};

if (await fetchProject(false)) {
  $("#folder").value = S.project.name;
  let last = "";
  try { last = localStorage.getItem(sceneKey()) ?? ""; } catch {}
  await openScene(last); // the scene open last time in this browser, else all scenes
}
