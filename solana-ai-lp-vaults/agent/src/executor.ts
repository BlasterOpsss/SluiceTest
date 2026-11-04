// Executes approved plans on-chain. Every multi-step plan is crash-safe: the loop is
// stateless (positions are rediscovered from the vault each tick), so a failure halfway
// just means the next tick finishes the job.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  findPosition, pythFeedAccount, readPositionAccount, tokenBalance,
  type OnchainPosition, type OracleCfg,
} from "./chain.js";
import { amountsFromLiquidity, maxLiquidity, sqrtAtTick, sqrtFromX64 } from "./math.js";
import { closeIx, collectIx, decreaseIx, increaseIx, initTickArrayIx, m, openIx, tickArrayPda, type Ctx } from "./ix.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Executor {
  constructor(private conn: Connection, private agent: Keypair, private log: (msg: string) => void) {}

  private async send(label: string, ix: Transaction["instructions"], extraSigners: Keypair[] = []) {
    const sig = await sendAndConfirmTransaction(this.conn, new Transaction().add(...ix), [this.agent, ...extraSigners]);
    this.log(`tx ${label}: ${sig}`);
    await sleep(1500); // be gentle with public RPCs
  }

  /** Remove all liquidity, collect fees if any, close the position. Proceeds land in the vault. */
  async unwind(c: Ctx, pos: OnchainPosition): Promise<void> {
    const tol = Math.max(c.vv.maxSlippageBps, 100) / 10_000;
    if (pos.liquidity > 0n) {
      const exp = amountsFromLiquidity(Number(pos.liquidity), sqrtFromX64(c.ps.sqrtPriceX64),
        sqrtAtTick(pos.tickLower), sqrtAtTick(pos.tickUpper));
      await this.send("decrease_liquidity",
        [decreaseIx(c, pos, pos.liquidity, BigInt(Math.floor(exp.a * (1 - tol))), BigInt(Math.floor(exp.b * (1 - tol))))]);
    }
    let p = await readPositionAccount(this.conn, pos);
    if (p.feeOwedA > 0n || p.feeOwedB > 0n) {
      await this.send("collect_fees", [collectIx(c, p)]);
      p = await readPositionAccount(this.conn, pos);
    }
    await this.send("close_position", [closeIx(c, p)]);
  }

  /** Open a range and add as much liquidity as the on-chain per-call cap allows. Returns false if nothing to deploy. */
  async deploy(c: Ctx, lower: number, upper: number, oracle: OracleCfg): Promise<boolean> {
    const { ps, vv } = c;
    const [balA, balB] = await Promise.all([
      tokenBalance(this.conn, vv.vault, ps.mintA), tokenBalance(this.conn, vv.vault, ps.mintB),
    ]);
    const capOnA = (balA * BigInt(vv.maxPositionBps)) / 10_000n; // exact on-chain cap
    const capOnB = (balB * BigInt(vv.maxPositionBps)) / 10_000n;
    const sP = sqrtFromX64(ps.sqrtPriceX64), sL = sqrtAtTick(lower), sU = sqrtAtTick(upper);
    const L = Math.floor(maxLiquidity(Number(capOnA) * 0.98, Number(capOnB) * 0.98, sP, sL, sU) * 0.97);
    if (L <= 0) {
      this.log("nothing to deploy (vault balances/caps too small for this range)");
      return false;
    }
    const est = amountsFromLiquidity(L, sP, sL, sU);
    const tol = Math.max(vv.maxSlippageBps, 100) / 10_000;
    const clamp = (cap: bigint, e: number) => {
      const v = BigInt(Math.ceil(e * (1 + tol))) + 2n;
      return v < cap ? v : cap;
    };
    const maxA = clamp(capOnA, est.a);
    const maxB = clamp(capOnB, est.b);

    for (const tick of [lower, upper]) {
      const pda = tickArrayPda(c.pool, tick, ps.tickSpacing);
      if (!(await this.conn.getAccountInfo(pda))) {
        this.log(`initializing tick array for tick ${tick} (agent pays rent)`);
        await this.send("initialize_tick_array", [initTickArrayIx(c, tick)]);
      }
    }

    const mint = Keypair.generate();
    await this.send("open_position", [openIx(c, mint.publicKey, lower, upper)], [mint]);
    const pos = await findPosition(this.conn, vv.vault, c.pool);
    if (!pos) throw new Error("opened a position but could not find it");

    const oracleExtra = oracle.configured && oracle.feedA && oracle.feedB
      ? [m(pythFeedAccount(oracle.feedA)), m(pythFeedAccount(oracle.feedB)), m(ps.mintA), m(ps.mintB)]
      : [];
    await this.send("increase_liquidity", [increaseIx(c, pos, BigInt(L), maxA, maxB, oracleExtra)]);
    return true;
  }
}

export const vaultAtaOf = (vault: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, vault, true);
