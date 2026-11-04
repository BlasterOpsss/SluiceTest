// Read-only helpers: decode pool, vault, position and oracle accounts.
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PositionView } from "./strategy.js";

export const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const PYTH_PUSH = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

export interface PoolState {
  tickSpacing: number;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  mintA: PublicKey;
  vaultA: PublicKey;
  mintB: PublicKey;
  vaultB: PublicKey;
}

export async function readPool(conn: Connection, pool: PublicKey): Promise<PoolState> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(ORCA) || info.data.length < 245) throw new Error("pool is not a valid Orca whirlpool");
  const d = info.data;
  return {
    tickSpacing: d.readUInt16LE(41),
    sqrtPriceX64: d.readBigUInt64LE(65) + (d.readBigUInt64LE(73) << 64n),
    tickCurrent: d.readInt32LE(81),
    mintA: new PublicKey(d.subarray(101, 133)),
    vaultA: new PublicKey(d.subarray(133, 165)),
    mintB: new PublicKey(d.subarray(181, 213)),
    vaultB: new PublicKey(d.subarray(213, 245)),
  };
}

export interface VaultView {
  vault: PublicKey;
  guardrails: PublicKey;
  poolsPda: PublicKey;
  agent: PublicKey | null;
  maxPositionBps: number;
  maxSlippageBps: number;
  dailyCap: number;
  stopLossBps: number;
  paused: boolean;
  actionsToday: number;
  dayStart: number;
  allowedPools: PublicKey[];
}

export const vaultPda = (programId: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], programId)[0];

export async function readVault(conn: Connection, programId: PublicKey, owner: PublicKey): Promise<VaultView> {
  const vault = vaultPda(programId, owner);
  const guardrails = PublicKey.findProgramAddressSync([Buffer.from("guardrails"), vault.toBuffer()], programId)[0];
  const poolsPda = PublicKey.findProgramAddressSync([Buffer.from("pools"), vault.toBuffer()], programId)[0];
  const [v, g, p] = await conn.getMultipleAccountsInfo([vault, guardrails, poolsPda]);
  if (!v || !g) throw new Error("vault not found for this owner/program (check OWNER and PROGRAM_ID)");
  const agent = new PublicKey(v.data.subarray(40, 72));
  const allowedPools: PublicKey[] = [];
  if (p) {
    const n = p.data.readUInt32LE(40);
    for (let i = 0; i < n; i++) allowedPools.push(new PublicKey(p.data.subarray(44 + 32 * i, 76 + 32 * i)));
  }
  return {
    vault, guardrails, poolsPda,
    agent: agent.equals(PublicKey.default) ? null : agent,
    maxPositionBps: g.data.readUInt16LE(40),
    maxSlippageBps: g.data.readUInt16LE(42),
    dailyCap: g.data.readUInt8(44),
    stopLossBps: g.data.readUInt16LE(45),
    paused: g.data.readUInt8(47) === 1,
    actionsToday: g.data.readUInt8(48),
    dayStart: Number(g.data.readBigInt64LE(49)),
    allowedPools,
  };
}

export interface OnchainPosition extends PositionView {
  mintKey: PublicKey;
  pda: PublicKey;
  tokenAccount: PublicKey;
  feeOwedA: bigint;
  feeOwedB: bigint;
}

function decodePosition(mintKey: PublicKey, pda: PublicKey, tokenAccount: PublicKey, d: Buffer): OnchainPosition {
  return {
    mint: mintKey.toBase58(), mintKey, pda, tokenAccount,
    liquidity: d.readBigUInt64LE(72) + (d.readBigUInt64LE(80) << 64n),
    tickLower: d.readInt32LE(88),
    tickUpper: d.readInt32LE(92),
    feeOwedA: d.readBigUInt64LE(112),
    feeOwedB: d.readBigUInt64LE(136),
  };
}

/** Finds the vault's position NFT for this pool by scanning its token accounts (stateless recovery). */
export async function findPosition(conn: Connection, vault: PublicKey, pool: PublicKey): Promise<OnchainPosition | null> {
  const toks = await conn.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_PROGRAM_ID });
  const nfts = toks.value.filter((t) => {
    const a = t.account.data.parsed.info.tokenAmount;
    return a.decimals === 0 && a.amount === "1";
  });
  if (nfts.length === 0) return null;
  const mints = nfts.map((t) => new PublicKey(t.account.data.parsed.info.mint));
  const pdas = mints.map((m) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer()], ORCA)[0]);
  const infos = await conn.getMultipleAccountsInfo(pdas);
  const found: OnchainPosition[] = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (info && info.owner.equals(ORCA) && info.data.length >= 144 && new PublicKey(info.data.subarray(8, 40)).equals(pool)) {
      found.push(decodePosition(mints[i], pdas[i], nfts[i].pubkey, info.data));
    }
  }
  if (found.length > 1) console.warn(`warning: ${found.length} positions in this pool; managing the first`);
  return found[0] ?? null;
}

export async function readPositionAccount(conn: Connection, p: OnchainPosition): Promise<OnchainPosition> {
  const info = await conn.getAccountInfo(p.pda);
  if (!info) throw new Error("position account vanished");
  return decodePosition(p.mintKey, p.pda, p.tokenAccount, info.data);
}

export async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const r = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true));
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

export interface OracleCfg {
  pda: PublicKey;
  configured: boolean;
  feedA?: Buffer;
  feedB?: Buffer;
}

export async function readOracle(conn: Connection, programId: PublicKey, vault: PublicKey, pool: PublicKey): Promise<OracleCfg> {
  const pda = PublicKey.findProgramAddressSync([Buffer.from("oracle"), vault.toBuffer(), pool.toBuffer()], programId)[0];
  const info = await conn.getAccountInfo(pda);
  if (!info || !info.owner.equals(programId) || info.data.length < 136) return { pda, configured: false };
  return { pda, configured: true, feedA: Buffer.from(info.data.subarray(72, 104)), feedB: Buffer.from(info.data.subarray(104, 136)) };
}

export const pythFeedAccount = (feedId: Buffer) =>
  PublicKey.findProgramAddressSync([Buffer.from([0, 0]), feedId], PYTH_PUSH)[0];
