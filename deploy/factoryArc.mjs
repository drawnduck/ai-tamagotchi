/**
 * The pet directory on Testnet Bradbury: registration, and a leaderboard that
 * ranks pets ACROSS contracts — the one thing a single pet cannot have.
 *
 *   npm run demo:factory                       # deploy a directory and use it
 *   npm run demo:factory -- 0xFACTORY          # reuse one
 *   npm run demo:factory -- 0xFACTORY 0xPET…   # …and register these pets into it
 *
 * Registration is proof, not a claim (2026-08-27 redesign): the directory
 * fetches the candidate's CODE from the network's own RPC inside a strict_eq
 * block and admits only sha256 hashes on its allowlist. So before registering,
 * this script makes sure the allowlist covers everyone it is about to register:
 * the current build artifact, plus the hash of whatever actually runs at each
 * given pet address (they may be older releases — `node tools/fingerprint.mjs`
 * prints both kinds).
 *
 * The board itself lives in factory storage now. New pets push their rows on
 * every feeding (they take the directory as a constructor argument); pets from
 * before that exist get a `refresh(pet)` here so their rows fill immediately.
 *
 * The factory used to have a `spawn()` that deployed pets itself. It is gone —
 * a contract-initiated deploy never arrives on Bradbury (re-verified
 * 2026-08-27: still stuck, the revert is `Ghost already deployed` now). See
 * the contract's module docstring and ROADMAP §4.11.
 */
import { createHash } from "crypto";
import { keccak256, toHex, pad } from "viem";
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
  // The same courtesy the frontend extends (sendPatiently): a node answering
  // "at capacity, retry in ~Nms" is asking for a retry, not reporting a failure.
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await client.writeContract({ address: factory, functionName: fn, args, value });
      break;
    } catch (e) {
      const msg = String(e?.details ?? e?.message ?? e);
      if (attempt >= 8 || !/at capacity|rate limit|retry/i.test(msg)) throw e;
      const waitMs = (Number(msg.match(/retryAfterMs["\s:]*(\d+)/)?.[1]) || 2000) + 1000 * attempt;
      process.stdout.write(`\r    ${label} … node busy, retry ${attempt}/8 in ${waitMs} ms   `);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
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

  // An ACCEPTED deploy is not yet writable: writes route through the ghost
  // contract on the EVM side, and until the consensus contract has created it
  // every write reverts NonGenVMContract() (0xc1ba7c94, measured 2026-08-27 on
  // a deploy that went through appeals). Reads work the whole time, which is
  // exactly what makes this easy to misdiagnose. Wait for the ghost.
  const ghostQuery = keccak256(toHex("isGhostContract(address)")).slice(0, 10)
    + pad(factory.toLowerCase(), { size: 32 }).slice(2);
  const started = Date.now();
  for (;;) {
    const r = await fetch(testnetBradbury.rpcUrls.default.http[0], {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: testnetBradbury.consensusMainContract.address, data: ghostQuery }, "latest"] }),
    }).then((x) => x.json());
    if (!r.error && BigInt(r.result) === 1n) break;
    if (Date.now() - started > 900_000) {
      console.error("the factory's ghost contract never appeared — writes would all revert; try redeploying");
      process.exit(1);
    }
    process.stdout.write(`\r    waiting for the ghost contract … ${((Date.now() - started) / 1000).toFixed(0)}s   `);
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log(`\r    ghost contract ready${" ".repeat(30)}`);
}

console.log(`\ninfo: ${JSON.stringify(await read("get_info"))}`);

// the allowlist: every build we are about to vouch for ---------------------- //
const artifactCode = readFileSync(path.resolve(HERE, "../build/ai_pet.py"));
const wanted = new Map([[
  createHash("sha256").update(artifactCode).digest("hex"), "build/ai_pet.py",
]]);
for (const p of pets) {
  try {
    const b64 = await client.request({ method: "gen_getContractCode", params: [{ address: p }] });
    wanted.set(createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex"),
      `deployed at ${p.slice(0, 10)}…`);
  } catch {
    console.log(`    (no code at ${p} — register will refuse it)`);
  }
}
for (const [fp, why] of wanted) {
  if (await read("is_known_build", [fp])) {
    console.log(`    build ${fp.slice(0, 12)}… (${why}) already allowed`);
    continue;
  }
  await send("add_fingerprint", { args: [fp], label: `add_fingerprint(${why})` });
}

// the directory, over pets that already exist ------------------------------- //
if (pets.length) {
  console.log(`\n>>> registering ${pets.length} existing pet(s)`);
  for (const p of pets) {
    if (await read("is_registered", [p])) {
      console.log(`    ${p} already in`);
    } else {
      await send("register", { args: [p], label: `register(${p.slice(0, 10)}…)` });
    }
    // Pre-report() pets never push a row; pull one so the board is not blank.
    // Works only once the pet's own deploy has FINALIZED (ROADMAP §3) — for a
    // brand-new pet just let its first feeding report instead.
    try {
      await send("refresh", { args: [p], label: `refresh(${p.slice(0, 10)}…)` });
    } catch (e) {
      console.log(`    refresh(${p.slice(0, 10)}…) skipped: ${e.message}`);
    }
  }
} else {
  console.log("\nNo pets given. Pass some addresses to register them:");
  console.log(`  npm run demo:factory -- ${factory} 0xPET1 0xPET2`);
}

await board("shared leaderboard, across contracts");

console.log(`\ndirectory ${factory}`);
