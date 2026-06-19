// Hand-counted cyclomatic complexity = 5
// McCabe rule: start at 1, +1 per decision point.
// Decision points:
//   base ........................ 1
//   if (n > 0 && flag) — the if . +1
//   ... and the && ............. +1
//   for (...) .................. +1
//   if (i % 2 === 0) ........... +1
//   ---------------------------------
//   total ...................... 5
export function classify(n: number, flag: boolean): string {
  if (n > 0 && flag) return 'a'; // if (+1), && (+1)
  for (let i = 0; i < n; i++) {  // for (+1)
    if (i % 2 === 0) continue;   // if (+1)
  }
  return 'b'; // base 1 -> total 5
}
