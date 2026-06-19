// Hand-counted cyclomatic complexity = 16
// McCabe rule: start at 1, +1 per decision point.
// Only plain `if` statements — 15 of them — plus the base path.
// Decision points:
//   base ............................. 1
//   15 x `if (a === k)` ............ +15
//   --------------------------------------
//   total ........................... 16
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
  if (a === 11) total += 11; // +1
  if (a === 12) total += 12; // +1
  if (a === 13) total += 13; // +1
  if (a === 14) total += 14; // +1
  if (a === 15) total += 15; // +1
  return total; // base 1 -> total 16
}
