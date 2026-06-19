// Hand-counted cyclomatic complexity = 11
// McCabe rule: start at 1, +1 per decision point.
// Only plain `if` statements — each is one unambiguous decision point.
// Decision points:
//   base ............................. 1
//   if (a === 1) .................... +1
//   if (a === 2) .................... +1
//   if (a === 3) .................... +1
//   if (a === 4) .................... +1
//   if (a === 5) .................... +1
//   if (a === 6) .................... +1
//   if (a === 7) .................... +1
//   if (a === 8) .................... +1
//   if (a === 9) .................... +1
//   if (a === 10) ................... +1
//   --------------------------------------
//   total ........................... 11
export function score(a: number): number {
  let total = 0;
  if (a === 1) total += 1;   // +1
  if (a === 2) total += 2;   // +1
  if (a === 3) total += 3;   // +1
  if (a === 4) total += 4;   // +1
  if (a === 5) total += 5;   // +1
  if (a === 6) total += 6;   // +1
  if (a === 7) total += 7;   // +1
  if (a === 8) total += 8;   // +1
  if (a === 9) total += 9;   // +1
  if (a === 10) total += 10; // +1
  return total; // base 1 -> total 11
}
