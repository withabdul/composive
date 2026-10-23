// Right panel: edit the selected clip or clips (timing, audio, props, track, raw JSON, actions).
// The form is rebuilt only when what it is built from changes (keyOf); otherwise the inputs are
// just synced, so typing never loses focus. With several clips selected, the fields show the main
// clip and an edit applies to all of them (start moves them all by the same amount).
import { $, S, el, MIN, EPS, bus, redraw, findClip, clipKind, trackOf, selected, selIds, snap, stage } from "../core/state.js";
import { pushUndo } from "../core/history.js";
import { commit, clampFades, splitClip, removeClips, duplicate, toggleLink, renameTrack, toggleTrack, setDuck, place, setProp, toggleKey, setEase, localAt, selTransition } from "../core/edit.js";
import { propsAt, keyValue, EASES } from "../canvas/stage.js";
import { ui } from "../canvas/viewer.js";

const FALLBACK = { offset: 0, fadeIn: 0, fadeOut: 0, volume: 1 };
const body = $("#pBody");
let shownKey = "", lastSel = null, closedFor = null, focusSnap = null;

// props that every selected clip has, with the main clip's defaults
function commonProps(cs, c) {
  const d = stage.defaults(c.id);
  return Object.keys(d).filter((k) => cs.every((x) => typeof stage.defaults(x.id)[k] === typeof d[k]));
}

// what the form is built from: rebuild when any of it changes
const keyOf = (c) => {
  const tr = trackOf(c), cs = selected();
  return [selIds().join(), c.src, clipKind(c), !!c.link, tr.id, tr.name, tr.mute, tr.solo, tr.hide, tr.lock, tr.voice, tr.duck,
    cs.map(clipKind).join(), commonProps(cs, c).join()].join("|");
};

// a field's value at the playhead (keyframes applied)
function read(c, path) {
  if (path.startsWith("props.")) return propsAt(c, stage.defaults(c.id), localAt(c))[path.slice(6)];
  if (c.keys?.[path]?.length) return keyValue(c.keys[path], localAt(c)); // an animated volume
  return c[path] ?? FALLBACK[path];
}

function group(title) {
  const g = el("div", "pg");
  g.append(el("h4", "", title));
  body.append(g);
  return g;
}

// Number props with a slider: [min, max, tick mark spacing] as shown in the panel. The slider moves in
// steps of 0.5; the number box keeps a finer step and can go past min and max.
const RANGE = {
  x: [0, 1, 0.5], y: [0, 1, 0.5], opacity: [0, 1, 0.5], round: [0, 1, 0.5], rotation: [-180, 180, 90],
  scale: [0, 500, 100], sx: [0, 500, 100], sy: [0, 500, 100], w: [0, 5, 1], h: [0, 5, 1], size: [0, 300, 50],
};
// props the panel shows in percent (stored as a factor: 1 = 100%)
const PCT = new Set(["scale", "sx", "sy"]);

function field(g, label, path, type, attrs = {}, keyable = false) {
  const row = el("label", "pf");
  const input = el(type === "area" ? "textarea" : "input");
  if (type !== "area") input.type = type;
  Object.assign(input, attrs);
  input.dataset.path = path;
  const key = path.slice(6), pct = path.startsWith("props.") && PCT.has(key);
  if (pct) input.dataset.mul = 100;
  const name = el("span", "", pct ? label + " %" : label);
  if (type === "number") scrub(name, input);
  row.append(name);
  const r = type === "number" && path.startsWith("props.") && RANGE[key];
  if (r) {
    const sl = el("input");
    Object.assign(sl, { type: "range", min: r[0], max: r[1], step: 0.5 });
    sl.dataset.path = path;
    const ticks = el("datalist"); // the browser draws these as tick marks under the slider
    ticks.id = "ticks-" + key; // one row per prop, so the id is unique
    for (let v = r[0]; v <= r[1]; v += r[2]) ticks.append(new Option("", v));
    sl.setAttribute("list", ticks.id);
    row.append(ticks);
    if (pct) sl.dataset.mul = 100;
    sl.addEventListener("change", () => sl.blur()); // a focused slider would swallow shortcuts
    row.classList.add("sl");
    row.append(sl);
  }
  row.append(input);
  if (keyable) row.append(...keyButtons(path.replace(/^props\./, ""), input));
  g.append(row);
}

