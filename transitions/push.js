// Push: the next scene pushes the scene before out of the frame. dir = where both move.
export const dirs = ["left", "right", "up", "down"];
const V = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
export default (p, x) => {
  const [dx, dy] = V[x.dir] ?? V.left, at = (k) => `translate(${dx * k * 100}%, ${dy * k * 100}%)`;
  return { a: { transform: at(p) }, b: { transform: at(p - 1) } };
};
