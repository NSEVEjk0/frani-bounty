/**
 * frani-bounty — exact money math (pure, no dependencies)
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Money is ALWAYS handled as BigInt in the token's smallest unit — never as a
 * float. UCT carries 18 decimals, so a naive Number would lose precision long
 * before it mattered. These helpers convert at the edges (human ⇄ base units)
 * and format for display; everything in between is integer arithmetic.
 *
 * Kept dependency-free on purpose so the escrow math can be reasoned about and
 * unit-tested without booting the SDK.
 */

/** Convert a whole-token amount (number|string) to smallest-unit BigInt. */
export function toBaseUnits(whole, decimals) {
  const s = String(whole).trim();
  const neg = s.startsWith('-');
  const [intPart, fracRaw = ''] = s.replace(/^-/, '').split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const digits = ((intPart || '0') + frac).replace(/^0+(?=\d)/, '');
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

/** Convert a smallest-unit amount (BigInt|string) to a human whole-token string. */
export function toWholeString(base, decimals) {
  let v = BigInt(base);
  const neg = v < 0n;
  if (neg) v = -v;
  const denom = 10n ** BigInt(decimals);
  const int = v / denom;
  const frac = (v % denom).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** `1.5 UCT` — a compact display string for a base-unit amount. */
export function fmt(base, decimals, symbol) {
  return `${toWholeString(base, decimals)} ${symbol}`;
}

/**
 * Protocol fee (base units), floor-divided so we never over-charge by a
 * rounding unit. fee = amount * bps / 10000.
 */
export function feeOf(base, bps) {
  return (BigInt(base) * BigInt(bps)) / 10000n;
}

/** Smallest of a list of BigInts. */
export function bigMin(...vals) {
  return vals.reduce((m, v) => (v < m ? v : m), vals[0]);
}

/** Largest of a list of BigInts. */
export function bigMax(...vals) {
  return vals.reduce((m, v) => (v > m ? v : m), vals[0]);
}

/** Clamp `v` into [lo, hi] (BigInt). */
export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export default { toBaseUnits, toWholeString, fmt, feeOf, bigMin, bigMax, clamp };