// ◆ adds or removes a keyframe of this prop at the playhead; the easing menu shows when the playhead
// is on one of its keys. sync() sets their state.
function keyButtons(key, input) {
  const b = el("button", "kfb", "◆"), ease = el("select", "kfe");
  b.dataset.key = ease.dataset.key = key;
  b.tabIndex = -1;
  b.onpointerdown = (e) => e.preventDefault(); // no focus: a focused panel would record a second undo step
  b.onclick = (e) => {
    e.preventDefault(); // inside a <label>: do not pass the click to the input
    const c = findClip(S.sel);
    toggleKey(c, key, read(c, input.dataset.path));
    focusSnap = JSON.stringify(S.tl);
  };
  for (const v of EASES) ease.append(new Option(v === "inout" ? "ease in-out" : v === "in" ? "ease in" : v === "out" ? "ease out" : v, v));
  ease.title = "Easing from this keyframe to the next";
  ease.onchange = (e) => {
    e.stopPropagation();
    setEase(findClip(S.sel), key, ease.value);
    focusSnap = JSON.stringify(S.tl);
    ease.blur(); // a focused select would swallow shortcuts
  };
  return [b, ease];
}

// Drag a number field's label left/right to change it: 1 step per 2 px, Shift x10, Alt x0.1.
// One drag = one undo step.
function scrub(name, input) {
  name.classList.add("scrub");
  name.title = "Drag left or right (Shift = faster, Alt = finer)";
  name.onclick = (e) => e.preventDefault(); // a click on a <label> would focus the input
  name.onpointerdown = (e) => {
    if (e.button) return;
    e.preventDefault();
    name.setPointerCapture(e.pointerId);
    const step = Number(input.step) || 1, v0 = input.valueAsNumber || 0, x0 = e.clientX, snap0 = JSON.stringify(S.tl);
    name.onpointermove = (m) => {
      const k = m.shiftKey ? 10 : m.altKey ? 0.1 : 1;
      const dec = Math.max(0, -Math.floor(Math.log10(step * k) + 1e-9)); // decimals of the step: 0.05 -> 2
      input.value = (v0 + Math.round((m.clientX - x0) / 2) * step * k).toFixed(dec);
      apply(input);
    };
    name.onpointerup = () => {
      name.onpointermove = name.onpointerup = null;
      settle(input.dataset.path);
      if (JSON.stringify(S.tl) !== snap0) { pushUndo(snap0); ui(); }
    };
  };
}

function button(g, text, onclick) {
  const b = el("button", "", text);
  b.tabIndex = -1;
  b.onclick = onclick;
  g.append(b);
}

// JSON highlighting: a colored <pre> sits under a transparent textarea (no library).
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const span = (cls, s) => `<span class="${cls}">${s}</span>`;
function highlight(src) {
  return esc(src).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*(?:[eE][+-]?\d+)?|[{}\[\],]/g,
    (m, str, colon, lit) => str ? (colon ? span("jk", str) + span("jp", colon) : span("js", str))
      : lit ? span(lit === "null" ? "jl" : "jb", m)
      : /^[{}\[\],]$/.test(m) ? span("jp", m) : span("jn", m));
}
let painted = null;
function paintJson() {
  const json = $("#pJson");
  if (json.value === painted && json.previousSibling.innerHTML) return; // same text: skip the regex
  painted = json.value;
  // the <pre> is in the flow and sets the height; the textarea lies over it (CSS), so no height is measured here
  json.previousSibling.innerHTML = highlight(json.value) + "\n"; // the extra newline keeps the last empty line's height
}

