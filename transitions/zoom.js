// Zoom through: the scene before grows and fades out, the next scene comes from smaller to full size.
export default (p) => ({
  a: { transform: `scale(${1 + p})`, opacity: 1 - p },
  b: { transform: `scale(${0.7 + 0.3 * p})`, opacity: p },
});
