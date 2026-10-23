// Shared by the editor preview and the export renderer, so both draw identical frames.
export const MEDIA = /\.(mp4|webm|mov|mp3|wav|m4a|ogg|png|jpe?g|webp)$/i;

export const kind = (src) =>
  src[0] === "@" || /\.html?$/i.test(src) ? "scene" // "@text" = templates/text/index.html
  : /\.(mp4|webm|mov)$/i.test(src) ? "video"
  : /\.(mp3|wav|m4a|ogg)$/i.test(src) ? "audio"
  : "image";

let n = 0; // module wide: clips of two scene files read in the same ms must not get the same id
export function normalize(tl) {
  tl.fps ??= 30; tl.width ??= 1920; tl.height ??= 1080; tl.tracks ??= [];
  for (const tr of tl.tracks) {
    tr.type ??= "video"; tr.clips ??= [];
    for (const c of tr.clips) c.id ??= `c${Date.now().toString(36)}${n++}`;
  }
  return tl;
}

// Clips that sound: every clip on an audio track (its src may be a video file), by mute and solo.
export function audible(tl) {
  const aud = tl.tracks.filter((t) => t.type === "audio");
  const solo = aud.some((t) => t.solo);
  return aud.filter((t) => (solo ? t.solo : !t.mute)).flatMap((t) => t.clips);
}

// Transitions of the clips on one video track: [{ x, a, b, from, to }], a..b in video time.
// c.in at a cut (the clip before ends where c starts) is centered on the cut and shows both clips
// (from = the clip before, to = c); c.in with no clip before, or with `only: true`, plays over the start
// of c (from = null); c.out plays over the end of c (to = null), unless the next clip's `in` uses that cut.
// The clips limit the length: a cut takes half of it from each side.
export function clipTransitions(tr) {
  const cs = [...tr.clips].sort((p, q) => p.start - q.start), out = [];
  const cut = (p, q) => p && q && Math.abs(p.start + p.duration - q.start) < 1e-6 && !q.in?.only;
  cs.forEach((c, i) => {
    const prev = cs[i - 1], next = cs[i + 1];
    if (c.in?.type) {
      if (cut(prev, c)) {
        const d = Math.min(c.in.duration ?? 0.6, 2 * prev.duration, 2 * c.duration);
        out.push({ x: c.in, a: c.start - d / 2, b: c.start + d / 2, from: prev, to: c });
      } else {
        const d = Math.min(c.in.duration ?? 0.6, c.duration);
        out.push({ x: c.in, a: c.start, b: c.start + d, from: null, to: c });
      }
    }
    if (c.out?.type && !(cut(c, next) && next.in?.type)) { // (cut() is false for an `only` in)
      const e = c.start + c.duration, d = Math.min(c.out.duration ?? 0.6, c.duration);
      out.push({ x: c.out, a: e - d, b: e, from: c, to: null });
    }
  });
  return out;
}

/* ---------- keyframes ---------- */
// clip.keys = { prop: [{ t, v, ease }] }, sorted by t. t is clip-local time (offset included, the
// same time a scene gets), so keys stay on the content when the clip is moved, trimmed or split.
// `ease` shapes the way from that key to the next one.
export const EASES = ["linear", "in", "out", "inout", "hold"];
const EASE = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - (1 - p) ** 3,
  inout: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  hold: () => 0, // keep the value until the next key
};
const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
function lerp(a, b, p) {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * p;
  if (HEX.test(a) && HEX.test(b)) {
    const x = rgb(a), y = rgb(b);
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * p).toString(16).padStart(2, "0")).join("");
  }
  return p < 1 ? a : b; // other values change at the next key
}

export function keyValue(ks, t) {
  if (t <= ks[0].t) return ks[0].v;
  const i = ks.findIndex((k) => k.t > t);
  if (i < 0) return ks.at(-1).v;
  const a = ks[i - 1], b = ks[i];
  return lerp(a.v, b.v, (EASE[a.ease] ?? EASE.linear)((t - a.t) / (b.t - a.t)));
}

