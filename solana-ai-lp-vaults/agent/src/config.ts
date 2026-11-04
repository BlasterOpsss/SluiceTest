import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { StrategyParams } from "./strategy.js";

const env = (k: string, d?: string) => process.env[k] ?? d;
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k} (see agent/README.md)`);
  return v;
};
export const loadKey = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

export interface Config {
  rpcUrl: string;
  programId: PublicKey;
  owner: PublicKey; // the vault owner's public key
  pool: PublicKey; // Orca whirlpool to manage
  agent: Keypair;
  live: boolean; // false = dry run (log only)
  pollSecs: number;
  strategy: StrategyParams;
  allowUnverified: boolean;
  statePath: string;
  registryPath: string;
}

export function loadConfig(): Config {
  const programId = new PublicKey(
    env("PROGRAM_ID") ?? loadKey(path.resolve("../target/deploy/vault-keypair.json")).publicKey.toBase58(),
  );
  return {
    rpcUrl: env("RPC_URL", "https://api.devnet.solana.com")!,
    programId,
    owner: new PublicKey(need("OWNER")),
    pool: new PublicKey(need("POOL")),
    agent: loadKey(env("AGENT_KEYPAIR", path.resolve("../scripts/agent-keypair.json"))!),
    live: env("LIVE") === "1",
    pollSecs: Number(env("POLL_SECS", "60")),
    strategy: {
      rangeSpacings: Number(env("RANGE_SPACINGS", "10")),
      edgeFraction: Number(env("EDGE_FRACTION", "0.15")),
      minMoveSecs: Number(env("MIN_MOVE_SECS", "3600")),
    },
    allowUnverified: env("ALLOW_UNVERIFIED_TOKENS") === "1",
    statePath: path.resolve("agent-state.json"),
    registryPath: path.resolve("../registry/verified-tokens.json"),
  };
}
