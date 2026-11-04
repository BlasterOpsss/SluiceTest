import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_PROGRAM_ID || "11111111111111111111111111111111",
);
export const PROGRAM_CONFIGURED = !!import.meta.env.VITE_PROGRAM_ID;

export interface Guardrails {
  maxPositionBps: number;
  maxSlippageBps: number;
  dailyActionCap: number;
  stopLossBps: number;
  paused: boolean;
  actionsToday: number;
}

export interface VaultState {
  address: PublicKey;
  guardrailsAddress: PublicKey;
  agent: PublicKey | null;
  guardrails: Guardrails;
}

async function disc(name: string): Promise<Buffer> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:" + name));
  return Buffer.from(h).subarray(0, 8) as Buffer;
}

export const vaultPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], PROGRAM_ID)[0];
export const guardrailsPda = (vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("guardrails"), vault.toBuffer()], PROGRAM_ID)[0];

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export async function fetchVault(conn: Connection, owner: PublicKey): Promise<VaultState | null> {
  const address = vaultPda(owner);
  const gAddr = guardrailsPda(address);
  const [v, g] = await conn.getMultipleAccountsInfo([address, gAddr]);
  if (!v || !g) return null;
  const agent = new PublicKey(v.data.subarray(40, 72));
  const d = Buffer.from(g.data);
  return {
    address,
    guardrailsAddress: gAddr,
    agent: agent.equals(PublicKey.default) ? null : agent,
    guardrails: {
      maxPositionBps: d.readUInt16LE(40),
      maxSlippageBps: d.readUInt16LE(42),
      dailyActionCap: d.readUInt8(44),
      stopLossBps: d.readUInt16LE(45),
      paused: d.readUInt8(47) === 1,
      actionsToday: d.readUInt8(48),
    },
  };
}

export async function fetchBalances(conn: Connection, vault: PublicKey) {
  const res = await conn.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_PROGRAM_ID });
  return res.value.map((a) => {
    const info = a.account.data.parsed.info;
    return { mint: info.mint as string, amount: info.tokenAmount.uiAmountString as string };
  });
}

export async function ixInitialize(owner: PublicKey): Promise<TransactionInstruction> {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: guardrailsPda(vault), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: await disc("initialize_vault"),
  });
}

export async function ixDeposit(owner: PublicKey, mint: PublicKey, amount: bigint) {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(mint, owner), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, vault, true), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([await disc("deposit"), u64(amount)]),
  });
}

export async function ixWithdraw(owner: PublicKey, mint: PublicKey, amount: bigint) {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(mint, vault, true), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, owner), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([await disc("withdraw"), u64(amount)]),
  });
}

export async function ixSetAgent(owner: PublicKey, agent: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vaultPda(owner), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([await disc("set_agent"), agent.toBuffer()]),
  });
}

export async function ixRevokeAgent(owner: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vaultPda(owner), isSigner: false, isWritable: true },
    ],
    data: await disc("revoke_agent"),
  });
}

export async function ixSetGuardrails(owner: PublicKey, g: Omit<Guardrails, "actionsToday">) {
  const vault = vaultPda(owner);
  const p = Buffer.alloc(8);
  p.writeUInt16LE(g.maxPositionBps, 0);
  p.writeUInt16LE(g.maxSlippageBps, 2);
  p.writeUInt8(g.dailyActionCap, 4);
  p.writeUInt16LE(g.stopLossBps, 5);
  p.writeUInt8(g.paused ? 1 : 0, 7);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: guardrailsPda(vault), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([await disc("set_guardrails"), p]),
  });
}
