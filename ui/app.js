// Entry point: load the project, wire controls and shortcuts, live-reload on disk changes.
import { $, S, stage, normalize, audioClips, clips, locked, selected, setSel, totalDur, redraw, EPS } from "./core/state.js";
import { pushUndo } from "./core/history.js";
import { loadAudio } from "./timeline/audio.js";
import { fit, ui, play, pause, seek, playReverse } from "./canvas/viewer.js";
import { removeClips, undo, redo, copySel, paste, duplicate, setRange, clearRange, toggleLink, removeEmptyTracks } from "./core/edit.js";
import { drawSide, forgetSide } from "./sidebar/sidebar.js";
import { zoomFit } from "./timeline/timeline.js"; // timeline, import and panel also register their own listeners
import { forgetStrip } from "./timeline/filmstrip.js";
import "./sidebar/import.js";
import "./panel/panel.js";
import { nudge } from "./canvas/gizmo.js";

// takeTimeline=false keeps the in-memory timeline: it may hold edits not yet saved to disk.
async function fetchProject(takeTimeline = true) {
  const res = await fetch("/api/project");
  if (!res.ok) return false; // timeline.json may be mid-edit; keep last good state
  S.project = await res.json();
  if (takeTimeline) S.tl = normalize(S.project.timeline);
  return true;
}

async function refresh() {
  await Promise.all(audioClips().map((c) => loadAudio(c.src)));
  stage.setTimeline(S.tl);
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
const toggleMagnet = () => { S.magnet = !S.magnet; ui(); };
const toggleOverwrite = () => { S.overwrite = !S.overwrite; ui(); };
$("#magnet").onclick = toggleMagnet;
$("#overwrite").onclick = toggleOverwrite;
$("#cleanTracks").onclick = removeEmptyTracks;
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => { S.tool = b.dataset.tool; ui(); }));

addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input:not([type=range]), select")) return; // fields keep their native keys (Backspace, Ctrl+Z)
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    const keys = {
      z: () => (e.shiftKey ? redo() : undo()), y: redo,
      c: copySel, x: () => { copySel(); removeClips(selected(), S.magnet); }, v: paste,
      d: () => duplicate(selected()), a: () => { setSel(clips().filter((c) => !locked(c)).map((c) => c.id)); redraw(); },
      l: toggleLink,
    };
    if (keys[k]) { e.preventDefault(); keys[k](); }
    return;
  }
  if (e.target.matches("input, select")) return;
  const tools = { v: "view", h: "pan", x: "cut", s: "split" };
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  const step = e.shiftKey ? 10 : 1;
  const edges = [...new Set(clips().flatMap((c) => [c.start, c.start + c.duration]))].sort((a, b) => a - b);
  if (arrows[k] && S.focus === "canvas" && nudge(arrows[k][0] * step, arrows[k][1] * step)) e.preventDefault();
  else if (k === "escape") { S.sel = null; redraw(); }
  else if (k === " ") { e.preventDefault(); S.playing ? pause() : play(); }
  else if (k === "j") playReverse();
  else if (k === "k") pause();
  else if (k === "l") play();
  else if (k === "i") setRange("in");
  else if (k === "o") setRange("out");
  else if (k === "x" && e.altKey) { e.preventDefault(); clearRange(); }
  else if (k === "m") toggleMagnet();
  else if (k === "w") toggleOverwrite();
  else if (tools[k]) { S.tool = tools[k]; ui(); }
  else if (k === "delete" || k === "backspace") removeClips(selected(), S.magnet !== e.shiftKey); // ripple when magnet is on; Shift = the other way
  else if (k === "home") seek(0);
  else if (k === "end") seek(totalDur());
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
    const isTimeline = name === "timeline.json";
    const before = JSON.stringify(S.tl);
    if (!(await fetchProject(isTimeline))) return;
    // an outside edit (the AI) to the timeline can be undone too
    if (isTimeline && JSON.stringify(S.tl) !== before) pushUndo(before);
    drawSide();
    if (/\.(html|css|js)$/.test(name)) stage.reloadScenes();
    await refresh();
  }, 150);
};

if (await fetchProject()) {
  $("#folder").value = S.project.name;
  drawSide();
  await refresh();
}
