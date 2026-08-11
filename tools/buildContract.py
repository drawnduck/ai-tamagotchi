"""Produce the deploy artifact for an Intelligent Contract: source minus prose.

WHY THIS EXISTS
---------------
On Testnet Bradbury a deploy is refused at gas estimation with
`invalid transaction: BlockPubdataLimitReached` once the payload passes roughly
**52 KB**. Measured 2026-08-10 by asking for the estimate at several sizes:

    50 KB (51200 bytes): ok gas=40793599
    51 KB (52224 bytes): ok gas=41510333
    52 KB (53248 bytes): ERR invalid transaction: BlockPubdataLimitReached

A plain 53 KB transfer to a wallet estimates fine, so it is not calldata size
alone — it is the consensus contract's own writes on top of it. And the failure
is worse than it looks: genlayer-js catches the failed estimate and falls back to
a hardcoded 200 000 gas, so the node then rejects the send with the *misleading*
`intrinsic gas too low`. That is the error you actually see.

`contracts/ai_pet.py` crossed 52 KB the moment character drift was added. Its
comments are the project's documentation — several of them are the only record of
why a consensus decision was made — so the answer is not to delete them but to
stop *shipping* them. Comments and docstrings have no runtime meaning here.

WHAT IT DOES
------------
Tokenizes with Python's own `tokenize`, so string literals, f-strings and nested
quotes are handled by the same code that runs the contract — a hand-rolled regex
stripper is exactly the kind of thing that silently corrupts one line in a
docstring and is discovered on-chain. Removes comments and docstrings, collapses
the blank lines that are left, and keeps:

  * the `# { "Depends": ... }` runner comment on line 1 — GenVM reads it, and
    without it the contract does not run at all;
  * every line of code, unchanged, in the same order.

    python3 tools/buildContract.py contracts/ai_pet.py [-o out.py]

Verified by `tests/direct/test_built_artifact.py`, which runs the built artifact
through the same deployment the suite uses and checks it still behaves.
"""

import argparse
import io
import sys
import tokenize


def strip(source: str) -> str:
    """Return `source` with comments and docstrings removed.

    Works by blanking the character spans of the tokens to drop, rather than by
    `tokenize.untokenize`, which round-trips whitespace into stray `\\` line
    continuations. Every surviving byte of code stays exactly where the author
    put it, which is what makes the artifact readable when something goes wrong
    on-chain.
    """
    rows = [list(line) for line in source.splitlines(keepends=True)]
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))

    def blank(tok, replacement=""):
        (r1, c1), (r2, c2) = tok.start, tok.end
        for r in range(r1, r2 + 1):
            row = rows[r - 1]
            lo = c1 if r == r1 else 0
            hi = c2 if r == r2 else len(row)
            for c in range(lo, min(hi, len(row))):
                if row[c] != "\n":
                    row[c] = " "
        if replacement:
            row = rows[r1 - 1]
            row[c1:c1 + len(replacement)] = list(replacement)

    # A string token is a docstring when it is the first statement of a module,
    # class or function body — it directly follows a NEWLINE/INDENT/DEDENT (or
    # begins the file), and is itself followed by a NEWLINE.
    openers = (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT,
               tokenize.ENCODING)
    prev_meaningful = tokenize.NEWLINE

    for i, tok in enumerate(tokens):
        kind = tok.type

        if kind == tokenize.COMMENT:
            # Keep only the runner comment, which must stay on the first line.
            if not (tok.start[0] == 1 and "Depends" in tok.string):
                blank(tok)
            continue

        if (
            kind == tokenize.STRING
            and prev_meaningful in openers
            and _next_type(tokens, i) == tokenize.NEWLINE
        ):
            # A body that is *only* a docstring becomes an empty block, which is
            # a syntax error — leave a `pass` behind in that one case.
            blank(tok, "pass" if _block_would_empty(tokens, i) else "")
            continue

        if kind not in (tokenize.NL, tokenize.COMMENT):
            prev_meaningful = kind

    return _collapse_blank_lines("".join("".join(row) for row in rows))


def _next_type(tokens, i):
    for tok in tokens[i + 1:]:
        if tok.type != tokenize.COMMENT:
            return tok.type
    return None


def _block_would_empty(tokens, i) -> bool:
    """Is this docstring the only statement in its block?"""
    for tok in tokens[i + 1:]:
        if tok.type in (tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT):
            continue
        return tok.type in (tokenize.DEDENT, tokenize.ENDMARKER)
    return True


def _collapse_blank_lines(text: str) -> str:
    """Drop the holes the removed prose left behind."""
    lines = []
    for line in text.splitlines():
        if not line.strip():
            if lines and not lines[-1].strip():
                continue                # never two blank lines in a row
            line = ""
        lines.append(line.rstrip())
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source")
    ap.add_argument("-o", "--out", help="write here instead of stdout")
    args = ap.parse_args()

    with open(args.source, encoding="utf-8") as fh:
        source = fh.read()
    built = strip(source)

    if not built.startswith("#") or "Depends" not in built.split("\n", 1)[0]:
        print("refusing: the runner comment is missing from line 1", file=sys.stderr)
        return 1
    compile(built, args.source, "exec")      # never ship something that won't parse

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(built)
        print(
            f"{len(source.encode())} -> {len(built.encode())} bytes "
            f"({100 - len(built.encode()) * 100 // len(source.encode())}% smaller)",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(built)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
