// Dip to color: the scene before fades to a color, the next scene fades in from it. color = the dip color.
export const color = "#000000";
export default (p, x) => ({
  a: { opacity: p < 0.5 ? 1 : 0 },
  b: { opacity: p < 0.5 ? 0 : 1 },
  over: { background: x.color ?? color, opacity: 1 - Math.abs(2 * p - 1) }, // full color at the middle
});
