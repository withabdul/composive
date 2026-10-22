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
const MEDIA_PROPS = { x: 0.5, y: 0.5, scale: 1, sx: 1, sy: 1, rotation: 0, opacity: 1 };

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
  let tl = null;

  // Default props of a scene come from its <meta name="props" content='{"title":"..."}'>, re-read on every load.
  function loadScene(n) {
    n.ready = new Promise((r) => n.el.addEventListener("load", () => {
      try { n.defaults = JSON.parse(n.el.contentDocument.querySelector('meta[name="props"]')?.content ?? "{}"); } catch { n.defaults = {}; }
      r();
    }, { once: true }));
  }

  function make(c) {
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
    root.append(el);
    n.el = el;
    n.ready ??= ready;
    return n;
  }

  return {
    setTimeline(next) {
      tl = next;
      root.style.width = tl.width + "px"; root.style.height = tl.height + "px";
      const want = new Map();
      tl.tracks.forEach((tr, i) => {
        if (tr.type === "audio" || tr.hide) return; // hidden tracks are left out of preview and export
        for (const c of tr.clips) want.set(c.id, { c, z: tl.tracks.length - i });
      });
      for (const [id, n] of nodes) {
        if (!want.has(id) || want.get(id).c.src !== n.src) { n.el.remove(); nodes.delete(id); }
      }
      for (const [id, { c, z }] of want) {
        if (!nodes.has(id)) nodes.set(id, make(c));
        const n = nodes.get(id);
        n.c = c;
        n.el.style.zIndex = z; // first track = top layer (props are applied by render)
      }
    },
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
      const jobs = [];
      for (const tr of tl.tracks) for (const c of tr.clips) {
        const n = nodes.get(c.id);
        if (!n) continue;
        const on = t >= c.start && t < c.start + c.duration;
        n.el.style.display = on ? "" : "none";
        if (!on) { if (n.k === "video" && !n.el.paused) n.el.pause(); continue; }
        const local = t - c.start + (c.offset ?? 0);
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
