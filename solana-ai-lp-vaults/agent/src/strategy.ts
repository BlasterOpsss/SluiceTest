// Rule-based baseline strategy. Pure: no network, no wallet. The LLM layer (later)
// can only propose alternative Plans; risk.ts + the on-chain guardrails still decide.
import { MAX_TICK, MIN_TICK, alignDown, alignUp } from "./math.js";

export interface PositionView {
  mint: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

export interface StrategyParams {
  rangeSpacings: number; // half-width of a new range, in tick spacings
  edgeFraction: number; // rebalance when price is within this fraction of an edge
  minMoveSecs: number; // cooldown between range moves
}

export interface StrategyInput {
  nowSecs: number;
  tickCurrent: number;
  tickSpacing: number;
  position: PositionView | null;
  hasFunds: boolean;
  lastMoveSecs: number | null;
  valueNow: number | null; // vault value in token-B raw units
  highWater: number | null; // best value seen
  stopLossBps: number;
}

export type Plan =
  | { kind: "hold"; reason: string }
  | { kind: "open"; lower: number; upper: number; reason: string }
  | { kind: "rebalance"; lower: number; upper: number; reason: string }
  | { kind: "cleanup"; reason: string } // empty position: collect fees + close
  | { kind: "exit"; reason: string }; // stop-loss: unwind everything and stay flat

export function centeredRange(tick: number, spacing: number, spacings: number) {
  const minT = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxT = Math.floor(MAX_TICK / spacing) * spacing;
  let lower = Math.max(minT, alignDown(tick - spacings * spacing, spacing));
  let upper = Math.min(maxT, alignUp(tick + spacings * spacing, spacing));
  if (upper <= lower) upper = Math.min(maxT, lower + spacing);
  return { lower, upper };
}

export function decide(i: StrategyInput, p: StrategyParams): Plan {
  const pos = i.position;

  if (pos && pos.liquidity > 0n && i.valueNow !== null && i.highWater !== null && i.highWater > 0) {
    if (i.valueNow < i.highWater * (1 - i.stopLossBps / 10_000)) {
      return { kind: "exit", reason: `stop-loss: value ${i.valueNow.toFixed(0)} < ${(i.stopLossBps / 100).toFixed(1)}% below high-water ${i.highWater.toFixed(0)}` };
    }
  }

  if (pos && pos.liquidity === 0n) return { kind: "cleanup", reason: "position is empty" };

  if (!pos) {
    if (!i.hasFunds) return { kind: "hold", reason: "no funds in vault to deploy" };
    const r = centeredRange(i.tickCurrent, i.tickSpacing, p.rangeSpacings);
    return { kind: "open", ...r, reason: `no position; opening ${r.lower}..${r.upper} around tick ${i.tickCurrent}` };
  }

  const t = i.tickCurrent;
  const inRange = t >= pos.tickLower && t < pos.tickUpper;
  const edge = (pos.tickUpper - pos.tickLower) * p.edgeFraction;
  const nearEdge = inRange && (t - pos.tickLower < edge || pos.tickUpper - t <= edge);
  if (inRange && !nearEdge) return { kind: "hold", reason: "price comfortably in range" };

  const why = inRange ? "price near range edge" : "price out of range";
  if (i.lastMoveSecs !== null && i.nowSecs - i.lastMoveSecs < p.minMoveSecs) {
    return { kind: "hold", reason: `${why}, but cooling down (${p.minMoveSecs - (i.nowSecs - i.lastMoveSecs)}s left)` };
  }
  const r = centeredRange(t, i.tickSpacing, p.rangeSpacings);
  if (r.lower === pos.tickLower && r.upper === pos.tickUpper) return { kind: "hold", reason: `${why}, new range equals current` };
  return { kind: "rebalance", ...r, reason: `${why}; moving to ${r.lower}..${r.upper}` };
}
