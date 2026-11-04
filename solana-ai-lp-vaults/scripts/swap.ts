/**
 * Devnet price mover: swaps against your test pool to push its price out of the
 * agent's range, so you can watch the agent rebalance.
 *   POOL=<pool> npm run swap                 # price up   (swaps token B in)
 *   POOL=<pool> DIRECTION=down npm run swap  # price down (swaps token A in)
 * Optional: AMOUNT=40 (human tokens), TARGET_TICK=1000, RPC_URL=...
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
if (!process.env.POOL) throw new Error("Set POOL=<whirlpool address>");
const POOL = new PublicKey(process.env.POOL);
const UP = (process.env.DIRECTION ?? "up") !== "down";
const AMOUNT = Number(process.env.AMOUNT ?? "40");
const TARGET_TICK = Number(process.env.TARGET_TICK ?? (UP ? "1000" : "-1000"));
const DECIMALS = 6;

const conn = new Connection(RPC, "confirmed");
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(process.env.OWNER_KEYPAIR ?? path.join(homedir(), ".config/solana/id.json"), "utf8"))));

const disc = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const m = (pubkey: PublicKey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};
const send = async (label: string, ixs: TransactionInstruction[]) => {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [owner]);
  console.log(`OK  ${label}\n    ${sig}`);
  await new Promise((r) => setTimeout(r, 1500));
};

async function readPool() {
  const info = await conn.getAccountInfo(POOL);
  if (!info || !info.owner.equals(ORCA) || info.data.length < 245) throw new Error("POOL is not a valid Orca whirlpool");
  const d = info.data;
  return {
    spacing: d.readUInt16LE(41),
    tick: d.readInt32LE(81),
    mintA: new PublicKey(d.subarray(101, 133)),
    vaultA: new PublicKey(d.subarray(133, 165)),
    mintB: new PublicKey(d.subarray(181, 213)),
    vaultB: new PublicKey(d.subarray(213, 245)),
  };
}

async function main() {
  const p = await readPool();
  console.log(`pool tick before: ${p.tick}  (swapping ${UP ? "B in, price up" : "A in, price down"}, up to tick ${TARGET_TICK})`);

  const span = 88 * p.spacing;
  const start0 = Math.floor(p.tick / span) * span + 0;
  const starts = UP ? [start0, start0 + span, start0 + 2 * span] : [start0, start0 - span, start0 - 2 * span];
  const arrays = starts.map((s) =>
    PublicKey.findProgramAddressSync([Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from(String(s))], ORCA)[0]);

  // Swaps need three initialized tick arrays in the direction of travel.
  for (let i = 0; i < 3; i++) {
    if (!(await conn.getAccountInfo(arrays[i]))) {
      await send(`init tick array (start ${starts[i]})`, [new TransactionInstruction({
        programId: ORCA,
        keys: [m(POOL), m(owner.publicKey, true, true), m(arrays[i], true), m(SystemProgram.programId)],
        data: Buffer.concat([disc("initialize_tick_array"), i32(starts[i])]),
      })]);
    }
  }

  const ataA = getAssociatedTokenAddressSync(p.mintA, owner.publicKey);
  const ataB = getAssociatedTokenAddressSync(p.mintB, owner.publicKey);
  for (const a of [ataA, ataB]) {
    if (!(await conn.getAccountInfo(a))) throw new Error("owner token account missing; use the same wallet that ran the setup");
  }
  const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), POOL.toBuffer()], ORCA)[0];
  const sqrtLimit = BigInt(Math.floor(Math.pow(1.0001, TARGET_TICK / 2) * 2 ** 64));

  await send("swap", [new TransactionInstruction({
    programId: ORCA,
    keys: [
      m(TOKEN_PROGRAM_ID), m(owner.publicKey, false, true), m(POOL, true),
      m(ataA, true), m(p.vaultA, true), m(ataB, true), m(p.vaultB, true),
      m(arrays[0], true), m(arrays[1], true), m(arrays[2], true), m(oracle),
    ],
    data: Buffer.concat([
      disc("swap"), u64(BigInt(Math.floor(AMOUNT * 10 ** DECIMALS))), u64(0n), u128(sqrtLimit),
      Buffer.from([1]), Buffer.from([UP ? 0 : 1]), // amount_specified_is_input = true, a_to_b
    ]),
  })]);

  const after = await readPool();
  console.log(`pool tick after: ${after.tick}`);
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
