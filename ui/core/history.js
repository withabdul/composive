// One undo/redo history for the whole project. A step is a JSON snapshot of every timeline.json (the global
// one and each scene's), so an undo works in any view, also for a change made in another scene.
// The undo/redo actions live in edit.js.
import { S } from "./state.js";
import { split, withSceneFields } from "./project.js";

export const H = { undo: [], redo: [] };

// The project now, or as it was when the view timeline was `tlJson` (a JSON snapshot of S.tl taken in this view).
export function snapshot(tlJson) {
  const { global, scene } = split(tlJson ? JSON.parse(tlJson) : S.tl, S.project.timeline, S.scene, S.win.a);
  const scenes = {};
  for (const s of S.project.scenes) scenes[s.slug] = s.slug === S.scene && scene ? withSceneFields({ ...scene }, s.timeline) : s.timeline;
  return JSON.stringify({ timeline: global, scenes });
}

export function pushSnapshot(snap) {
  H.undo.push(snap);
  if (H.undo.length > 100) H.undo.shift();
  H.redo = [];
}

// a snapshot of S.tl taken in this view before a change (drag start, panel focus)
export const pushUndo = (tlJson) => pushSnapshot(snapshot(tlJson));
export const record = () => pushSnapshot(snapshot());
