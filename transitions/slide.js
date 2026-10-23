// Slide: the next scene slides in over the scene before, which moves a little and goes darker. dir = where it moves.
export const dirs = ["left", "right", "up", "down"];
const V = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
export default (p, x) => {
  const [dx, dy] = V[x.dir] ?? V.left, at = (k) => `translate(${dx * k * 100}%, ${dy * k * 100}%)`;
  return { a: { transform: at(p * 0.3), filter: `brightness(${1 - p * 0.5})` }, b: { transform: at(p - 1) } };
};
