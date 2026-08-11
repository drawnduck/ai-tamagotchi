/**
 * The pet directory on Testnet Bradbury: registration, and a leaderboard that
 * ranks pets ACROSS contracts — the one thing a single pet cannot have.
 *
 *   npm run demo:factory                       # deploy a directory and use it
 *   npm run demo:factory -- 0xFACTORY          # reuse one
 *   npm run demo:factory -- 0xFACTORY 0xPET…   # …and register these pets into it
 *
 * Registration is a cross-contract read, not a claim: the candidate has to
 * answer `get_state()` from FINALIZED state with something pet-shaped, and its
 * name and owner are taken from that answer rather than from whoever called.
 * Pets deployed long before this directory existed, by older versions of the
 * contract, join exactly like new ones.
 *
 * The factory used to have a `spawn()` that deployed pets itself. It is gone —
 * the deployment never arrived on Bradbury however it was sent. See the
 * contract's module docstring and ROADMAP §4.11.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import {
  waitForSettled,

  statusName,
  succeeded,
  outcome,
} from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACTORY = path.resolve(HERE, "../contracts/pet_factory.py");
const ENV = path.resolve(HERE, "../.env");

const factorySource = buildContract(FACTORY);
console.log(`directory artifact ${factorySource.builtBytes} bytes (from ${factorySource.sourceBytes})`);

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
console.log(
  `\naccount ${account.address}  balance ${gen(await client.getBalance({ address: account.address }))}`,
);

let [factory, ...pets] = process.argv.slice(2);
const read = (fn, args = []) => client.readContract({ address: factory, functionName: fn, args });

async function send(fn, { args = [], value = 0n, label = fn } = {}) {
  const hash = await client.writeContract({ address: factory, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    ${label} … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    timeoutMs: 1_200_000,
  });
  if (!succeeded(tx)) throw new Error(`${label} did not take effect — ${outcome(tx)}`);
  console.log(`\r    ${label} ✅ ${outcome(tx)}${" ".repeat(24)}`);
  await new Promise((r) => setTimeout(r, 4000));
  return tx;
}

async function board(title) {
  const rows = await read("get_leaderboard", [0, 0]);
  console.log(`\n--- ${title} ---`);
  if (!rows.length) console.log("  (empty)");
  for (const [i, r] of rows.entries()) {
    console.log(
      `  ${i + 1}. ${r.name.padEnd(10)} ${gen(r.total_fed_wei).padStart(12)}  ` +
        `${r.stage} ${r.age_days}d  mood ${r.mood}${r.alive ? "" : "  💀"}` +
        (r.character ? `  — ${r.character}` : ""),
    );
    console.log(`     ${r.address}`);
  }
  return rows;
}

// --------------------------------------------------------------------------- //

if (factory) {
  console.log(`reusing factory ${factory}`);
} else {
  console.log("\ndeploying the factory…");
  const tx = await waitForSettled(
    client,
    await client.deployContract({ code: factorySource.code, args: [true] }),
    {
      onProgress: (s, ms) =>
        process.stdout.write(`\r    deploy … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
      timeoutMs: 1_800_000,
    },
  );
  if (!succeeded(tx)) {
    console.error(`\nfactory deploy did not take effect — ${outcome(tx)}`);
    process.exit(1);
  }
  factory = tx.recipient ?? tx.data?.contract_address ?? tx.txDataDecoded?.contractAddress;
  console.log(`\r    factory ${factory}${" ".repeat(24)}`);
}

console.log(`\ninfo: ${JSON.stringify(await read("get_info"))}`);

// the directory, over pets that already exist ------------------------------- //
if (pets.length) {
  console.log(`\n>>> registering ${pets.length} existing pet(s)`);
  for (const p of pets) {
    if (await read("is_registered", [p])) {
      console.log(`    ${p} already in`);
      continue;
    }
    await send("register", { args: [p], label: `register(${p.slice(0, 10)}…)` });
  }
} else {
  console.log("\nNo pets given. Pass some addresses to register them:");
  console.log(`  npm run demo:factory -- ${factory} 0xPET1 0xPET2`);
}

await board("shared leaderboard, across contracts");

console.log(`\ndirectory ${factory}`);
