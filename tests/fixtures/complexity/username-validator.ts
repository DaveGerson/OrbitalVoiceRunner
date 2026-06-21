// A small, realistic validator used to verify the cyclomatic-complexity gate:
// it lets the gate test assert ESLint reports an exact, hand-countable value and
// respects the "> max" boundary. (The production threshold of 10 firing on real
// over-limit code is covered end-to-end by tests/test_complexity_ratchet.ts.)
//
// Cyclomatic complexity = 6 (McCabe: start at 1, +1 per decision point):
//   base ................................................. 1
//   if (name.length < 3) ................................ +1
//   if (name.length > 20) ............................... +1
//   if (!/^[a-z0-9_]+$/i.test(name)) .................... +1
//   if (name.startsWith('_') || name.endsWith('_')) ..... +1   (the `if`)
//                                    ` || ` ............... +1   (the logical-or)
//   ----------------------------------------------------------
//   total ............................................... 6
export function validateUsername(name: string): string | null {
  if (name.length < 3) return 'too short';
  if (name.length > 20) return 'too long';
  if (!/^[a-z0-9_]+$/i.test(name)) return 'invalid characters';
  if (name.startsWith('_') || name.endsWith('_')) return 'must not start or end with "_"';
  return null;
}
