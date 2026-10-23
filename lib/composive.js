// Clip runtime, shared by every HTML clip: <script src="/lib/composive.js"></script>
// (GSAP first if the clip uses `timeline`: <script src="/lib/gsap/gsap.min.js"></script>).
//
// composive.clip({ update, timeline, fadeIn, fadeOut }) defines window.seek(t, duration, props):
//   update(p, t, duration)    every frame: text, colors, position from props
//   timeline(tl, p, duration) GSAP: built again only when props or duration change, then set to time t;
//                             add every tween to tl
//   fadeIn, fadeOut           seconds, the whole page fades in at the start and out at the end
// Props are the <meta name="props"> defaults merged with the clip's props.
(() => {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
  let defaults = {};
  try { defaults = JSON.parse(meta("props") ?? "{}"); } catch {}

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  // 0..1 progress of t through [start, start + len]
  const range = (t, start, len) => (len > 0 ? clamp((t - start) / len) : t >= start ? 1 : 0);
  const ease = {
    linear: (x) => x,
    in: (x) => x * x * x,
    out: (x) => 1 - (1 - x) ** 3,
    inout: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  };
  // props x, y (fractions of the frame) -> left, top. To center the element on that point: with GSAP,
  // gsap.set(el, { xPercent: -50, yPercent: -50 }) in `timeline`; without GSAP, CSS transform: translate(-50%, -50%).
  // Never the CSS `translate`, `scale` or `rotate` properties on an element GSAP animates: GSAP moves them into
  // its transform and they are lost when the timeline is built again.
  const place = (el, p) => {
    el.style.left = p.x * 100 + "%";
    el.style.top = p.y * 100 + "%";
    return el;
  };

  function clip({ update, timeline, fadeIn = 0, fadeOut = 0 } = {}) {
    if (timeline && !window.gsap) throw new Error("composive: load /lib/gsap/gsap.min.js before /lib/composive.js");
    let tl = null, ctx = null, built = null;
    window.seek = (t, duration = Number(meta("duration")) || 4, props) => {
      const p = { ...defaults, ...props };
      const key = timeline && JSON.stringify([duration, p]);
      if (timeline && key !== built) ctx?.revert(); // undo the old timeline's inline styles before update and the rebuild
      update?.(p, t, duration);
      if (timeline) {
        if (key !== built) {
          ctx = gsap.context(() => { tl = gsap.timeline({ paused: true }); timeline(tl, p, duration); });
          built = key;
        }
        tl.totalTime(Math.max(0, t), true); // callbacks are skipped: a frame must not depend on the previous one
      }
      const a = fadeIn > 0 ? range(t, 0, fadeIn) : 1;
      const b = fadeOut > 0 ? 1 - range(t, duration - fadeOut, fadeOut) : 1;
      document.documentElement.style.opacity = Math.min(a, b);
    };
    window.seek(0); // first frame, also when the page is opened alone
  }

  // speed ramp: play all of timeline `inner` in `duration` seconds along `ease`; add the result to tl
  const ramp = (inner, duration, ease = "power2.inOut") =>
    inner.paused(true).tweenFromTo(0, inner.duration(), { duration, ease });

  window.composive = { clip, place, ease, clamp, range, ramp, props: defaults };
})();