function build(c) {
  body.innerHTML = "";
  const cs = selected(), many = cs.length > 1;
  const k = clipKind(c), parts = c.src.split("/"); // the sound of a video file counts as audio
  $("#pTitle").textContent = many ? `${cs.length} clips`
    : c.src[0] === "@" ? c.src.slice(1) : k === "scene" ? parts.at(-2) : parts.at(-1);

  const timing = group("Timing");
  for (const p of ["start", "duration", "offset"]) field(timing, p, p, "number", { step: "0.1" });

  if (cs.every((x) => clipKind(x) === "audio")) {
    const a = group("Audio");
    field(a, "volume", "volume", "number", { step: "0.05" }, !many);
    field(a, "fadeIn", "fadeIn", "number", { step: "0.1" });
    field(a, "fadeOut", "fadeOut", "number", { step: "0.1" });
  }

  const defaults = stage.defaults(c.id), keys = commonProps(cs, c);
  if (keys.length) {
    const g = group("Props");
    for (const key of keys) {
      const d = defaults[key], path = "props." + key;
      if (typeof d === "number") field(g, key, path, "number", { step: key === "rotation" || PCT.has(key) || Math.abs(d) > 1 ? "1" : "0.01" }, !many);
      else if (typeof d === "boolean") field(g, key, path, "checkbox");
      else if (typeof d === "string" && /^#[0-9a-f]{6}$/i.test(d)) field(g, key, path, "color", {}, !many);
      else field(g, key, path, key === "text" || String(d).includes("\n") ? "area" : "text");
    }
  }

  trackGroup(trackOf(c));

  const act = group("Actions");
  act.classList.add("pa");
  button(act, "Split at playhead", () => splitClip(findClip(S.sel), snap(S.t)));
  button(act, "Duplicate", () => duplicate(selected()));
  button(act, "Delete", () => removeClips(selected()));
  if (c.link) button(act, "Unlink (Ctrl+L)", toggleLink);
  else if (many) button(act, "Link selected (Ctrl+L)", toggleLink);

  if (many) return; // raw JSON is for one clip
  const raw = group("JSON");
  const ed = el("div", "jed"), pre = el("pre"), json = el("textarea");
  json.id = "pJson";
  json.spellcheck = false;
  json.oninput = paintJson;
  json.onchange = () => {
    const cur = findClip(S.sel);
    try {
      const next = JSON.parse(json.value);
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("not an object");
      for (const key of Object.keys(cur)) delete cur[key];
      Object.assign(cur, next, { id: S.sel }); // the id is not editable
      ed.classList.remove("bad");
      commit();
    } catch (err) {
      ed.classList.add("bad");
      ed.title = String(err);
    }
  };
  ed.append(pre, json);
  raw.append(ed);
}

// The main clip's track: name and flags. These call the track actions, which record their own undo step.
function trackGroup(tr) {
  const g = group("Track");
  const row = el("label", "pf"), name = el("input");
  name.value = tr.name || tr.id;
  name.onchange = (e) => { e.stopPropagation(); renameTrack(tr.id, name.value); focusSnap = JSON.stringify(S.tl); };
  row.append(el("span", "", "name"), name);
  g.append(row);
  const flags = tr.type === "audio" ? ["mute", "solo", "lock", "voice"] : ["hide", "lock"];
  const box = el("div", "pflags");
  for (const key of flags) {
    const l = el("label"), cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!tr[key];
    cb.onchange = (e) => { e.stopPropagation(); toggleTrack(tr.id, key); focusSnap = JSON.stringify(S.tl); };
    if (key === "voice") l.title = "Voice: tracks with duck go down while this track plays";
    l.append(cb, key);
    box.append(l);
  }
  g.append(box);
  if (tr.type !== "audio") return;
  // duck: the gain this track goes down to while a voice track plays; empty = off
  const drow = el("label", "pf"), duck = el("input");
  Object.assign(duck, { type: "number", min: 0, max: 0.95, step: 0.05, placeholder: "off", value: tr.duck ?? "" });
  duck.title = "Gain while a voice track plays (0.25 = about -12 dB). Empty = no ducking.";
  duck.onchange = (e) => {
    e.stopPropagation();
    setDuck(tr.id, duck.value === "" ? null : duck.valueAsNumber);
    focusSnap = JSON.stringify(S.tl);
    duck.blur();
  };
  drow.append(el("span", "", "duck"), duck);
  g.append(drow);
}

function sync(c) {
  const cs = selected();
  for (const input of body.querySelectorAll("[data-path]")) {
    if (input === document.activeElement) continue;
    const path = input.dataset.path, v = read(c, path);
    // several clips with different values: show "mixed" (start is relative, it shows the main clip)
    const mixed = cs.length > 1 && path !== "start" && cs.some((x) => read(x, path) !== v);
    input.placeholder = mixed ? "mixed" : "";
    if (input.type === "checkbox") { input.checked = !!v; input.indeterminate = mixed; }
    else input.value = mixed ? "" : input.dataset.mul && typeof v === "number" ? +(v * input.dataset.mul).toFixed(4) : v ?? "";
  }
  // keyframe buttons: "has" = the prop is animated, "on" = a key at the playhead
  const lt = localAt(c), inClip = S.t >= c.start - EPS && S.t <= c.start + c.duration + EPS;
  for (const b of body.querySelectorAll(".kfb")) {
    const ks = c.keys?.[b.dataset.key], k = ks?.find((x) => Math.abs(x.t - lt) < EPS);
    b.classList.toggle("has", !!ks?.length);
    b.classList.toggle("on", !!k);
    b.disabled = !inClip;
    b.title = !inClip ? "Move the playhead into this clip to add a keyframe"
      : k ? "Remove the keyframe at the playhead" : "Add a keyframe at the playhead";
    const ease = b.nextSibling;
    ease.hidden = !k;
    if (k && ease !== document.activeElement) ease.value = k.ease ?? "linear";
  }
  const json = $("#pJson");
  if (json && json !== document.activeElement) json.value = JSON.stringify(c, null, 2);
  if (json) paintJson();
}

// The selected transition: type, duration, easing, direction (when the type has some), Delete.
// Built again when it changes; each change is one undo step.
function trPanel() {
  const st = selTransition(), t = S.trSel;
  if (!st) return false;
  $("#panel").hidden = false;
  document.body.classList.add("panel");
  const key = "tr|" + JSON.stringify(t) + JSON.stringify(st.x);
  if (key === shownKey) return true;
  shownKey = key;
  body.innerHTML = "";
  $("#pTitle").textContent = `Transition ${t.side}` + (t.kind === "scene" ? ` (${t.slug})` : "");
  // an `in` with a clip or scene just before it: between the two, or (only) on this one alone
  const what = t.kind === "scene" ? "scene" : "clip";
  const partner = t.side === "in" && (t.kind === "scene" ? S.project.scenes.findIndex((s) => s.slug === t.slug) > 0
    : trackOf(st.c).clips.some((x) => Math.abs(x.start + x.duration - st.c.start) < EPS));
  const g = group("Transition");
  const row = (label, input) => { const r = el("label", "pf"); r.append(el("span", "", label), input); g.append(r); return input; };
  const type = row("type", el("select"));
  for (const n of S.project.transitions) type.append(new Option(n, n));
  type.value = st.x.type;
  const dur = row("duration", el("input"));
  Object.assign(dur, { type: "number", step: "0.1", min: String(MIN), value: st.x.duration ?? 0.6 });
  const ease = row("easing", el("select"));
  for (const v of EASES.filter((v) => v !== "hold")) ease.append(new Option(v === "inout" ? "ease in-out" : v === "in" ? "ease in" : v === "out" ? "ease out" : v, v));
  ease.value = st.x.ease ?? "inout";
  const dir = row("direction", el("select"));
  const color = row("color", el("input"));
  color.type = "color";
  dir.parentElement.hidden = color.parentElement.hidden = true;
  const only = row(`only this ${what}`, el("input"));
  only.type = "checkbox";
  only.checked = !!st.x.only;
  only.parentElement.hidden = !partner;
  import(`/tr/${st.x.type}.js`).then((m) => { // what this type takes: dirs (a menu), color (its default)
    if (m.dirs) {
      for (const d of m.dirs) dir.append(new Option(d, d));
      dir.value = st.x.dir ?? m.dirs[0];
      dir.parentElement.hidden = false;
    }
    if (m.color) { color.value = st.x.color ?? m.color; color.parentElement.hidden = false; }
  }).catch(() => {});
  const save = () => {
    const x = { ...st.x, type: type.value, duration: Math.max(MIN, dur.valueAsNumber || 0.6), ease: ease.value };
    if (type.value !== st.x.type) { delete x.dir; delete x.color; } // another type has other options
    else {
      if (!dir.parentElement.hidden) x.dir = dir.value;
      if (!color.parentElement.hidden) x.color = color.value;
    }
    if (partner && only.checked) x.only = true; else delete x.only;
    selTransition()?.set(x);
    focusSnap = JSON.stringify(S.tl); // the setter recorded its own undo step
  };
  for (const i of [type, dur, ease, dir, color, only]) i.onchange = (e) => { e.stopPropagation(); save(); i.blur(); };
  g.append(el("p", "pnote", t.side === "out" ? `Plays over the end of this ${what} only (its in style, backwards). Not used when the next ${what} has a transition on this ${t.kind === "scene" ? "seam" : "cut"} that is not "only".`
    : partner && !st.x.only ? (t.kind === "scene" ? "Between the two scenes: this scene starts this much earlier, over the end of the scene before."
      : "Between the two clips: centered on the cut, both clips play.")
    : `Plays over the start of this ${what} only, over what is under it.`));
  const act = group("Actions");
  act.classList.add("pa");
  button(act, "Delete", () => { selTransition()?.set(null); S.trSel = null; redraw(); });
  return true;
}

function render() {
  if (S.trSel && trPanel()) return;
  if (S.sel !== lastSel) { lastSel = S.sel; closedFor = null; }
  const c = S.sel && findClip(S.sel);
  const show = !!c && closedFor !== c.id;
  $("#panel").hidden = !show;
  document.body.classList.toggle("panel", show);
  if (!show) { shownKey = ""; return; }
  if (keyOf(c) !== shownKey) {
    build(c);
    shownKey = keyOf(c);
    // a scene's props are known only after it has loaded; rebuild once if they changed
    stage.ready().then(() => { if (S.sel === c.id && keyOf(c) !== shownKey) render(); });
  }
  sync(c);
}

// Writes a field to every selected clip. `start` moves them all by the main clip's change, so a
// group (or a video and its linked sound) keeps its spacing.
function apply(input) {
  const path = input.dataset.path, main = findClip(S.sel), cs = selected();
  let v = input.type === "checkbox" ? input.checked : input.type === "number" ? input.valueAsNumber : input.value;
  if (Number.isNaN(v) || !main) return;
  if (input.dataset.mul) v /= input.dataset.mul; // percent field -> stored factor
  if (path.startsWith("props.")) {
    const key = path.slice(6);
    for (const c of cs) if (key in stage.defaults(c.id)) setProp(c, key, v); // auto-key when animated
  } else if (path === "start") {
    const d = Math.max(0, v) - main.start;
    for (const c of cs) c.start = Math.max(0, c.start + d);
  } else if (path === "volume") {
    for (const c of cs) setProp(c, "volume", Math.max(0, v)); // auto-key when animated
  } else {
    if (path === "offset" || path === "fadeIn" || path === "fadeOut") v = Math.max(0, v);
    if (path === "duration") v = Math.max(MIN, v);
    for (const c of cs) { c[path] = v; clampFades(c); }
  }
  commit();
}

// One edited field = one undo step, recorded when the field is left.
body.addEventListener("focusin", () => { focusSnap = JSON.stringify(S.tl); });
body.addEventListener("input", (e) => {
  if (e.target.dataset.path) apply(e.target);
});
const flush = () => {
  if (focusSnap && JSON.stringify(S.tl) !== focusSnap) { pushUndo(focusSnap); ui(); }
  focusSnap = JSON.stringify(S.tl);
};
// When a new start or duration is done (not on every key, or each digit could make a track): clips that
// now cover others follow the timeline rule (Overwrite cuts, else a new track).
function settle(path) {
  if (path !== "start" && path !== "duration") return;
  place(selected());
  commit();
}
body.addEventListener("change", (e) => { settle(e.target.dataset.path); flush(); });
body.addEventListener("focusout", flush);

$("#pClose").onclick = () => {
  if (S.trSel) { S.trSel = null; return redraw(); } // closing a transition's panel deselects it
  closedFor = S.sel;
  render();
};
bus.addEventListener("redraw", render);
// the playhead moved (seek, playback): animated values and keyframe buttons change
bus.addEventListener("time", () => {
  const c = shownKey && S.sel && findClip(S.sel);
  if (c) sync(c);
});
