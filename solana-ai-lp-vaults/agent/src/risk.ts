// Deterministic risk gate. The strategy (or an LLM) only PROPOSES; this decides.
// The same limits are enforced again on-chain by the vault program.
import type { Plan } from "./strategy.js";

export interface RiskContext {
  agentAuthorized: boolean; // vault.agent == our key
  paused: boolean;
  dailyCap: number;
  actionsToday: number;
  dayStart: number;
  nowSecs: number;
  poolAllowed: boolean;
  mintsVerified: boolean;
}

export interface Review {
  approved: boolean;
  reason: string;
}

const SECONDS_PER_DAY = 86_400;
/** open + increase_liquidity each count against the on-chain daily cap. */
export const DEPLOY_ACTIONS = 2;

export function effectiveActions(c: RiskContext): number {
  return c.nowSecs - c.dayStart >= SECONDS_PER_DAY ? 0 : c.actionsToday;
}

export function review(plan: Plan, c: RiskContext): Review {
  if (plan.kind === "hold") return { approved: true, reason: "nothing to do" };
  if (!c.agentAuthorized) return { approved: false, reason: "this agent key is not the vault's agent" };

  // Risk-reducing moves are always allowed, even while paused.
  if (plan.kind === "exit" || plan.kind === "cleanup") return { approved: true, reason: "risk-reducing move" };

  if (c.paused) return { approved: false, reason: "vault is paused" };
  if (!c.poolAllowed) return { approved: false, reason: "pool is not on the owner's allowlist" };
  if (!c.mintsVerified) return { approved: false, reason: "pool tokens are not in the verified registry" };
  if (effectiveActions(c) + DEPLOY_ACTIONS > c.dailyCap) {
    return { approved: false, reason: `daily action cap (${c.actionsToday}/${c.dailyCap}) leaves no room to deploy` };
  }
  return { approved: true, reason: "within guardrails" };
}
