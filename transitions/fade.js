// Crossfade: the next scene fades in over the scene before.
// A transition file: default (p, x) => ({ a, b }). p = eased progress 0..1, x = the scene's `transition`
// object (type, duration, ease, dir, ...). a = CSS of the scene before, b = CSS of the next scene
// (keys as in element.style: transform, opacity, clipPath, filter). Optional `dirs` = direction menu.
export default (p) => ({ a: {}, b: { opacity: p } });
