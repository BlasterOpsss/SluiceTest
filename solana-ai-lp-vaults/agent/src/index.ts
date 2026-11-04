// Agent loop: watch one Orca pool, decide, risk-check, then (only if LIVE=1) execute.
//   dry run (default):  npm run once      -> logs what it WOULD do
//   live:               LIVE=1 npm start  -> sends transactions
import { Connection } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";
import {
  findPosition, readOracle, readPool, readVault, tokenBalance, vaultPda,
} from "./chain.js";
import { amountsFromLiquidity, sqrtAtTick, sqrtFromX64 } from "./math.js";
import { decide, type Plan } from "./strategy.js";
import { review } from "./risk.js";
import { Executor } from "./executor.js";
import type { Ctx } from "./ix.js";

interface State {
  highWater: number;
  lastMoveSecs: number | null;
  halted: string | null;
  failures: number;
}

const loadState = (p: string): State =>
  existsSync(p) && !process.env.RESET_STATE
    ? JSON.parse(readFileSync(p, "utf8"))
    : { highWater: 0, lastMoveSecs: null, halted: null, failures: 0 };
const saveState = (p: string, s: State) => writeFileSync(p, JSON.stringify(s, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

async function snapshot(cfg: Config, conn: Connection) {
  const ps = await readPool(conn, cfg.pool);
  const vv = await readVault(conn, cfg.programId, cfg.owner);
  const pos = await findPosition(conn, vv.vault, cfg.pool);
  const [balA, balB] = await Promise.all([tokenBalance(conn, vv.vault, ps.mintA), tokenBalance(conn, vv.vault, ps.mintB)]);
  const oracle = await readOracle(conn, cfg.programId, vv.vault, cfg.pool);
  const ctx: Ctx = { programId: cfg.programId, agent: cfg.agent.publicKey, pool: cfg.pool, ps, vv, oraclePda: oracle.pda };
  return { ps, vv, pos, balA, balB, oracle, ctx };
}

async function tick(cfg: Config, conn: Connection, st: State, ex: Executor, verified: Set<string>) {
  const nowSecs = Math.floor(Date.now() / 1000);
  const s = await snapshot(cfg, conn);

  const sP = sqrtFromX64(s.ps.sqrtPriceX64);
  const price = sP * sP;
  const inPos = s.pos && s.pos.liquidity > 0n
    ? amountsFromLiquidity(Number(s.pos.liquidity), sP, sqrtAtTick(s.pos.tickLower), sqrtAtTick(s.pos.tickUpper))
    : { a: 0, b: 0 };
  const value = (Number(s.balA) + inPos.a) * price + Number(s.balB) + inPos.b; // in token-B raw units
  if (value > st.highWater) st.highWater = value;

  let plan: Plan;
  if (st.halted) {
    plan = s.pos ? { kind: "exit", reason: `halted: ${st.halted}` } : { kind: "hold", reason: `halted: ${st.halted} (RESET_STATE=1 to resume)` };
  } else {
    plan = decide({
      nowSecs, tickCurrent: s.ps.tickCurrent, tickSpacing: s.ps.tickSpacing, position: s.pos,
      hasFunds: s.balA > 0n || s.balB > 0n, lastMoveSecs: st.lastMoveSecs,
      valueNow: value, highWater: st.highWater, stopLossBps: s.vv.stopLossBps,
    }, cfg.strategy);
  }

  const verdict = review(plan, {
    agentAuthorized: !!s.vv.agent && s.vv.agent.equals(cfg.agent.publicKey),
    paused: s.vv.paused, dailyCap: s.vv.dailyCap, actionsToday: s.vv.actionsToday, dayStart: s.vv.dayStart, nowSecs,
    poolAllowed: s.vv.allowedPools.some((p) => p.equals(cfg.pool)),
    mintsVerified: cfg.allowUnverified || (verified.has(s.ps.mintA.toBase58()) && verified.has(s.ps.mintB.toBase58())),
  });

  say("tick", {
    tick: s.ps.tickCurrent,
    position: s.pos ? { lower: s.pos.tickLower, upper: s.pos.tickUpper, liquidity: s.pos.liquidity.toString() } : null,
    value: Math.round(value), highWater: Math.round(st.highWater),
    plan, approved: verdict.approved, why: verdict.reason, mode: cfg.live ? "LIVE" : "DRY-RUN",
  });
  if (plan.kind === "hold" || !verdict.approved) return;
  if (!cfg.live) { say("dry_run_skip", { wouldDo: plan.kind }); return; }

  try {
    const log = (msg: string) => say("action", { msg });
    if (plan.kind === "exit" || plan.kind === "cleanup" || plan.kind === "rebalance") {
      if (s.pos) await ex.unwind(s.ctx, s.pos);
    }
    if (plan.kind === "exit") {
      st.halted = plan.reason;
    } else if (plan.kind === "open" || plan.kind === "rebalance") {
      const fresh = await snapshot(cfg, conn); // price/balances changed after unwinding
      const done = await ex.deploy(fresh.ctx, plan.lower, plan.upper, fresh.oracle);
      if (done) st.lastMoveSecs = nowSecs;
    }
    st.failures = 0;
    log(`${plan.kind} complete`);
  } catch (e) {
    st.failures += 1;
    say("action_failed", { error: e instanceof Error ? e.message : String(e), failures: st.failures });
    if (st.failures >= 3) {
      st.halted = "3 consecutive execution failures; check logs, then RESET_STATE=1";
      say("halted", { reason: st.halted });
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const registry = JSON.parse(readFileSync(cfg.registryPath, "utf8"));
  const verified = new Set<string>(registry.tokens.map((t: { mint: string }) => t.mint));
  const st = loadState(cfg.statePath);
  const ex = new Executor(conn, cfg.agent, (msg) => say("tx", { msg }));
  const once = process.argv.includes("--once");

  say("start", {
    mode: cfg.live ? "LIVE" : "DRY-RUN", program: cfg.programId.toBase58(), vault: vaultPda(cfg.programId, cfg.owner).toBase58(),
    pool: cfg.pool.toBase58(), agent: cfg.agent.publicKey.toBase58(), pollSecs: cfg.pollSecs,
  });
  if (cfg.allowUnverified) say("warning", { msg: "ALLOW_UNVERIFIED_TOKENS=1: token registry check is OFF (devnet testing only)" });

  for (;;) {
    try {
      await tick(cfg, conn, st, ex, verified);
      saveState(cfg.statePath, st);
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    if (once) break;
    await sleep(cfg.pollSecs * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
