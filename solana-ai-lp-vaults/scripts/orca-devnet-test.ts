/**
 * Devnet end-to-end test: vault + agent + Orca Whirlpool.
 * Self-contained and SDK-free: builds Orca instructions by hand, so there are
 * no package version conflicts. Creates its own tokens and pool.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const ORCA_CONFIG = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR");
const TICK_SPACING = 64;
const LOWER = -640;
const UPPER = 640;
const DECIMALS = 6;
const ONE = 10 ** DECIMALS;

const conn = new Connection(RPC, "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const owner = load(process.env.OWNER_KEYPAIR ?? path.join(homedir(), ".config/solana/id.json"));
const PROGRAM_ID = load(path.resolve(process.cwd(), "../target/deploy/vault-keypair.json")).publicKey;

const agentPath = path.resolve(process.cwd(), "agent-keypair.json");
if (!existsSync(agentPath)) writeFileSync(agentPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const agent = load(agentPath);

const disc = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const m = (pubkey: PublicKey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
const mkIx = (programId: PublicKey, name: string, keys: ReturnType<typeof m>[], data: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([disc(name), data]) });
const ix = (name: string, keys: ReturnType<typeof m>[], data?: Buffer) => mkIx(PROGRAM_ID, name, keys, data);
const orcaIx = (name: string, keys: ReturnType<typeof m>[], data?: Buffer) => mkIx(ORCA, name, keys, data);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers);
  console.log(`OK  ${label}\n    ${sig}`);
  await new Promise((r) => setTimeout(r, 2000));
}

// Orca PDAs
const orcaPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, ORCA);
const arraySpan = 88 * TICK_SPACING;
const startIndex = (tick: number) => Math.floor(tick / arraySpan) * arraySpan;
const tickArrayPda = (pool: PublicKey, tick: number) =>
  orcaPda([Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(String(startIndex(tick)))])[0];

// Vault PDAs
const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], PROGRAM_ID)[0];
const guardrails = PublicKey.findProgramAddressSync([Buffer.from("guardrails"), vault.toBuffer()], PROGRAM_ID)[0];
const poolsPda = PublicKey.findProgramAddressSync([Buffer.from("pools"), vault.toBuffer()], PROGRAM_ID)[0];
const vaultAta = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, vault, true);

async function bal(label: string, mints: PublicKey[]) {
  const out: string[] = [];
  for (const mint of mints) {
    try { out.push(((await getAccount(conn, vaultAta(mint))).amount / BigInt(ONE)).toString()); }
    catch { out.push("0"); }
  }
  console.log(`    vault balances ${label}: A=${out[0]} B=${out[1]}`);
}

async function main() {
  console.log("program :", PROGRAM_ID.toBase58());
  console.log("owner   :", owner.publicKey.toBase58());
  console.log("agent   :", agent.publicKey.toBase58());
  console.log("vault   :", vault.toBase58());
  const sol = (await conn.getBalance(owner.publicKey)) / LAMPORTS_PER_SOL;
  console.log("owner SOL:", sol);
  if (sol < 0.5) throw new Error("Owner needs at least ~0.5 devnet SOL (tick arrays cost rent).");

  if ((await conn.getBalance(agent.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
    await send("fund agent 0.1 SOL",
      [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })],
      [owner]);
  }

  if (!(await conn.getAccountInfo(vault))) {
    await send("initialize_vault",
      [ix("initialize_vault", [m(owner.publicKey, true, true), m(vault, true), m(guardrails, true), m(SystemProgram.programId)])],
      [owner]);
  }
  await send("set_agent",
    [ix("set_agent", [m(owner.publicKey, false, true), m(vault, true)], agent.publicKey.toBuffer())], [owner]);

  // two fresh tokens, ordered (Orca needs mintA < mintB)
  const t1 = await createMint(conn, owner, owner.publicKey, null, DECIMALS);
  const t2 = await createMint(conn, owner, owner.publicKey, null, DECIMALS);
  const [mintA, mintB] = Buffer.compare(t1.toBuffer(), t2.toBuffer()) < 0 ? [t1, t2] : [t2, t1];
  console.log("mintA:", mintA.toBase58(), "\nmintB:", mintB.toBase58());
  for (const mint of [mintA, mintB]) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, owner, mint, owner.publicKey);
    await mintTo(conn, owner, mint, ata.address, owner, 1_000 * ONE);
  }

  // create pool at price 1.0 (sqrt price = 2^64)
  const [poolKey, poolBump] = orcaPda([
    Buffer.from("whirlpool"), ORCA_CONFIG.toBuffer(), mintA.toBuffer(), mintB.toBuffer(), u16(TICK_SPACING),
  ]);
  const feeTier = orcaPda([Buffer.from("fee_tier"), ORCA_CONFIG.toBuffer(), u16(TICK_SPACING)])[0];
  const vaultAKp = Keypair.generate();
  const vaultBKp = Keypair.generate();
  await send("create pool",
    [orcaIx("initialize_pool", [
      m(ORCA_CONFIG), m(mintA), m(mintB), m(owner.publicKey, true, true), m(poolKey, true),
      m(vaultAKp.publicKey, true, true), m(vaultBKp.publicKey, true, true), m(feeTier),
      m(TOKEN_PROGRAM_ID), m(SystemProgram.programId), m(SYSVAR_RENT_PUBKEY),
    ], Buffer.concat([Buffer.from([poolBump]), u16(TICK_SPACING), u128(1n << 64n)]))],
    [owner, vaultAKp, vaultBKp]);
  console.log("pool:", poolKey.toBase58());

  for (const tick of [LOWER, UPPER]) {
    await send(`init tick array (start ${startIndex(tick)})`,
      [orcaIx("initialize_tick_array", [
        m(poolKey), m(owner.publicKey, true, true), m(tickArrayPda(poolKey, tick), true), m(SystemProgram.programId),
      ], i32(startIndex(tick)))],
      [owner]);
  }

  // owner allows the pool and deposits 100 of each token
  const poolsData = Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32LE(1); return b; })(), poolKey.toBuffer()]);
  await send("set_allowed_pools",
    [ix("set_allowed_pools", [m(owner.publicKey, true, true), m(vault), m(poolsPda, true), m(SystemProgram.programId)], poolsData)],
    [owner]);
  for (const mint of [mintA, mintB]) {
    await send("deposit 100",
      [ix("deposit", [
        m(owner.publicKey, true, true), m(vault), m(mint),
        m(getAssociatedTokenAddressSync(mint, owner.publicKey), true), m(vaultAta(mint), true),
        m(TOKEN_PROGRAM_ID), m(ASSOCIATED_TOKEN_PROGRAM_ID), m(SystemProgram.programId),
      ], u64(BigInt(100 * ONE)))],
      [owner]);
  }
  await bal("after deposit", [mintA, mintB]);

  // SETUP_ONLY=1: stop here and hand the pool to the agent loop (agent/).
  if (process.env.SETUP_ONLY) {
    console.log("\nSETUP DONE. Now run the agent from agent/ with:");
    console.log(`POOL=${poolKey.toBase58()} OWNER=${owner.publicKey.toBase58()} ALLOW_UNVERIFIED_TOKENS=1 npm run once`);
    return;
  }

  // AGENT opens a position owned by the vault
  const positionMint = Keypair.generate();
  const position = orcaPda([Buffer.from("position"), positionMint.publicKey.toBuffer()])[0];
  const positionAta = getAssociatedTokenAddressSync(positionMint.publicKey, vault, true);
  await send("agent: orca_open_position",
    [ix("orca_open_position", [
      m(agent.publicKey, true, true), m(vault), m(guardrails, true), m(poolsPda), m(poolKey),
      m(position, true), m(positionMint.publicKey, true, true), m(positionAta, true),
      m(TOKEN_PROGRAM_ID), m(SystemProgram.programId), m(SYSVAR_RENT_PUBKEY), m(ASSOCIATED_TOKEN_PROGRAM_ID),
      m(ORCA),
    ], Buffer.concat([i32(LOWER), i32(UPPER)]))],
    [agent, positionMint]);

  const tickLowerPk = tickArrayPda(poolKey, LOWER);
  const tickUpperPk = tickArrayPda(poolKey, UPPER);
  const liqKeys = () => [
    m(agent.publicKey, true, true), m(vault), m(guardrails, true), m(poolsPda),
    m(poolKey, true), m(position, true), m(positionAta),
    m(vaultAta(mintA), true), m(vaultAta(mintB), true),
    m(vaultAKp.publicKey, true), m(vaultBKp.publicKey, true),
    m(tickLowerPk, true), m(tickUpperPk, true),
    m(TOKEN_PROGRAM_ID), m(ORCA),
  ];

  // ---- Pyth oracle check (owner ties the pool to two Pyth USD feeds) ----
  const PYTH_PUSH = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
  const FEED_SOL = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");
  const FEED_BTC = Buffer.from("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", "hex");
  const feedAcc = (f: Buffer) => PublicKey.findProgramAddressSync([Buffer.from([0, 0]), f], PYTH_PUSH)[0];
  const oraclePda = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), vault.toBuffer(), poolKey.toBuffer()], PROGRAM_ID)[0];
  const setOracle = (fa: Buffer, fb: Buffer, maxAge: number) => {
    const age = Buffer.alloc(4); age.writeUInt32LE(maxAge);
    return ix("set_pool_oracle",
      [m(owner.publicKey, true, true), m(vault), m(oraclePda, true), m(SystemProgram.programId)],
      Buffer.concat([poolKey.toBuffer(), fa, fb, u16(100), age]));
  };
  let oracleExtra: ReturnType<typeof m>[] = [];
  const incKeys = () => [...liqKeys(), m(oraclePda), ...oracleExtra];

  const pubTime = (d: Buffer) => Number(d.readBigInt64LE(41 + 52));
  const solInfo = await conn.getAccountInfo(feedAcc(FEED_SOL));
  const btcInfo = await conn.getAccountInfo(feedAcc(FEED_BTC));
  if (solInfo && btcInfo && solInfo.data[40] === 1 && btcInfo.data[40] === 1) {
    const now = Math.floor(Date.now() / 1000);
    const age = Math.max(now - pubTime(solInfo.data), now - pubTime(btcInfo.data)) + 600;
    console.log("    devnet Pyth feed age (s):", age - 600);
    if (age > 86_400) {
      console.log("    devnet Pyth feeds older than 24h: skipping oracle test");
    } else {
      await send("owner: set_pool_oracle (SOL vs BTC, mismatched on purpose)",
        [setOracle(FEED_SOL, FEED_BTC, age)], [owner]);
      oracleExtra = [m(feedAcc(FEED_SOL)), m(feedAcc(FEED_BTC)), m(mintA), m(mintB)];
      try {
        await send("agent: increase with mismatched oracle (should FAIL)",
          [ix("orca_increase_liquidity", incKeys(), Buffer.concat([u128(1000n), u64(BigInt(ONE)), u64(BigInt(ONE))]))],
          [agent]);
        console.log("!!  oracle check did NOT reject a mismatched price");
      } catch {
        console.log("OK  mismatched oracle price rejected (expected)");
      }
      await send("owner: set_pool_oracle (SOL vs SOL = ratio 1.0, matches pool)",
        [setOracle(FEED_SOL, FEED_SOL, age)], [owner]);
      oracleExtra = [m(feedAcc(FEED_SOL)), m(feedAcc(FEED_SOL)), m(mintA), m(mintB)];
    }
  } else {
    console.log("    devnet Pyth feed accounts not found: skipping oracle test");
  }

  // guardrail test: 30 tokens > 25% of 100 -> must be rejected on-chain
  try {
    await send("agent: oversized increase (should FAIL)",
      [ix("orca_increase_liquidity", incKeys(), Buffer.concat([u128(1n), u64(BigInt(30 * ONE)), u64(BigInt(30 * ONE))]))],
      [agent]);
    console.log("!!  guardrail did NOT reject the oversized deposit");
  } catch {
    console.log("OK  oversized deposit rejected by guardrail (expected)");
  }

  // add liquidity: ~10 tokens of A with matching B (plain math)
  const sq = (t: number) => Math.pow(1.0001, t / 2);
  const A = 10 * ONE;
  const liquidity = BigInt(Math.floor((0.98 * A) / (1 / sq(0) - 1 / sq(UPPER))));
  const max = BigInt(11 * ONE);
  await send("agent: orca_increase_liquidity",
    [ix("orca_increase_liquidity", incKeys(), Buffer.concat([u128(liquidity), u64(max), u64(max)]))], [agent]);
  await bal("after adding liquidity", [mintA, mintB]);

  // remove all liquidity
  const posInfo = await conn.getAccountInfo(position);
  const posLiq = posInfo!.data.readBigUInt64LE(72) + (posInfo!.data.readBigUInt64LE(80) << 64n);
  console.log("    position liquidity:", posLiq.toString());
  await send("agent: orca_decrease_liquidity",
    [ix("orca_decrease_liquidity", liqKeys(), Buffer.concat([u128(posLiq), u64(0n), u64(0n)]))], [agent]);
  await bal("after removing liquidity", [mintA, mintB]);

  // close the empty position
  await send("agent: orca_close_position",
    [ix("orca_close_position", [
      m(agent.publicKey, true, true), m(vault), m(position, true), m(positionMint.publicKey, true),
      m(positionAta, true), m(TOKEN_PROGRAM_ID), m(ORCA),
    ])], [agent]);

  // owner withdraws everything back
  for (const mint of [mintA, mintB]) {
    const amount = (await getAccount(conn, vaultAta(mint))).amount;
    await send("owner: withdraw",
      [ix("withdraw", [
        m(owner.publicKey, false, true), m(vault), m(mint), m(vaultAta(mint), true),
        m(getAssociatedTokenAddressSync(mint, owner.publicKey), true), m(TOKEN_PROGRAM_ID),
      ], u64(amount))],
      [owner]);
  }
  await bal("after withdraw", [mintA, mintB]);
  console.log("\nALL STEPS PASSED");
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
