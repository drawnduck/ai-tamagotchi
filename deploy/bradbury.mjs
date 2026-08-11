/**
 * Deploy AiPet to Testnet Bradbury and drive it through the whole value path.
 *
 *   echo 'PRIVATE_KEY=0x…' > .env     # a THROWAWAY testnet key, never a real one
 *   npm run deploy:bradbury           # deploy a fresh pet and play with it
 *   npm run deploy:bradbury -- 0x…    # reuse an already deployed pet
 *
 * This is the script that proves the parts Studio cannot: real GEN moving into the
 * contract via feed(), the feeder leaderboard filling up, and withdraw() paying the
 * owner back. Studio supports no token transfers at all, and `gltest` cannot drive
 * Bradbury (it needs gen_getContractSchemaForCode, which Bradbury does not serve).
 *
 * Both genlayer-js workarounds it depends on are documented in lib/.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { waitForSettled, statusName, succeeded, outcome } from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(HERE, "../contracts/ai_pet.py");
const ENV = path.resolve(HERE, "../.env");

// The DEPLOY ARTIFACT, not the source: Bradbury refuses a deploy over ~52 KB and
// contracts/ai_pet.py is past that with its comments. See lib/buildContract.mjs.
const built = buildContract(CONTRACT);
const contractCode = built.code;

const CTOR = ["Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon"];
const FEED_WEI = 50_000_000_000_000_000n; // 0.05 GEN => +5 satiety

installGasBuffer();

const pk = readFileSync(ENV, "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
if (!pk) {
  console.error(`No PRIVATE_KEY=0x… line in ${ENV}. Use a throwaway testnet key.`);
  process.exit(1);
}

const account = createAccount(pk);
const client = createClient({ chain: testnetBradbury, account });
const gen = (wei) => `${(Number(wei) / 1e18).toFixed(4)} GEN`;

console.log(`account ${account.address}  balance ${gen(await client.getBalance({ address: account.address }))}`);

// --------------------------------------------------------------------------- //

async function send(fn, { args = [], value = 0n } = {}) {
  const hash = await client.writeContract({ address, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    ${fn}() … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    timeoutMs: 1_200_000, // Bradbury can stall for many minutes when it is busy
  });
  const ok = succeeded(tx);
  console.log(`\r    ${fn}() ${ok ? "✅" : "❌"} ${outcome(tx)}${" ".repeat(20)}`);
  if (!ok) throw new Error(`${fn}() did not take effect — ${outcome(tx)}`);
  // ACCEPTED is the consensus verdict; the node's readable state trails it by a
  // beat, so an immediate get_state() can still show the pre-transaction values.
  await new Promise((r) => setTimeout(r, 4000));
  return tx;
}

const read = (fn, args = []) => client.readContract({ address, functionName: fn, args });

async function show(label) {
  const s = await read("get_state");
  console.log(`\n=== ${label} ===`);
  console.log(`  🐾 "${s.last_quote}"`);
  console.log(
    `  satiety ${s.satiety} | mood ${s.mood} | health ${s.health} | ${s.stage} ${s.age_days}d | alive ${s.alive}`,
  );
  console.log(`  fed in total: ${gen(s.total_fed_wei)} | contract holds ${gen(await client.getBalance({ address }))}`);
}

// --------------------------------------------------------------------------- //

let address = process.argv[2];
if (address) {
  console.log(`reusing pet at ${address}`);
} else {
  console.log("deploying…");
  const hash = await client.deployContract({
    code: contractCode,
    args: CTOR,
  });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    deploy … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    // A deploy carries the whole contract; measured at 10+ min under load, and
    // giving up early would strand a contract that is about to exist.
    timeoutMs: 1_800_000,
  });
  // A deploy can finalize with vote IDLE: you get an address, but no contract was
  // ever created there. Reading state back is the only honest confirmation.
  if (!succeeded(tx)) {
    console.error(`\ndeploy did not take effect — ${outcome(tx)}`);
    process.exit(1);
  }
  address = tx.recipient ?? tx.data?.contract_address ?? tx.txDataDecoded?.contractAddress;
  if (!address) {
    console.error("\nno contract address in receipt:", JSON.stringify(tx).slice(0, 800));
    process.exit(1);
  }
  console.log(`\ndeployed: ${address}`);
}

await show("start");

console.log("\n>>> play() — a real LLM call, settled through consensus");
await send("play");
await show("after play()");

console.log(`\n>>> feed() with ${gen(FEED_WEI)} — real value into the contract`);
await send("feed", { value: FEED_WEI });
await show("after feed()");

console.log("\n--- top feeders (on-chain leaderboard) ---");
for (const [i, f] of (await read("get_top_feeders", [0])).entries()) {
  console.log(`  ${i + 1}. ${f.address}  ${gen(f.wei)}`);
}

const held = await client.getBalance({ address });
if (held > 0n) {
  console.log(`\n>>> withdraw(${held}) — owner takes the food money back`);
  const tx = await send("withdraw", { args: [held] }); // bigint — wei does not fit a JS number
  console.log(`    contract still holds ${gen(await client.getBalance({ address }))} — expected.`);
  console.log("    The payout is a consensus-dispatched message and lands at FINALIZED,");
  console.log("    which takes ~30 min on Bradbury. Watch it settle with:");
  console.log(`      node tools/watchTx.mjs ${tx.txId ?? "<txId>"} ${address}`);
}

console.log("\n--- lines feed (generated by a real LLM, on-chain) ---");
for (const [i, q] of (await read("get_history")).entries()) console.log(`  ${i + 1}. ${q}`);
console.log(`\nPet address: ${address} — paste it into the frontend (network: testnetBradbury).`);
