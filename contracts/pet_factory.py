# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
AiPetFactory — a directory of AiPets, and the one thing a single pet cannot have:
a ranking ACROSS pets.

`register(pet)` admits an address only after PROVING what code lives there;
`get_leaderboard(...)` ranks the whole directory by what each pet's community
has fed it. Pets deployed any way at all can join — a directory that only knew
its own children would be a much less useful directory.

MEMBERSHIP IS PROVED, NOT CLAIMED (2026-08-27 redesign)
-------------------------------------------------------
The old membership test was shape: answer `get_state()` with pet-sized fields
and you were in. Twenty honest-looking lines returning `total_fed_wei: 10**30`
passed it and owned the board forever. The GenLayer team called it out, and
they were right.

GenVM gives a contract no way to read another contract's code — no host call,
and a CREATE2 address commits to (factory, salt, chain), never to the code. But
the network's own RPC serves any contract's source (`gen_getContractCode`), and
a GenLayer contract can make web requests inside a non-deterministic block. So
`register()` asks the network itself: fetch the candidate's code, hash it, and
let every validator repeat the fetch under `strict_eq` — the vote only passes
when they all saw the same bytes. The sha256 must then match a fingerprint of a
known AiPet build (`add_fingerprint`, one per released artifact: sha256 of the
built `build/ai_pet.py`). An impostor's code hashes to something else, and no
shape it answers with matters any more.

Measured on Bradbury 2026-08-27 (probes/attestProbe.log, probes/attestEdge.log):
the round trip votes AGREE in ~15 s, the on-chain hash matches `sha256sum` of
the artifact bit for bit, and the code of a contract whose deploy is merely
ACCEPTED is already served — so a pet can register the moment it hatches,
instead of waiting ~40 minutes for finalization as the shape test required.
An address with no code gets a deterministic error from the RPC, which becomes
a civil UserError here — the old test aborted the whole call un-catchably.

The RPC URL is storage (`set_rpc`), not a constant: it is the one centralized
dependency in the scheme, and outliving an endpoint move should not take a
redeploy. If GenVM ever grows a native read-code host call, `_verify_code` is
the only method to swap.

THE BOARD IS STORAGE, NOT A FAN-OUT OF SUB-VMS (same redesign)
--------------------------------------------------------------
`get_leaderboard` used to read each pet live, one sub-VM per row, page the
ROSTER and sort inside the page — so "page 1" was the first 50 registered pets
sorted among themselves, and a champion registered 51st could never reach it.
The second thing the team called out.

Scores now live here. A registered pet reports its own row after every feeding
(`report`, sender-authenticated — measured: a contract→contract message arrives
with `gl.message.sender_address` equal to the calling CONTRACT's address, and
`origin_address` is a consensus address, useless for authorship), and anyone
may `refresh(pet)` to re-pull a row live for pets built before `report`
existed. `get_leaderboard` then sorts the FULL set from its own storage — no
sub-VM per row, deterministic, cheap — and cuts the page AFTER sorting, so
page boundaries are rank boundaries. The board lags reality by one report
(~20 s) instead of being wrong about who is first.

A report is only as honest as the pet that sent it — which is exactly why
membership requires a known build: verified code cannot lie about its own
totals. The sanitizers stay anyway (`_num`, `_clean`): a future allowlisted
build with different fields must degrade to a silly row, never take the board
down (§3c).

WHY THERE IS STILL NO `spawn()`
-------------------------------
Re-tested 2026-08-27, two weeks after ROADMAP §4.11: a contract-initiated
`gl.deploy_contract` still never creates anything on Bradbury. The transaction
is voted through, its writes land, and the deployment message is never issued —
stuck at READY_TO_FINALIZE with `finalizeTransaction` now reverting
`Ghost already deployed` (it was `FinalizationNotAllowed()` in August). Nothing
exists at any derivable address (probes/spawnRetest.log). Deploying a pet
directly works and is what the frontend and `deploy/bradbury.mjs` do; with
code-hash membership, a factory-deploy would add trust but no longer gates it.

