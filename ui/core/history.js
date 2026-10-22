// Undo/redo stacks of JSON snapshots of S.tl. The undo/redo actions live in edit.js.
import { S } from "./state.js";

export const H = { undo: [], redo: [] };

export function pushUndo(snapshot) {
  H.undo.push(snapshot);
  if (H.undo.length > 100) H.undo.shift();
  H.redo = [];
}

export const record = () => pushUndo(JSON.stringify(S.tl));