// the props of clip c at clip-local time `local`: defaults, then the clip's props, then its keyframes
export function propsAt(c, defaults, local) {
  const p = { ...defaults, ...c.props };
  for (const [k, ks] of Object.entries(c.keys ?? {})) if (ks.length) p[k] = keyValue(ks, local);
  return p;
}

// Video and image clips get these props; x and y are the center, as fractions of the frame.
// sx, sy stretch the width and height on top of scale.
export const MEDIA_PROPS = { x: 0.5, y: 0.5, scale: 1, sx: 1, sy: 1, rotation: 0, opacity: 1 };

function place(el, p) {
  el.style.transform = `translate(${(p.x - 0.5) * 100}%, ${(p.y - 0.5) * 100}%) rotate(${p.rotation}deg) scale(${p.scale * p.sx}, ${p.scale * p.sy})`;
  el.style.opacity = p.opacity;
}

const withTimeout =(p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

function syncVideo(v, target, playing) {
  if (playing) {
    if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
    if (v.paused) v.play().catch(() => {});
    return;
  }
  if (!v.paused) v.pause();
  if (Math.abs(v.currentTime - target) < 1e-3) return;
  return withTimeout(new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = target; }));
}

export function createStage(root, base = "/p/") {
  const nodes = new Map(); // clip id -> { el, k, src, ready }
  const groups = new Map(); // scene slug -> the box of its layers: a transition moves or fades the whole scene
  const mods = new Map(); // transition type -> Promise of its module, transitions/<type>.js
  let tl = null, ver = 0; // ver: reloadTransitions() makes a new URL so the edited file loads

  // a track's scene: "001-hook/V1" (all scenes), a scene track of the scene shown, or null (global)
  const sceneOf = (tr) => (tr.id.startsWith("G") ? null : tr.id.includes("/") ? tr.id.split("/")[0] : tl.view ?? null);
  function group(slug, z) {
    if (!slug) return root;
    let g = groups.get(slug);
    if (!g) { g = document.createElement("div"); g.className = "layer"; groups.set(slug, g); root.append(g); }
    g.style.zIndex = z;
    return g;
  }
  const transition = (type) => {
    if (!mods.has(type)) mods.set(type, import(`/tr/${type}.js?v=${ver}`).catch(() => null));
    return mods.get(type);
  };
  // set this frame's transition style on a scene box; remove what the last frame set and this one does not
  function fx(g, s) {
    for (const k of g.fx ?? []) if (!(k in s)) g.style[k] = "";
    Object.assign(g.style, s);
    g.fx = Object.keys(s);
  }
  // A transition's `over`: a layer over both sides (a color dip, a flash, a panel that covers the frame).
  // One per transition (key), reused; render() hides the ones this frame did not use.
  const overs = new Map();
  function over(key, parent, z, s) {
    let o = overs.get(key);
    if (!o) { o = document.createElement("div"); o.className = "layer"; overs.set(key, o); }
    if (o.parentNode !== parent) parent.append(o);
    o.style.zIndex = z;
    o.style.display = "";
    fx(o, s);
    o.used = true;
  }

  // Default props of a scene come from its <meta name="props" content='{"title":"..."}'>, re-read on every load.
  function loadScene(n) {
    n.ready = new Promise((r) => n.el.addEventListener("load", () => {
      try { n.defaults = JSON.parse(n.el.contentDocument.querySelector('meta[name="props"]')?.content ?? "{}"); } catch { n.defaults = {}; }
      r();
    }, { once: true }));
  }

  function make(c, parent) {
    const k = kind(c.src), url = c.src[0] === "@" ? `/t/${c.src.slice(1)}/index.html` : base + c.src;
    const n = { k, src: c.src, defaults: k === "scene" ? {} : { ...MEDIA_PROPS } };
    let el, ready;
    if (k === "scene") {
      el = n.el = document.createElement("iframe");
      loadScene(n);
      el.src = url;
    } else if (k === "video") {
      el = document.createElement("video"); el.muted = true; el.preload = "auto"; el.src = url;
      ready = withTimeout(new Promise((r) => el.addEventListener("loadeddata", r, { once: true })), 5000);
    } else {
      el = document.createElement("img"); el.src = url;
      ready = el.decode().catch(() => {});
    }
    el.className = "layer"; el.style.display = "none";
    // the wrap gets the clip's transition style, so it does not mix with the clip's own transform
    n.wrap = document.createElement("div");
    n.wrap.className = "layer";
    n.wrap.append(el);
    parent.append(n.wrap);
    n.el = el;
    n.ready ??= ready;
    return n;
  }

  return {
    setTimeline(next) {
      tl = next;
      root.style.width = tl.width + "px"; root.style.height = tl.height + "px";
      const want = new Map();
      const slugs = [...new Set(tl.tracks.map(sceneOf).filter(Boolean))].sort();
      tl.tracks.forEach((tr, i) => {
        if (tr.type === "audio" || tr.hide) return; // hidden tracks are left out of preview and export
        const s = sceneOf(tr);
        // scene boxes above the global layers, a later scene above the one before (it comes in over it)
        const parent = group(s, 10000 + slugs.indexOf(s));
        // z: 3 per track; +1 = the clip coming in at a cut, +2 = a clip transition's `over` layer (render)
        for (const c of tr.clips) want.set(c.id, { c, z: 3 * (tl.tracks.length - i), parent });
      });
      for (const [id, n] of nodes) {
        if (!want.has(id) || want.get(id).c.src !== n.src) { n.wrap.remove(); nodes.delete(id); }
      }
      for (const [id, { c, z, parent }] of want) {
        if (!nodes.has(id)) nodes.set(id, make(c, parent));
        const n = nodes.get(id);
        n.c = c;
        n.z = z; // first track = top layer; odd z = the clip coming in at a cut (render)
        n.wrap.style.zIndex = z;
        if (n.wrap.parentNode !== parent) { // its track moved between a scene and the global tracks
          parent.append(n.wrap);
          if (n.k === "scene") loadScene(n); // a moved iframe loads its page again
        }
      }
      for (const [s, g] of groups) if (!g.children.length) { g.remove(); groups.delete(s); }
    },
    reloadTransitions() { mods.clear(); ver++; },
    ready: () => Promise.all([...nodes.values()].map((n) => n.ready)),
    defaults: (id) => nodes.get(id)?.defaults ?? {},
    win: (id) => (nodes.get(id)?.k === "scene" ? nodes.get(id).el.contentWindow : null), // a scene's window
    props: (id) => nodes.get(id)?.p, // the props of the last rendered frame (keyframes applied)
    // length of a video clip's source file in seconds, or Infinity if not known (yet)
    srcDuration(id) {
      const d = nodes.get(id)?.el.duration;
      return Number.isFinite(d) ? d : Infinity;
    },
    // Visible content of a clip in stage pixels: { cx, cy, w, h, rot } (rot in degrees), or null.
    box(id) {
      const n = nodes.get(id);
      if (!n || n.el.style.display === "none") return null;
      if (n.k === "scene") {
        try { const own = n.el.contentWindow.box?.(); if (own) return own; } catch {} // a scene can report its own (rotated) box
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        try {
          const style = n.el.contentWindow.getComputedStyle;
          for (const e of n.el.contentDocument.body.querySelectorAll("*")) {
            const q = e.getBoundingClientRect();
            if (!q.width || !q.height) continue;
            const s = style(e);
            if (s.visibility === "hidden" || s.opacity === "0") continue; // not seen, so not part of the box
            l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
          }
        } catch { return null; }
        return r > l ? { cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t, rot: 0 } : null;
      }
      const p = n.p ?? { ...n.defaults, ...n.c.props };
      const nw = n.el.videoWidth || n.el.naturalWidth || tl.width, nh = n.el.videoHeight || n.el.naturalHeight || tl.height;
      const k = Math.min(tl.width / nw, tl.height / nh) * p.scale; // object-fit: contain
      return { cx: p.x * tl.width, cy: p.y * tl.height, w: nw * k * (p.sx ?? 1), h: nh * k * (p.sy ?? 1), rot: p.rotation };
    },
    // Is there clip content at (x, y), in stage pixels?
    hit(id, x, y) {
      const n = nodes.get(id);
      if (n?.k === "scene") {
        const d = n.el.contentDocument, e = d && d.elementFromPoint(x, y);
        return !!e && e !== d.documentElement && e !== d.body;
      }
      const b = this.box(id);
      if (!b) return false;
      const a = (-b.rot * Math.PI) / 180, dx = x - b.cx, dy = y - b.cy; // undo the rotation
      const u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.h / 2;
    },
    reloadScenes() {
      for (const n of nodes.values()) {
        if (n.k !== "scene") continue;
        loadScene(n);
        n.el.contentWindow.location.reload();
      }
    },
    async render(t, playing = false) {
      // transitions: the scene before and the scene after get a style from transitions/<type>.js
      const style = new Map();
      for (const o of overs.values()) o.used = false;
      for (const x of tl.transitions ?? []) {
        if (t < x.a || t >= x.b) continue;
        const f = (await transition(x.type))?.default;
        if (!f) continue;
        const p = (EASE[x.ease] ?? EASE.inout)((t - x.a) / (x.b - x.a));
        const s = x.to ? f(p, x) : f(1 - p, x); // a scene's out alone: its in style, backwards
        if (!s) continue;
        if (x.from && x.to) {
          if (groups.has(x.from)) style.set(groups.get(x.from), s.a ?? {});
          if (groups.has(x.to)) style.set(groups.get(x.to), s.b ?? {});
        } else if (groups.has(x.to ?? x.from)) style.set(groups.get(x.to ?? x.from), s.b ?? {});
        if (s.over) over(`s:${x.from}>${x.to}`, root, 20000, s.over); // over every scene box
      }
      for (const g of groups.values()) fx(g, style.get(g) ?? {});
      // clip transitions: style by clip id. At a cut both clips show (the clip before past its end, the
      // next one before its start); a clip with no partner plays the `in` style (`out` = `in` backwards)
      const cstyle = new Map(), top = new Set();
      for (const tr of tl.tracks) {
        if (tr.type === "audio" || tr.hide) continue;
        for (const x of clipTransitions(tr)) {
          if (t < x.a || t >= x.b) continue;
          const f = (await transition(x.x.type))?.default;
          if (!f) continue;
          const p = (EASE[x.x.ease] ?? EASE.inout)((t - x.a) / (x.b - x.a));
          const s = x.to ? f(p, x.x) : f(1 - p, x.x);
          if (!s) continue;
          if (x.from && x.to) {
            cstyle.set(x.from.id, s.a ?? {}); cstyle.set(x.to.id, s.b ?? {});
            top.add(x.to.id);
          } else cstyle.set((x.to ?? x.from).id, s.b ?? {});
          const n = nodes.get((x.to ?? x.from).id); // the over layer: on this track, over both clips
          if (s.over && n) over(`c:${x.from?.id}>${x.to?.id}`, n.wrap.parentNode, n.z + 2, s.over);
        }
      }
      for (const o of overs.values()) if (!o.used) o.style.display = "none";
      const jobs = [];
      for (const tr of tl.tracks) for (const c of tr.clips) {
        const n = nodes.get(c.id);
        if (!n) continue;
        fx(n.wrap, cstyle.get(c.id) ?? {});
        n.wrap.style.zIndex = n.z + top.has(c.id);
        const on = (t >= c.start && t < c.start + c.duration) || cstyle.has(c.id);
        n.el.style.display = on ? "" : "none";
        if (!on) { if (n.k === "video" && !n.el.paused) n.el.pause(); continue; }
        let local = t - c.start + (c.offset ?? 0);
        // outside the clip (a cut transition): after its end the clip plays on (a video shows its source frames
        // there); before its start a video shows the source frames before, an HTML clip holds its first frame
        local = Math.max(n.k === "scene" ? c.offset ?? 0 : 0, local);
        if (n.k === "scene") { // its defaults are known once loaded
          jobs.push(n.ready.then(() => {
            n.p = propsAt(c, n.defaults, local);
            try { return n.el.contentWindow.seek?.(local, c.total ?? c.duration, n.p); } catch {}
          }));
        } else {
          place(n.el, (n.p = propsAt(c, n.defaults, local)));
          if (n.k === "video") jobs.push(n.ready.then(() => syncVideo(n.el, local, playing)));
        }
      }
      await Promise.all(jobs);
    },
  };
}
