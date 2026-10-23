// Cover: a color panel crosses the frame; it hides the scene before and shows the next one behind it.
// dir = where the panel moves; color = the panel color.
export const dirs = ["left", "right", "up", "down"];
export const color = "#ffffff";
const V = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
export default (p, x) => {
  const [dx, dy] = V[x.dir] ?? V.left, k = 1 - 2 * p; // the panel: from one side (k = 1) over the frame (0) out the other side (-1)
  return {
    a: { opacity: p < 0.5 ? 1 : 0 },
    b: { opacity: p < 0.5 ? 0 : 1 },
    over: { background: x.color ?? color, transform: `translate(${-dx * k * 100}%, ${-dy * k * 100}%)` },
  };
};
