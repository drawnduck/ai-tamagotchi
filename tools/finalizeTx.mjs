/**
 * Push a GenLayer transaction to FINALIZED and watch the contract balance.
 *
 *   node tools/finalizeTx.mjs <genlayerTxHash> <contractAddress>
 *
 * Why this exists: `withdraw()` reaches ACCEPTED with FINISHED_WITH_RETURN but the
 * money does not move. `emit_transfer` produces a message that consensus dispatches,
 * and Bradbury's consensus main contract exposes an explicit, permissionless
 * `finalizeTransaction(bytes32)` — so ACCEPTED is genuinely not the end of the story.
 *
 * Observed 2026-08-03: called minutes after ACCEPTED it reverts with no reason, which
 * reads as "the finality window has not elapsed". Retry later rather than concluding
 * anything from one revert.
 */
import { readFileSync } from "fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeFunctionData } from "viem";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { statusName } from "../lib/waitForSettled.mjs";

installGasBuffer();

const pk = readFileSync(".env", "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
const account = createAccount(pk);
const client = createClient({ chain: testnetBradbury, account });

const [txHash, address] = process.argv.slice(2);
const consensus = testnetBradbury.consensusMainContract.address;

const before = await client.getBalance({ address });
const tx = await client.getTransaction({ hash: txHash });
console.log(`tx ${txHash}`);
console.log(`  status ${statusName(tx.status)}   contract holds ${before} wei`);

console.log(`  messages: ${JSON.stringify(tx.messages ?? [], (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

const abi = (name) => [
  {
    type: "function",
    name,
    inputs: [{ type: "bytes32", name: "txId" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

async function call(name) {
  console.log(`  ${name}() on ${consensus}…`);
  try {
    const evmHash = await client.sendTransaction({
      account,
      to: consensus,
      data: encodeFunctionData({ abi: abi(name), functionName: name, args: [txHash] }),
      chain: testnetBradbury,
    });
    console.log(`    evm tx ${evmHash} — sent`);
    return true;
  } catch (err) {
    console.log(`    ❌ ${err.shortMessage ?? err.message?.slice(0, 200)}`);
    return false;
  }
}

// Two distinct steps. finalizeTransaction() ends consensus; the messages the
// contract emitted (a withdraw's transfer among them) are only *issued* by
// flushExternalMessages(), which is why FINALIZED alone moves no money.
if (String(tx.status) !== "7") await call("finalizeTransaction");
await call("flushExternalMessages");

const after = await client.getTransaction({ hash: txHash });
console.log(`\nnow: ${statusName(after.status)}   contract holds ${await client.getBalance({ address })} wei`);
console.log(`owner holds ${await client.getBalance({ address: account.address })} wei`);
