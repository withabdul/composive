// Filmstrip for video clips: frames grabbed once per source from a hidden <video>, then reused.
import { el, redraw } from "../core/state.js";

export const FRAME_H = 44; // px, fits the video row
const strips = new Map(); // src -> { step, w, frames } once loaded, null while loading or failed

export function strip(src) {
  if (!strips.has(src)) { strips.set(src, null); grab(src); }
  return strips.get(src);
}

export const forgetStrip = (src) => strips.delete(src); // the file changed on disk

// shortcut: at most 60 frames per source, so long videos repeat frames when zoomed in; grab more if that shows
async function grab(src) {
  const v = el("video");
  v.muted = true;
  v.preload = "auto";
  v.src = "/p/" + src;
  await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
  if (!v.videoWidth || !Number.isFinite(v.duration)) return;
  const step = Math.max(1, v.duration / 60), w = Math.round((FRAME_H * v.videoWidth) / v.videoHeight), frames = [];
  for (let t = 0; t < v.duration; t += step) {
    await new Promise((r) => {
      v.addEventListener("seeked", r, { once: true });
      setTimeout(r, 2000); // a stuck seek must not stop the strip
      v.currentTime = Math.min(t + 0.05, v.duration - 0.05);
    });
    const cv = el("canvas");
    cv.width = w; cv.height = FRAME_H;
    cv.getContext("2d").drawImage(v, 0, 0, w, FRAME_H);
    frames.push(cv);
  }
  v.removeAttribute("src");
  v.load(); // frees the decoder
  strips.set(src, { step, w, frames });
  redraw();
}
