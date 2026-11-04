// Pure concentrated-liquidity math (floating point; fine for sizing with safety margins).
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

export const sqrtAtTick = (tick: number) => Math.pow(1.0001, tick / 2);
export const sqrtFromX64 = (x: bigint) => Number(x) / 2 ** 64;
export const alignDown = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing + 0; // +0 normalizes -0
export const alignUp = (tick: number, spacing: number) => Math.ceil(tick / spacing) * spacing + 0;

/** Liquidity that `a` units of token A can fund. Infinity if price is above the range (A unused). */
export function liquidityFromA(a: number, sP: number, sL: number, sU: number): number {
  if (sP >= sU) return Infinity;
  const p = Math.max(sP, sL);
  return a / (1 / p - 1 / sU);
}

/** Liquidity that `b` units of token B can fund. Infinity if price is below the range (B unused). */
export function liquidityFromB(b: number, sP: number, sL: number, sU: number): number {
  if (sP <= sL) return Infinity;
  const p = Math.min(sP, sU);
  return b / (p - sL);
}

export function amountsFromLiquidity(L: number, sP: number, sL: number, sU: number) {
  const p = Math.min(Math.max(sP, sL), sU);
  return { a: L * (1 / p - 1 / sU), b: L * (p - sL) };
}

/** Largest liquidity whose token needs fit inside both caps. */
export function maxLiquidity(capA: number, capB: number, sP: number, sL: number, sU: number): number {
  const L = Math.min(liquidityFromA(capA, sP, sL, sU), liquidityFromB(capB, sP, sL, sU));
  return Number.isFinite(L) ? Math.max(0, Math.floor(L)) : 0;
}
