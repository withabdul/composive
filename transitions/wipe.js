// Wipe: a straight edge crosses the frame and shows the next scene behind it. dir = where the edge moves.
export const dirs = ["left", "right", "up", "down"];
export default (p, x) => {
  const q = (1 - p) * 100;
  const inset = { left: `0 0 0 ${q}%`, right: `0 ${q}% 0 0`, up: `${q}% 0 0 0`, down: `0 0 ${q}% 0` }[x.dir] ?? `0 0 0 ${q}%`;
  return { a: {}, b: { clipPath: `inset(${inset})` } };
};
