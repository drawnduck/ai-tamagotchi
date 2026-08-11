/**
 * Build the deploy artifact from `contracts/ai_pet.py`.
 *
 * Bradbury refuses a deploy at gas estimation once the payload passes ~52 KB
 * (`BlockPubdataLimitReached`), and genlayer-js then turns that into the
 * misleading `intrinsic gas too low` by falling back to 200 000 gas. The full
 * measurement is in `tools/buildContract.py`, which does the actual stripping
 * with Python's own tokenizer.
 *
 * Every deploy path goes through here, so nothing can accidentally ship the
 * unstripped source and rediscover the ceiling the hard way.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BUILDER = path.join(ROOT, "tools", "buildContract.py");

/** Measured on Bradbury, 2026-08-10. Refuse before spending a minute finding out. */
export const DEPLOY_LIMIT_BYTES = 52 * 1024;

function python() {
  for (const exe of [path.join(ROOT, ".venv", "bin", "python"), "python3", "python"]) {
    try {
      execFileSync(exe, ["--version"], { stdio: "ignore" });
      return exe;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("no python3 on PATH — needed to build the contract artifact");
}

/**
 * @param {string} source  contract to build (defaults to contracts/ai_pet.py)
 * @returns {{code: Uint8Array, path: string, sourceBytes: number, builtBytes: number}}
 */
export function buildContract(source = path.join(ROOT, "contracts", "ai_pet.py")) {
  // Named ai_pet.py, deliberately: direct-mode tests import the artifact by
  // filename, so keeping the name lets the whole suite run against it.
  const outDir = path.join(ROOT, "build");
  const out = path.join(outDir, path.basename(source));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  execFileSync(python(), [BUILDER, source, "-o", out], { stdio: ["ignore", "ignore", "inherit"] });

  const code = new Uint8Array(readFileSync(out));
  const sourceBytes = statSync(source).size;
  if (code.length > DEPLOY_LIMIT_BYTES) {
    throw new Error(
      `built artifact is ${code.length} bytes, over the ~${DEPLOY_LIMIT_BYTES} byte deploy ` +
        "ceiling measured on Bradbury — the deploy would be refused at gas estimation",
    );
  }
  return { code, path: out, sourceBytes, builtBytes: code.length };
}
