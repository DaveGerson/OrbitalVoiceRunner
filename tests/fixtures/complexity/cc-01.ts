// Hand-counted cyclomatic complexity = 1
// McCabe rule: start at 1, +1 per decision point.
// Decision points here: NONE (straight-line code, no branches).
//   base ................. 1
//   --------------------------
//   total ................ 1
export function ccOne(a: number, b: number): number {
  const sum = a + b;
  const doubled = sum * 2;
  return doubled - 1;
}
