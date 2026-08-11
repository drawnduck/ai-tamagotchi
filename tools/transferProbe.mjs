/**
 * Does gl.evm.contract_interface(...).emit_transfer() pay an EOA?
 * This is the candidate fix for AiPet.withdraw().
 *
 *   node tools/transferProbe.mjs
 */
import { readFileSync } from "fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { waitForSettled, statusName } from "../lib/waitForSettled.mjs";

installGasBuffer();

const pk = readFileSync(".env", "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
const account = createAccount(pk);
const client = createClient({ chain: testnetBradbury, account });

const FUND = 20_000_000_000_000_000n;
const PAY = 10_000_000_000_000_000n;

const tx0 = await waitForSettled(
  client,
  await client.deployContract({ code: new Uint8Array(readFileSync("tools/transferProbe.py")), args: [] }),
);
const address = tx0.recipient;
console.log(`vault ${address} (${statusName(tx0.status)})`);

const bal = async (a) => (await client.getBalance({ address: a })).toString();

async function send(fn, args = [], value = 0n) {
  const tx = await waitForSettled(client, await client.writeContract({ address, functionName: fn, args, value }));
  console.log(`  ${fn}(${args}) → ${statusName(tx.status)} / ${tx.txExecutionResultName ?? "?"}`);
  const msgs = JSON.stringify(tx.messages ?? [], (k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (msgs !== "[]") console.log(`    message: ${msgs}`);
  return tx;
}

await send("fund", [], FUND);
const ownerBefore = BigInt(await bal(account.address));
console.log(`vault ${await bal(address)} | owner ${ownerBefore}`);

console.log("\n>>> eth_pay_owner — EthSend with empty calldata, straight to an EOA");
await send("eth_pay_owner", [PAY]);

for (const wait of [0, 15, 30]) {
  if (wait) await new Promise((r) => setTimeout(r, 15_000));
  console.log(`  +${wait}s  vault ${await bal(address)}  owner ${await bal(account.address)}`);
}

const moved = BigInt(await bal(address)) < FUND;
console.log(`\nverdict: ${moved ? "✅ an EOA CAN be paid this way — this is the withdraw() fix" : "❌ still not delivered"}`);
console.log(`vault: ${address}`);
