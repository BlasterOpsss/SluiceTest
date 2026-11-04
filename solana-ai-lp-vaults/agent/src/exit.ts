// OWNER EMERGENCY EXIT. Signed by the vault OWNER, so it works even if the agent key is
// revoked, lost or compromised. Unwinds the vault's position in POOL (remove liquidity,
// collect fees, close). Everything lands in the vault's own token accounts.
//   POOL=<pool> npm run exit                    # unwind the position
//   POOL=<pool> WITHDRAW=1 npm run exit         # ...then withdraw all vault tokens to your wallet
//   POOL=<pool> REVOKE=1 WITHDRAW=1 npm run exit  # ...and revoke the agent first
import { Connection, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { loadKey } from "./config.js";
import { findPosition, readOracle, readPool, readVault, tokenBalance } from "./chain.js";
import { Executor } from "./executor.js";
import { m, type Ctx } from "./ix.js";

const disc = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const say = (msg: string) => console.log(msg);

async function main() {
  if (!process.env.POOL) throw new Error("Set POOL=<whirlpool address>");
  const pool = new PublicKey(process.env.POOL);
  const owner = loadKey(process.env.OWNER_KEYPAIR ?? path.join(homedir(), ".config/solana/id.json"));
  const programId = new PublicKey(
    process.env.PROGRAM_ID ?? loadKey(path.resolve("../target/deploy/vault-keypair.json")).publicKey.toBase58());
  const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

  const ps = await readPool(conn, pool);
  const vv = await readVault(conn, programId, owner.publicKey);
  const oracle = await readOracle(conn, programId, vv.vault, pool);
  say(`owner ${owner.publicKey.toBase58()}  vault ${vv.vault.toBase58()}`);

  const send = async (label: string, ix: TransactionInstruction) => {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [owner]);
    say(`OK  ${label}\n    ${sig}`);
    await new Promise((r) => setTimeout(r, 1500));
  };

  if (process.env.REVOKE === "1") {
    await send("revoke_agent", new TransactionInstruction({
      programId, data: Buffer.from(disc("revoke_agent")),
      keys: [m(owner.publicKey, false, true), m(vv.vault, true)],
    }));
  }

  // The owner signs in the "agent" slot; the program accepts the vault owner for exits.
  const ctx: Ctx = { programId, agent: owner.publicKey, pool, ps, vv, oraclePda: oracle.pda };
  const pos = await findPosition(conn, vv.vault, pool);
  if (!pos) {
    say("no position found in this pool; nothing to unwind");
  } else {
    say(`unwinding position ${pos.tickLower}..${pos.tickUpper}, liquidity ${pos.liquidity}`);
    await new Executor(conn, owner, say).unwind(ctx, pos);
  }

  if (process.env.WITHDRAW === "1") {
    for (const mint of [ps.mintA, ps.mintB]) {
      const amount = await tokenBalance(conn, vv.vault, mint);
      if (amount === 0n) { say(`vault holds none of ${mint.toBase58()}`); continue; }
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(amount);
      await send(`withdraw ${amount} of ${mint.toBase58()}`, new TransactionInstruction({
        programId, data: Buffer.concat([disc("withdraw"), data]),
        keys: [
          m(owner.publicKey, false, true), m(vv.vault), m(mint),
          m(getAssociatedTokenAddressSync(mint, vv.vault, true), true),
          m(getAssociatedTokenAddressSync(mint, owner.publicKey), true), m(TOKEN_PROGRAM_ID),
        ],
      }));
    }
  }
  say(`vault now holds: A=${await tokenBalance(conn, vv.vault, ps.mintA)} B=${await tokenBalance(conn, vv.vault, ps.mintB)}`);
  void ASSOCIATED_TOKEN_PROGRAM_ID;
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
