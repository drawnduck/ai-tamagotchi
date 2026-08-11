/**
 * Watch a GenLayer tx until FINALIZED and report the contract balance alongside.
 *
 *   node tools/watchTx.mjs <txHash> <contractAddress>
 *
 * Why: `emit_transfer` produces a message the consensus layer dispatches, so a
 * `withdraw()` that returns FINISHED_WITH_RETURN at ACCEPTED has not necessarily
 * paid anyone yet. This is how you tell.
 */
import { readFileSync } from "fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { statusName } from "../lib/waitForSettled.mjs";

const pk = readFileSync(".env", "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
const account = createAccount(pk);
const client = createClient({ chain: testnetBradbury, account });

const [hash, address] = process.argv.slice(2);
const started = Date.now();
let last = null;

for (;;) {
  const tx = await client.getTransaction({ hash });
  const status = String(tx?.status ?? "");
  const balance = address ? await client.getBalance({ address }) : 0n;
  const line = `${((Date.now() - started) / 1000).toFixed(0)}s  ${statusName(status)}  contract=${balance} wei`;
  if (line.slice(line.indexOf(" ")) !== last) {
    last = line.slice(line.indexOf(" "));
    console.log(line);
  }
  if (status === "7") {
    console.log("FINALIZED — final contract balance:", balance.toString(), "wei");
    break;
  }
  if (Date.now() - started > 1_200_000) {
    console.log("gave up after 20 min at", statusName(status));
    break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