CONSENSUS
---------
`refresh` pins its cross-contract read to `StorageType.LATEST_FINAL`, for the
same reason `AiPet.visit` does: only finalized state is agreed on by every
validator. `register` is the one non-deterministic method (the code fetch);
everything else is deterministic from top to bottom and needs no eq_principle.
"""

import json

from genlayer import *
from genlayer.py.public_abi import StorageType

MAX_NAME = 48          # chars kept from a pet's self-reported name
MAX_TEXT = 64          # chars kept from stage / character strings
PAGE_MAX = 50          # hard cap on rows returned by any one call
DEFAULT_RPC = "https://rpc-bradbury.genlayer.com"


class PetRegistered(gl.Event):
    """A pet joined the directory. Indexed by the pet, so a UI can follow one."""

    def __init__(self, pet: Address, /, **blob) -> None: ...


class PetReported(gl.Event):
    """A pet's row changed — its own report, or anyone's refresh."""

    def __init__(self, pet: Address, /, **blob) -> None: ...


def _clean(text: str, limit: int) -> str:
    """A registered pet's name is text its owner wrote. Treat it as such.

    The factory never prompts an LLM, so there is no fence to break out of here —
    but the name is handed to UIs, and a name with newlines or brackets in it is
    somebody testing what this contract does with them. Mirrors AiPet._sanitize.
    """
    out = []
    for ch in str(text)[:limit]:
        out.append(" " if ch in "[]{}<>\n\r\t" else ch)
    return "".join(out).strip()


def _num(value, fallback: int = 0) -> int:
    """Parse a number another contract reported. Never assume it is one.

    Membership by code-hash makes rows trustworthy today, but every future
    allowlisted build reports through this same door, and one build answering
    `"total_fed_wei": "lots"` must cost that pet a silly row — not the whole
    board, for every caller, forever (§3c).
    """
    try:
        n = int(value)
    except Exception:
        return fallback
    return n if n >= 0 else fallback


class AiPetFactory(gl.Contract):
    admin: Address
    pets: DynArray[Address]               # roster, in registration order
    listed: TreeMap[Address, bool]        # membership
    open_to_all: bool                     # may anyone register a pet here?
    rpc_url: str                          # where _verify_code asks for code

    fingerprints: TreeMap[str, bool]      # sha256 of every known AiPet build
    fingerprint_of: TreeMap[Address, str] # the build each member proved

    # the board — one value per pet, written by report()/refresh() only
    name_of: TreeMap[Address, str]
    owner_of: TreeMap[Address, Address]
    fed_of: TreeMap[Address, u256]        # total_fed_wei, the ranking key
    alive_of: TreeMap[Address, bool]
    age_of: TreeMap[Address, u256]        # age_days
    stage_of: TreeMap[Address, str]
    mood_of: TreeMap[Address, u256]
    character_of: TreeMap[Address, str]

    def __init__(self, open_to_all: bool = True, rpc_url: str = DEFAULT_RPC):
        self.admin = gl.message.sender_address
        self.open_to_all = open_to_all
        self.rpc_url = rpc_url

    # ===================== internals =========================================

    def _require_admin(self) -> None:
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("only the factory admin can do this")

    def _verify_code(self, addr: Address) -> str:
        """Fetch the candidate's code from the network's RPC and hash it.

        Runs inside `strict_eq`: the leader fetches, every validator re-fetches,
        and the transaction only passes if all of them hashed the same bytes.
        Storage is unreachable inside the block, so the URL and address are
        captured as plain strings first.

        The RPC serves code for contracts whose deploy is only ACCEPTED, so a
        freshly hatched pet passes here ~40 minutes before a cross-contract
        call could reach it (measured — see the module docstring).
        """
        url = str(self.rpc_url)
        hexaddr = addr.as_hex

        def read() -> str:
            import base64
            import hashlib

            res = gl.nondet.web.post(
                url,
                body=json.dumps({
                    "jsonrpc": "2.0", "id": 1,
                    "method": "gen_getContractCode",
                    "params": [{"address": hexaddr}],
                }),
                headers={"content-type": "application/json"},
            )
            if res.status != 200 or res.body is None:
                return f"rpc:{res.status}"
            data = json.loads(res.body.decode("utf-8"))
            b64 = data.get("result")
            if not isinstance(b64, str):
                # deterministic per address: "contract code not found at …"
                return "absent"
            return hashlib.sha256(base64.b64decode(b64)).hexdigest()

        fp = str(gl.eq_principle.strict_eq(read))
        if fp == "absent":
            raise gl.vm.UserError("no contract code at that address")
        if fp.startswith("rpc:"):
            raise gl.vm.UserError(f"the code registry RPC answered {fp[4:]} — try again")
        if self.fingerprints.get(fp) is None:
            raise gl.vm.UserError("that code is not a known AiPet build")
        return fp

    def _store_row(self, pet: Address, name, owner, total_fed_wei, age_days,
                   stage, alive, mood, character) -> None:
        self.name_of[pet] = _clean(name, MAX_NAME)
        try:
            self.owner_of[pet] = Address(owner)
        except Exception:
            pass                          # a row without an owner is still a row
        self.fed_of[pet] = u256(_num(total_fed_wei))
        self.alive_of[pet] = bool(alive)
        self.age_of[pet] = u256(_num(age_days))
        self.stage_of[pet] = _clean(stage, MAX_TEXT)
        mood_n = _num(mood)
        self.mood_of[pet] = u256(mood_n if mood_n <= 100 else 100)
        self.character_of[pet] = _clean(character, MAX_TEXT)

    def _row(self, pet: Address) -> dict:
        owner = self.owner_of.get(pet)
        return {
            "address": pet.as_hex,
            "name": str(self.name_of.get(pet) or ""),
            "owner": owner.as_hex if owner is not None else "",
            # normalized on the way out, so the sort and every client can rely
            # on this being a base-10 integer
            "total_fed_wei": str(int(self.fed_of.get(pet) or 0)),
            "age_days": int(self.age_of.get(pet) or 0),
            "stage": str(self.stage_of.get(pet) or ""),
            "alive": bool(self.alive_of.get(pet) or False),
            "mood": int(self.mood_of.get(pet) or 0),
            "character": str(self.character_of.get(pet) or ""),
            "fingerprint": str(self.fingerprint_of.get(pet) or ""),
        }

    # ===================== admin =============================================

    @gl.public.write
    def set_open(self, allow: bool) -> None:
        """Admin switch: a public directory, or a curated one."""
        self._require_admin()
        self.open_to_all = allow

    @gl.public.write
    def set_rpc(self, url: str) -> None:
        """Where _verify_code asks the network for a candidate's code."""
        self._require_admin()
        if not str(url).startswith("https://"):
            raise gl.vm.UserError("the code registry RPC must be an https URL")
        self.rpc_url = str(url)

    @gl.public.write
    def add_fingerprint(self, sha256_hex: str) -> None:
        """Allow one AiPet build: the sha256 of its built artifact.

        `sha256sum build/ai_pet.py` at release time, or
        `node tools/fingerprint.mjs <address>` for a build already deployed.
        """
        self._require_admin()
        fp = str(sha256_hex).lower().removeprefix("0x")
        if len(fp) != 64 or any(c not in "0123456789abcdef" for c in fp):
            raise gl.vm.UserError("a fingerprint is 64 hex chars of sha256")
        self.fingerprints[fp] = True

    @gl.public.write
    def remove_fingerprint(self, sha256_hex: str) -> None:
        """Retire a build. Pets already registered with it stay registered."""
        self._require_admin()
        fp = str(sha256_hex).lower().removeprefix("0x")
        if self.fingerprints.get(fp) is not None:
            del self.fingerprints[fp]

    # ===================== write =============================================

    @gl.public.write
    def register(self, pet: str) -> None:
        """Add a pet to the directory, once the NETWORK proves what it is.

        Whoever calls this gets no say in anything: the code fetched by every
        validator decides membership, and the row starts empty — the pet's own
        `report()` (or anyone's `refresh()`) fills it. Registration works the
        moment the pet's deploy is ACCEPTED; no need to wait for finalization.
        """
        if not self.open_to_all and gl.message.sender_address != self.admin:
            raise gl.vm.UserError("this directory is admin-only")
        try:
            addr = Address(pet)
        except Exception:
            raise gl.vm.UserError("not a valid address")
        if addr == self.address:
            raise gl.vm.UserError("the factory is not a pet")
        if self.listed.get(addr) is not None:
            raise gl.vm.UserError("already registered")

        fp = self._verify_code(addr)

        self.pets.append(addr)
        self.listed[addr] = True
        self.fingerprint_of[addr] = fp

        PetRegistered(addr, fingerprint=fp, total=len(self.pets)).emit()

    @gl.public.write
    def report(self, name: str, owner: str, total_fed_wei: int, age_days: int,
               stage: str, alive: bool, mood: int, character: str) -> None:
        """A pet updates its own row. Called by ITS contract, never by a wallet.

        The sender IS the authentication: `gl.message.sender_address` of a
        contract→contract message is the calling contract's address (measured —
        probes/regProbe.log), an EOA cannot fake it, and only listed pets — that
        is, pets whose code passed `_verify_code` — are listed. Runs on gas the
        reporting pet's action already paid; keep it deterministic and cheap,
        an LLM call here could bounce the delivery (same reasoning as
        AiPet.__receive__).
        """
        pet = gl.message.sender_address
        if self.listed.get(pet) is None:
            raise gl.vm.UserError("only registered pets may report")
        self._store_row(pet, name, owner, total_fed_wei, age_days,
                        stage, alive, mood, character)
        PetReported(pet, total_fed_wei=str(_num(total_fed_wei)), via="report").emit()

    @gl.public.write
    def refresh(self, pet: str) -> None:
        """Anyone re-pulls one pet's row live. The pull half of the board.

        For pets built before `report()` existed — they pass `_verify_code`
        (their artifact is allowlisted) but never push, so their rows would sit
        empty forever. One sub-VM read per call, from FINALIZED state.

        Two honest limitations, both inherent to cross-contract reads: a pet
        whose deploy has not finalized yet aborts this call un-catchably (GenVM
        stops the caller while starting the sub-VM — ROADMAP §3), so refresh a
        NEW pet only after ~30 min or let its own reports fill the row; and a
        registered contract that stopped answering costs the caller the call —
        it cannot hurt anyone else's row or the board itself.
        """
        addr = Address(pet)
        if self.listed.get(addr) is None:
            raise gl.vm.UserError("not a registered pet")

        proxy = gl.get_contract_at(addr).view(state=StorageType.LATEST_FINAL)
        state = proxy.get_state()
        if not isinstance(state, dict):
            raise gl.vm.UserError("that pet did not answer with a state")
        try:
            owner = str(proxy.get_owner())
        except Exception:
            owner = ""
        self._store_row(
            addr,
            state.get("name", ""),
            owner,
            state.get("total_fed_wei", 0),
            state.get("age_days", 0),
            state.get("stage", ""),
            state.get("alive", False),
            state.get("mood", 0),
            state.get("character", ""),
        )
        PetReported(addr, total_fed_wei=str(_num(state.get("total_fed_wei", 0))),
                    via="refresh").emit()

    # ===================== views =============================================

    @gl.public.view
    def count(self) -> int:
        return len(self.pets)

    @gl.public.view
    def get_pets(self, offset: int, limit: int) -> list:
        """The roster in registration order, straight from storage — cheap.

        Paged because the directory is unbounded and the caller pays for the
        answer. `limit <= 0` means PAGE_MAX, not "everything".
        """
        start, end = self._page(offset, limit)
        rows = []
        for i in range(start, end):
            addr = self.pets[i]
            owner = self.owner_of.get(addr)
            rows.append({
                "address": addr.as_hex,
                "name": str(self.name_of.get(addr) or ""),
                "owner": owner.as_hex if owner is not None else "",
            })
        return rows

    @gl.public.view
    def get_leaderboard(self, offset: int, limit: int) -> list:
        """The point of the whole contract: a ranking ACROSS pets.

        Ranks the FULL directory from storage — no cross-contract calls, no
        sub-VMs, nothing another contract can do at read time to hurt it — and
        cuts the requested page AFTER sorting, so `offset=50` really is ranks
        51…100. Rows are as fresh as the last report()/refresh() for each pet.

        Ties rank by registration order (python's sort is stable), so a tie
        cannot flap between two calls.
        """
        rows = [self._row(self.pets[i]) for i in range(len(self.pets))]
        rows.sort(key=lambda r: int(r["total_fed_wei"]), reverse=True)
        start, end = self._page(offset, limit)
        return rows[start:end]

    @gl.public.view
    def is_registered(self, pet: str) -> bool:
        try:
            return self.listed.get(Address(pet)) is not None
        except Exception:
            return False

    @gl.public.view
    def get_fingerprint(self, pet: str) -> str:
        """Which build this member proved at registration ("" if not a member)."""
        try:
            return str(self.fingerprint_of.get(Address(pet)) or "")
        except Exception:
            return ""

    @gl.public.view
    def is_known_build(self, sha256_hex: str) -> bool:
        fp = str(sha256_hex).lower().removeprefix("0x")
        return self.fingerprints.get(fp) is not None

    @gl.public.view
    def get_info(self) -> dict:
        return {
            "admin": self.admin.as_hex,
            "pets": len(self.pets),
            "open_to_all": bool(self.open_to_all),
            "page_max": PAGE_MAX,
            "rpc_url": str(self.rpc_url),
        }

    def _page(self, offset: int, limit: int) -> tuple:
        total = len(self.pets)
        start = int(offset)
        if start < 0:
            start = 0
        if start > total:
            start = total
        n = int(limit)
        if n <= 0 or n > PAGE_MAX:
            n = PAGE_MAX
        end = start + n
        if end > total:
            end = total
        return start, end
