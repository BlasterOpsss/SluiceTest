import { test } from "node:test";
import assert from "node:assert/strict";
import { amountsFromLiquidity, maxLiquidity, sqrtAtTick } from "../src/math.js";
import { centeredRange, decide, type StrategyInput, type StrategyParams } from "../src/strategy.js";
import { review, type RiskContext } from "../src/risk.js";

const params: StrategyParams = { rangeSpacings: 10, edgeFraction: 0.15, minMoveSecs: 3600 };
const base: StrategyInput = {
  nowSecs: 100_000, tickCurrent: 0, tickSpacing: 64, position: null, hasFunds: true,
  lastMoveSecs: null, valueNow: null, highWater: null, stopLossBps: 1500,
};
const pos = (lower: number, upper: number, liquidity = 1000n) => ({ mint: "m", liquidity, tickLower: lower, tickUpper: upper });

test("centered range is aligned and symmetric", () => {
  assert.deepEqual(centeredRange(0, 64, 10), { lower: -640, upper: 640 });
  const r = centeredRange(100, 64, 10);
  assert.ok(r.lower % 64 === 0);
  assert.ok(r.upper % 64 === 0);
  assert.ok(r.lower < 100 && r.upper > 100);
});

test("liquidity sizing respects both caps", () => {
  const sP = 1, sL = sqrtAtTick(-640), sU = sqrtAtTick(640);
  const L = maxLiquidity(10_000_000, 10_000_000, sP, sL, sU);
  const a = amountsFromLiquidity(L, sP, sL, sU);
  assert.ok(a.a <= 10_000_000 * 1.0001 && a.b <= 10_000_000 * 1.0001);
  assert.ok(L > 300_000_000 && L < 330_000_000); // ~31.7x the deposit for +-6.4% range
  // price below range => only token A is needed
  const below = amountsFromLiquidity(L, sqrtAtTick(-1000), sL, sU);
  assert.equal(below.b, 0);
  // no funds => no liquidity
  assert.equal(maxLiquidity(0, 0, sP, sL, sU), 0);
});

test("opens when flat and funded; holds when unfunded", () => {
  assert.equal(decide(base, params).kind, "open");
  assert.equal(decide({ ...base, hasFunds: false }, params).kind, "hold");
});

test("holds while comfortably in range", () => {
  assert.equal(decide({ ...base, position: pos(-640, 640) }, params).kind, "hold");
});

test("rebalances when out of range, respecting cooldown", () => {
  const p = pos(-640, 640);
  const out = { ...base, tickCurrent: 900, position: p };
  assert.equal(decide(out, params).kind, "rebalance");
  const cooling = decide({ ...out, lastMoveSecs: 100_000 - 60 }, params);
  assert.equal(cooling.kind, "hold");
  assert.match(cooling.reason, /cooling down/);
  const r = decide(out, params);
  if (r.kind === "rebalance") assert.ok(r.lower < 900 && r.upper > 900);
});

test("rebalances near the edge", () => {
  assert.equal(decide({ ...base, tickCurrent: 600, position: pos(-640, 640) }, params).kind, "rebalance");
});

test("empty position is cleaned up", () => {
  assert.equal(decide({ ...base, position: pos(-640, 640, 0n) }, params).kind, "cleanup");
});

test("stop-loss exits when value falls below high-water mark", () => {
  const input = { ...base, position: pos(-640, 640), highWater: 1000, valueNow: 840 };
  assert.equal(decide(input, params).kind, "exit");
  assert.notEqual(decide({ ...input, valueNow: 900 }, params).kind, "exit");
});

const ctx: RiskContext = {
  agentAuthorized: true, paused: false, dailyCap: 10, actionsToday: 0, dayStart: 0,
  nowSecs: 1000, poolAllowed: true, mintsVerified: true,
};
const open = { kind: "open" as const, lower: -640, upper: 640, reason: "" };

test("risk gate: approves normal deploys, blocks unsafe ones", () => {
  assert.equal(review(open, ctx).approved, true);
  assert.equal(review(open, { ...ctx, paused: true }).approved, false);
  assert.equal(review(open, { ...ctx, poolAllowed: false }).approved, false);
  assert.equal(review(open, { ...ctx, mintsVerified: false }).approved, false);
  assert.equal(review(open, { ...ctx, agentAuthorized: false }).approved, false);
  assert.equal(review(open, { ...ctx, actionsToday: 9 }).approved, false); // 9 + 2 > 10
  assert.equal(review(open, { ...ctx, actionsToday: 8 }).approved, true);
});

test("risk gate: daily counter resets after 24h; exits allowed while paused", () => {
  assert.equal(review(open, { ...ctx, actionsToday: 10, dayStart: 0, nowSecs: 90_000 }).approved, true);
  assert.equal(review({ kind: "exit", reason: "" }, { ...ctx, paused: true, actionsToday: 10 }).approved, true);
  assert.equal(review({ kind: "cleanup", reason: "" }, { ...ctx, paused: true }).approved, true);
});
