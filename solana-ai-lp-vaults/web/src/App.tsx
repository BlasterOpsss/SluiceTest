import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import * as V from "./vault";

type Balances = { mint: string; amount: string }[];

export default function App() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [vault, setVault] = useState<V.VaultState | null>(null);
  const [balances, setBalances] = useState<Balances>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const [mintStr, setMintStr] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [agentStr, setAgentStr] = useState("");
  const [g, setG] = useState({
    maxPositionBps: 2500, maxSlippageBps: 50, dailyActionCap: 10, stopLossBps: 1500, paused: false,
  });

  const refresh = useCallback(async () => {
    if (!publicKey || !V.PROGRAM_CONFIGURED) return;
    const v = await V.fetchVault(connection, publicKey);
    setVault(v);
    if (v) {
      const { actionsToday: _a, ...rest } = v.guardrails;
      setG(rest);
      setBalances(await V.fetchBalances(connection, v.address));
    } else {
      setBalances([]);
    }
  }, [connection, publicKey]);

  useEffect(() => { refresh().catch((e) => setStatus(String(e))); }, [refresh]);

  async function run(label: string, build: () => Promise<TransactionInstruction>) {
    if (!publicKey) return;
    setBusy(true);
    setStatus(`${label}...`);
    try {
      const tx = new Transaction().add(await build());
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus(`${label} done: ${sig}`);
      await refresh();
    } catch (e) {
      setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toBaseUnits(): Promise<{ mint: PublicKey; amount: bigint }> {
    const mint = new PublicKey(mintStr.trim());
    const { decimals } = await getMint(connection, mint);
    const [whole, frac = ""] = amountStr.trim().split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return { mint, amount: BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0") };
  }

  const num = (k: keyof typeof g) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setG({ ...g, [k]: Number(e.target.value) });

  return (
    <main>
      <header>
        <h1>AI LP Vaults</h1>
        <WalletMultiButton />
      </header>
      <p className="warn">Pre-alpha, unaudited. Test with small amounts you can afford to lose.</p>

      {!V.PROGRAM_CONFIGURED && (
        <p className="err">Set VITE_PROGRAM_ID in web/.env (see .env.example), then restart.</p>
      )}
      {!publicKey && <p>Connect a wallet to begin.</p>}

      {publicKey && V.PROGRAM_CONFIGURED && !vault && (
        <section>
          <h2>Create your vault</h2>
          <button disabled={busy} onClick={() => run("Create vault", () => V.ixInitialize(publicKey))}>
            Create vault
          </button>
        </section>
      )}

      {publicKey && vault && (
        <>
          <section>
            <h2>Vault</h2>
            <p className="mono">Address: {vault.address.toBase58()}</p>
            <p>Agent: <span className="mono">{vault.agent ? vault.agent.toBase58() : "none"}</span></p>
            <p>Agent actions today: {vault.guardrails.actionsToday}</p>
            <h3>Balances</h3>
            {balances.length === 0 && <p>Empty.</p>}
            {balances.map((b) => (
              <p key={b.mint} className="mono">{b.mint}: {b.amount}</p>
            ))}
          </section>

          <section>
            <h2>Deposit / Withdraw</h2>
            <input placeholder="Token mint address" value={mintStr} onChange={(e) => setMintStr(e.target.value)} />
            <input placeholder="Amount (e.g. 0.5)" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
            <div className="row">
              <button disabled={busy} onClick={() => run("Deposit", async () => {
                const { mint, amount } = await toBaseUnits();
                return V.ixDeposit(publicKey, mint, amount);
              })}>Deposit</button>
              <button disabled={busy} onClick={() => run("Withdraw", async () => {
                const { mint, amount } = await toBaseUnits();
                return V.ixWithdraw(publicKey, mint, amount);
              })}>Withdraw</button>
            </div>
          </section>

          <section>
            <h2>Agent</h2>
            <input placeholder="Agent public key" value={agentStr} onChange={(e) => setAgentStr(e.target.value)} />
            <div className="row">
              <button disabled={busy} onClick={() => run("Set agent", () =>
                V.ixSetAgent(publicKey, new PublicKey(agentStr.trim())))}>Set agent</button>
              <button className="danger" disabled={busy}
                onClick={() => run("Revoke agent", () => V.ixRevokeAgent(publicKey))}>Revoke agent</button>
            </div>
          </section>

          <section>
            <h2>Guardrails</h2>
            <label>Max position (bps) <input type="number" value={g.maxPositionBps} onChange={num("maxPositionBps")} /></label>
            <label>Max slippage (bps, max 500) <input type="number" value={g.maxSlippageBps} onChange={num("maxSlippageBps")} /></label>
            <label>Daily action cap <input type="number" value={g.dailyActionCap} onChange={num("dailyActionCap")} /></label>
            <label>Stop-loss (bps) <input type="number" value={g.stopLossBps} onChange={num("stopLossBps")} /></label>
            <label className="check">
              <input type="checkbox" checked={g.paused} onChange={(e) => setG({ ...g, paused: e.target.checked })} />
              Paused (blocks all agent actions)
            </label>
            <button disabled={busy} onClick={() => run("Save guardrails", () => V.ixSetGuardrails(publicKey, g))}>
              Save guardrails
            </button>
          </section>
        </>
      )}

      {status && <p className="status mono">{status}</p>}
    </main>
  );
}
