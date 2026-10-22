// Undo/redo stacks of JSON snapshots of S.tl, one pair per scene (and one for "all scenes").
// The undo/redo actions live in edit.js.
import { S } from "./state.js";

const stacks = new Map(); // scene slug -> { undo, redo, sig }
export let H = { undo: [], redo: [], sig: "" };

// Switch to the stacks of a scene. `sig` = what this view shares with the others (see app.js): when it
// changed while another scene was shown, the old snapshots would undo that change too, so they are dropped.
export function useHistory(slug, sig) {
  let h = stacks.get(slug);
  if (!h || h.sig !== sig) stacks.set(slug, (h = { undo: [], redo: [], sig }));
  H = h;
}

export const dropHistory = (slug) => stacks.delete(slug);

export function pushUndo(snapshot) {
  H.undo.push(snapshot);
  if (H.undo.length > 100) H.undo.shift();
  H.redo = [];
}

export const record = () => pushUndo(JSON.stringify(S.tl));
