// Blur dissolve: the scene before blurs away while the next scene comes in from a blur.
export default (p) => ({
  a: { filter: `blur(${p * 40}px)` },
  b: { filter: `blur(${(1 - p) * 40}px)`, opacity: p },
});
