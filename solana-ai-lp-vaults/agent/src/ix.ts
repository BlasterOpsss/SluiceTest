// Instruction builders for the vault program (agent-signed) and Orca's tick-array init.
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { ORCA, type OnchainPosition, type PoolState, type VaultView } from "./chain.js";

type Meta = { pubkey: PublicKey; isWritable: boolean; isSigner: boolean };
export const m = (pubkey: PublicKey, w = false, s = false): Meta => ({ pubkey, isWritable: w, isSigner: s });
const disc = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};

export interface Ctx {
  programId: PublicKey;
  agent: PublicKey;
  pool: PublicKey;
  ps: PoolState;
  vv: VaultView;
  oraclePda: PublicKey;
}

const vaultAta = (c: Ctx, mint: PublicKey) => getAssociatedTokenAddressSync(mint, c.vv.vault, true);

export const ARRAY_TICKS = 88;
export const startIndex = (tick: number, spacing: number) => {
  const span = ARRAY_TICKS * spacing;
  return Math.floor(tick / span) * span + 0;
};
export const tickArrayPda = (pool: PublicKey, tick: number, spacing: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(String(startIndex(tick, spacing)))], ORCA)[0];

/** Orca's initialize_tick_array is permissionless; the agent pays rent (no vault funds involved). */
export function initTickArrayIx(c: Ctx, tick: number) {
  const start = startIndex(tick, c.ps.tickSpacing);
  return new TransactionInstruction({
    programId: ORCA,
    keys: [m(c.pool), m(c.agent, true, true), m(tickArrayPda(c.pool, tick, c.ps.tickSpacing), true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("initialize_tick_array"), i32(start)]),
  });
}

const ix = (c: Ctx, name: string, keys: Meta[], data = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: c.programId, keys, data: Buffer.concat([disc(name), data]) });

export function openIx(c: Ctx, positionMint: PublicKey, lower: number, upper: number) {
  const position = PublicKey.findProgramAddressSync([Buffer.from("position"), positionMint.toBuffer()], ORCA)[0];
  const ata = getAssociatedTokenAddressSync(positionMint, c.vv.vault, true);
  return ix(c, "orca_open_position", [
    m(c.agent, true, true), m(c.vv.vault), m(c.vv.guardrails, true), m(c.vv.poolsPda), m(c.pool),
    m(position, true), m(positionMint, true, true), m(ata, true),
    m(TOKEN_PROGRAM_ID), m(SystemProgram.programId), m(SYSVAR_RENT_PUBKEY), m(ASSOCIATED_TOKEN_PROGRAM_ID), m(ORCA),
  ], Buffer.concat([i32(lower), i32(upper)]));
}

function liqKeys(c: Ctx, p: OnchainPosition) {
  return [
    m(c.agent, true, true), m(c.vv.vault), m(c.vv.guardrails, true), m(c.vv.poolsPda),
    m(c.pool, true), m(p.pda, true), m(p.tokenAccount),
    m(vaultAta(c, c.ps.mintA), true), m(vaultAta(c, c.ps.mintB), true),
    m(c.ps.vaultA, true), m(c.ps.vaultB, true),
    m(tickArrayPda(c.pool, p.tickLower, c.ps.tickSpacing), true),
    m(tickArrayPda(c.pool, p.tickUpper, c.ps.tickSpacing), true),
    m(TOKEN_PROGRAM_ID), m(ORCA),
  ];
}

/** `oracleExtra` = [price_a, price_b, mint_a, mint_b] when the owner configured an oracle for this pool. */
export function increaseIx(c: Ctx, p: OnchainPosition, liquidity: bigint, maxA: bigint, maxB: bigint, oracleExtra: Meta[]) {
  return ix(c, "orca_increase_liquidity", [...liqKeys(c, p), m(c.oraclePda), ...oracleExtra],
    Buffer.concat([u128(liquidity), u64(maxA), u64(maxB)]));
}

export function decreaseIx(c: Ctx, p: OnchainPosition, liquidity: bigint, minA: bigint, minB: bigint) {
  return ix(c, "orca_decrease_liquidity", liqKeys(c, p), Buffer.concat([u128(liquidity), u64(minA), u64(minB)]));
}

export function collectIx(c: Ctx, p: OnchainPosition) {
  return ix(c, "orca_collect_fees", [
    m(c.agent, false, true), m(c.vv.vault), m(c.pool, true), m(p.pda, true), m(p.tokenAccount),
    m(vaultAta(c, c.ps.mintA), true), m(vaultAta(c, c.ps.mintB), true),
    m(c.ps.vaultA, true), m(c.ps.vaultB, true), m(TOKEN_PROGRAM_ID), m(ORCA),
  ]);
}

export function closeIx(c: Ctx, p: OnchainPosition) {
  return ix(c, "orca_close_position", [
    m(c.agent, true, true), m(c.vv.vault), m(p.pda, true), m(p.mintKey, true), m(p.tokenAccount, true),
    m(TOKEN_PROGRAM_ID), m(ORCA),
  ]);
}
