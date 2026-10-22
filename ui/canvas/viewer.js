// Viewer + transport: stage scaling, play/pause/seek, and the ui() refresh of everything time-dependent.
import { $, S, bus, stage, fmt, totalDur, LABEL } from "../core/state.js";
import { H } from "../core/history.js";
import { actx, startAudio, stopAudio, drawMeter, resetMeter } from "../timeline/audio.js";
import { drawBox } from "./gizmo.js";

export function fit() {
  const box = $("#fit").getBoundingClientRect();
  const k = Math.min(box.width / S.tl.width, box.height / S.tl.height);
  const s = $("#stage");
  s.style.transform = `scale(${k})`;
  s.style.setProperty("--inv", 1 / k); // keeps selection handles the same size on screen
  // scale() does not shrink the layout box, so pull it in with negative margins
  s.style.marginRight = -(S.tl.width * (1 - k)) + "px";
  s.style.marginBottom = -(S.tl.height * (1 - k)) + "px";
}
new ResizeObserver(() => S.tl && fit()).observe($("#fit"));

export function ui() {
  $("#time").textContent = `${fmt(S.t)} / ${fmt(totalDur())}`;
  $("#play").textContent = S.playing ? "Pause" : "Play";
  $("#undo").disabled = !H.undo.length;
  $("#redo").disabled = !H.redo.length;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === S.tool));
  $("#tlscroll").dataset.tool = S.tool;
  $("#magnet").classList.toggle("on", S.magnet);
  $("#overwrite").classList.toggle("on", S.overwrite);
  requestAnimationFrame(drawBox); // after the scenes have drawn this frame
  bus.dispatchEvent(new Event("time")); // the panel shows values at the playhead

  const x = LABEL + S.t * S.pps, sc = $("#tlscroll");
  $("#playhead").style.left = x + "px";
  if (S.playing && (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft + LABEL)) sc.scrollLeft = x - LABEL - 40;
}

function tick() {
  if (!S.playing) return;
  S.t = S.t0 + Math.max(0, actx.currentTime - S.ctxT0);
  const out = S.tl.range?.out, end = out != null && S.t0 < out ? out : totalDur(); // stop at the out marker when started before it
  if (S.t >= end) { S.t = end; pause(); return; }
  stage.render(S.t, true);
  ui();
  drawMeter();
  requestAnimationFrame(tick);
}

// J: play backward at normal speed, no sound (the audio engine plays forward only)
export function playReverse() {
  if (S.playing) pause();
  S.reverse = true;
  let last = performance.now();
  const loop = (now) => {
    if (!S.reverse) return;
    S.t = Math.max(0, S.t - (now - last) / 1000);
    last = now;
    stage.render(S.t, false);
    ui();
    if (S.t > 0) requestAnimationFrame(loop);
    else S.reverse = false;
  };
  requestAnimationFrame(loop);
}

export async function play() {
  S.reverse = false;
  await actx.resume();
  if (S.t >= totalDur()) S.t = S.win.a; // from the start of the scene shown
  S.playing = true;
  startAudio(S.t);
  tick();
}

export function pause() {
  S.reverse = false;
  S.playing = false;
  stopAudio();
  resetMeter();
  stage.render(S.t, false);
  ui();
}

export function seek(t) {
  S.t = Math.max(0, t);
  if (S.playing) startAudio(S.t);
  stage.render(S.t, S.playing);
  ui();
}
