// Iris: a circle grows from the center and shows the next scene (71% = half the frame diagonal).
export default (p) => ({ a: {}, b: { clipPath: `circle(${p * 71}% at 50% 50%)` } });
