// Flash: both scenes burn out to a bright color at the cut. Keep it short (0.2 to 0.4 s). color = the flash color.
export const color = "#ffffff";
export default (p, x) => {
  const k = 1 - Math.abs(2 * p - 1); // 0 -> 1 at the middle -> 0
  return {
    a: { opacity: p < 0.5 ? 1 : 0, filter: `brightness(${1 + 2 * k})` },
    b: { opacity: p < 0.5 ? 0 : 1, filter: `brightness(${1 + 2 * k})` },
    over: { background: x.color ?? color, opacity: k ** 2 },
  };
};
