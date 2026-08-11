/**
 * Prove that a player can create and feed a pet with a WALLET — no private key
 * typed into the page — before the frontend is rewritten around that claim.
 *
 *   node tools/proveWalletFlow.mjs
 *
 * WHY THIS EXISTS. The frontend used to ask for a private key in a text field.
 * That was never necessary: genlayer-js takes `account` as a plain ADDRESS and
 * an optional EIP-1193 `provider`, and then routes exactly the signing methods
 *
 *     eth_accounts, eth_requestAccounts, eth_sendTransaction,
 *     eth_signTransaction, personal_sign, eth_signTypedData_v4
 *
 * to that provider while every read still goes to the RPC. In a browser the
 * provider is `window.ethereum`; the switch is `typeof config.account !== "object"`,
 * so an address STRING turns wallet mode on and an account OBJECT turns it off.
 *
 * WHAT IS BEING PROVEN, AND WHAT ISN'T. This script stands a fake wallet in
 * front of the real testnet: a provider that answers `eth_requestAccounts` and
 * `eth_chainId`, and signs `eth_sendTransaction` locally before forwarding it as
 * a raw transaction. That is what MetaMask does, minus the popup. So it proves
 * the parts a popup cannot change — that genlayer-js really hands the wallet a
 * transaction, that a contract DEPLOY takes that path too, and that a payable
 * call arrives with its value — on Bradbury, with real gas.
 *
 * It does not prove MetaMask's own UI. Nothing run from a terminal can.
 *
 * The key stays in .env and is never printed; it exists here only to play the
 * part of the wallet's signer.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { privateKeyToAccount } from "viem/accounts";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { waitForSettled, statusName, succeeded, outcome } from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.resolve(HERE, "../.env");
const RPC = testnetBradbury.rpcUrls.default.http[0];
const FEED_WEI = 10_000_000_000_000_000n; // 0.01 GEN

const pk = readFileSync(ENV, "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
if (!pk) {
  console.error(`No PRIVATE_KEY=0x… line in ${ENV}. Use a throwaway testnet key.`);
  process.exit(1);
}

installGasBuffer();

/** Plain JSON-RPC, for the one call the wallet has to make itself. */
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * A stand-in for `window.ethereum`.
 *
 * MetaMask would show a dialog here and sign with the user's key; this signs
 * with the throwaway key and forwards. Everything genlayer-js can observe —
 * the method names, the shape of the transaction, the returned hash — is the
 * same, which is the whole point of standing it in.
 */
const signer = privateKeyToAccount(pk);
let approvals = 0;

const wallet = {
  async request({ method, params = [] }) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [signer.address];

      case "eth_chainId":
        return `0x${testnetBradbury.id.toString(16)}`;

      case "eth_sendTransaction": {
        const tx = params[0];
        approvals += 1;
        console.log(
          `    🦊 wallet asked to approve #${approvals}: ` +
            `${BigInt(tx.gas ?? 0n)} gas, value ${Number(BigInt(tx.value ?? 0n)) / 1e18} GEN`,
        );
        const serialized = await signer.signTransaction({
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value ?? 0),
          gas: BigInt(tx.gas),
          gasPrice: BigInt(tx.gasPrice ?? (await rpc("eth_gasPrice", []))),
          nonce: Number(BigInt(tx.nonce)),
          chainId: testnetBradbury.id,
          type: "legacy",
        });
        return rpc("eth_sendRawTransaction", [serialized]);
      }

      case "personal_sign":
        return signer.signMessage({ message: { raw: params[0] } });

      default:
        throw new Error(`the stand-in wallet was asked for ${method}, which it does not implement`);
    }
  },
};

// The two lines that make this wallet mode: an ADDRESS, not an account object,
// and a provider to send it to. This is exactly what the page will do, with
// `window.ethereum` in place of `wallet`.
const [address] = await wallet.request({ method: "eth_requestAccounts" });
const client = createClient({ chain: testnetBradbury, account: address, provider: wallet });

const gen = (wei) => `${(Number(wei) / 1e18).toFixed(4)} GEN`;
console.log(`connected as ${address} — ${gen(await client.getBalance({ address }))}`);
console.log(`account type: ${client.account?.type} (must be json-rpc, not local)`);
if (client.account?.type === "local") {
  console.error("genlayer-js built a local account — the wallet would never be asked to sign.");
  process.exit(1);
}

const artifact = buildContract();
console.log(`\ncontract artifact ${artifact.builtBytes} bytes (source ${artifact.sourceBytes})`);

console.log("\ncreating a pet the way the page will…");
const deployHash = await client.deployContract({
  code: artifact.code,
  args: ["Wallet", "a pet made without ever typing a private key", "Lisbon"],
});
const deployed = await waitForSettled(client, deployHash, {
  onProgress: (s, ms) => process.stdout.write(`\r    deploy … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
  timeoutMs: 900_000,
});
if (!succeeded(deployed)) {
  console.error(`\ndeploy failed — ${outcome(deployed)}`);
  process.exit(1);
}
const pet = deployed.data?.contract_address ?? deployed.recipient;
console.log(`\r    deploy ✅ ${outcome(deployed)}${" ".repeat(20)}`);
console.log(`    pet at ${pet}`);

const state = await client.readContract({ address: pet, functionName: "get_state" });
console.log(`    it says: ${state.name}, satiety ${state.satiety}, mood ${state.mood}`);

console.log("\nfeeding it, with value…");
const feedHash = await client.writeContract({
  address: pet,
  functionName: "feed",
  args: [],
  value: FEED_WEI,
});
const fed = await waitForSettled(client, feedHash, {
  onProgress: (s, ms) => process.stdout.write(`\r    feed … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
  timeoutMs: 900_000,
});
if (!succeeded(fed)) {
  console.error(`\nfeed failed — ${outcome(fed)}`);
  process.exit(1);
}
console.log(`\r    feed ✅ ${outcome(fed)}${" ".repeat(24)}`);

// State is applied at acceptance but the node serves it a moment later; reading
// immediately reports the pre-call numbers and makes a working feed look inert.
await new Promise((r) => setTimeout(r, 5000));
const after = await client.readContract({ address: pet, functionName: "get_state" });
const held = await client.getBalance({ address: pet });
console.log(`    satiety ${state.satiety} → ${after.satiety}, the pet holds ${gen(held)}`);
console.log(`    "${after.last_quote}"`);

if (approvals < 2) {
  console.error(`\nonly ${approvals} wallet approval(s) — something signed without the wallet.`);
  process.exit(1);
}
console.log(`\nthe wallet signed all ${approvals} transactions. No key was ever given to the app.`);
console.log(`WALLET-FLOW-OK ${pet}`);
