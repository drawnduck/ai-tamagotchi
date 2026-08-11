# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
AiPetFactory — a directory of AiPets, and the one thing a single pet cannot have:
a ranking ACROSS pets.

`register(pet)` admits any address that can prove it behaves like an AiPet;
`get_leaderboard(...)` reads every listed pet live and ranks them by what their
community has fed them. Pets deployed any way at all can join — a directory that
only knew its own children would be a much less useful directory.

WHY THERE IS NO `spawn()`
-------------------------
There was one: `gl.deploy_contract` with a CREATE2 salt, so a new pet's address
was known immediately even though the deployment settled later. It is gone, and
the reason is worth keeping.

On Testnet Bradbury that deployment never arrives. The transaction is accepted,
the internal message carries its `saltNonce`, and nothing is ever created — at
the derived address or anywhere else — while the chain refuses
`finalizeTransaction` for it with `FinalizationNotAllowed()` and finalizes
ordinary transactions normally. The investigation is in ROADMAP §4.11; the short
version is that the contract was correct and the network would not carry it.

Shipping a method that cannot work is worse than not shipping it: it is the one
thing in the repo a reader would try, and it would fail in a way that looks like
the contract's fault. Deploying a pet directly works and is what the frontend and
`deploy/bradbury.mjs` do.

The size argument that shaped that method is still worth recording, because it
constrains any future attempt: a factory cannot embed the pet's source. Bradbury
refuses any deploy whose payload passes ~52 KB (ROADMAP §4) and the built pet
artifact is ~29 KB, so a factory carrying it inline would be near the ceiling
before it had any logic of its own. The code would have to ride in as a
parameter, which also means such a factory can never promise *what* it deploys —
exactly why `register()` verifies rather than trusts.

CONSENSUS
---------
Every cross-contract read is pinned to `StorageType.LATEST_FINAL`, for the same
reason `AiPet.visit` is: only finalized state is agreed on by every validator,
and a non-final head can differ between two validators reading seconds apart.
The registry therefore lags reality slightly, on purpose.

There is no LLM and no web access anywhere in this contract. It is deterministic
from top to bottom, which is why it needs no eq_principle at all.
"""

from genlayer import *
from genlayer.py.public_abi import StorageType

MAX_NAME = 48          # chars kept from a pet's self-reported name
PAGE_MAX = 50          # hard cap on rows returned by any one call


class PetRegistered(gl.Event):
    """A pet joined the directory. Indexed by the pet, so a UI can follow one."""

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

    Everything on the leaderboard is self-reported by a contract this factory
    does not control, and `register` is open to anyone by default. A pet
    answering `"total_fed_wei": "lots"` used to take `int()` with it — and with
    `int()`, the whole board, for every caller, forever: there is no way to
    un-register a pet, so one line of junk was a permanent denial of service on
    the factory's headline feature. It costs one griefer one registration.
    """
    try:
        return int(value)
    except Exception:
        return fallback


def _looks_like_a_pet(addr: Address) -> dict:
    """Read a candidate's own view of itself, from FINALIZED state.

    This is the only membership test the directory has, and it is a test of
    *shape*: the address must answer `get_state()` with something pet-sized. An
    address with no code at all never even reaches this — GenVM aborts the caller
    with `invalid_contract absent_runner_comment` while starting the sub-VM, which
    is not a Python exception and cannot be caught (measured on Bradbury).
    """
    try:
        state = gl.get_contract_at(addr).view(state=StorageType.LATEST_FINAL).get_state()
    except Exception:
        raise gl.vm.UserError("that address does not answer like an AiPet")
    needed = ("name", "mood", "total_fed_wei", "alive")
    if not isinstance(state, dict) or any(k not in state for k in needed):
        raise gl.vm.UserError("that address does not answer like an AiPet")
    return state


class AiPetFactory(gl.Contract):
    admin: Address
    pets: DynArray[Address]
    names: DynArray[str]
    listed: TreeMap[Address, bool]        # membership; the roster keeps the order
    owner_of: TreeMap[Address, Address]   # as reported by the pet itself
    open_to_all: bool                     # may anyone register a pet here?

    def __init__(self, open_to_all: bool = True):
        self.admin = gl.message.sender_address
        self.open_to_all = open_to_all

    # ===================== internals =========================================

    def _require_admin(self) -> None:
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("only the factory admin can do this")

    def _add(self, addr: Address, name: str, owner: Address) -> None:
        self.pets.append(addr)
        self.names.append(name)
        self.listed[addr] = True
        self.owner_of[addr] = owner

    # ===================== write =============================================

    @gl.public.write
    def register(self, pet: str) -> None:
        """Add a pet to the directory, once it can prove it is one.

        Membership is earned by answering, not granted by whoever deployed the
        pet: `_looks_like_a_pet` reads the candidate's own `get_state()` from
        finalized state, and an address that cannot answer that way never gets
        in. The name and owner recorded here are what the pet says about itself,
        cleaned — this contract has no other source for either.
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

        state = _looks_like_a_pet(addr)
        try:
            owner = Address(
                gl.get_contract_at(addr).view(state=StorageType.LATEST_FINAL).get_owner()
            )
        except Exception:
            raise gl.vm.UserError("that address does not answer like an AiPet")

        name = _clean(str(state.get("name", "")), MAX_NAME) or "unnamed"
        self._add(addr, name, owner)

        PetRegistered(
            addr,
            name=name,
            owner=owner.as_hex,
            total=len(self.pets),
        ).emit()

    @gl.public.write
    def set_open(self, allow: bool) -> None:
        """Admin switch: a public directory, or a curated one."""
        self._require_admin()
        self.open_to_all = allow

    # ===================== views =============================================

    @gl.public.view
    def count(self) -> int:
        return len(self.pets)

    @gl.public.view
    def get_pets(self, offset: int, limit: int) -> list:
        """The roster, straight from storage — no cross-contract calls, so cheap.

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
                "name": str(self.names[i]),
                "owner": owner.as_hex if owner is not None else "",
            })
        return rows

    @gl.public.view
    def get_leaderboard(self, offset: int, limit: int) -> list:
        """The point of the whole contract: a ranking ACROSS pets.

        Reads each listed pet live (finalized state) rather than trusting anything
        cached here — a pet's satiety and takings change constantly, and a
        directory that stored them would be wrong within the hour.

        That makes this the expensive call in the contract: one sub-VM per pet.
        Hence the page cap, and hence a pet that has stopped answering is skipped
        rather than fatal — one dead entry must not take the whole board down.

        A pet that answers but LIES must not take it down either. Every field
        here is self-reported; the numbers go through `_num` and the strings
        through `_clean`, and building the row is inside the same `try` as the
        call that fetched it, so no shape a registered contract can return is
        worse than that pet's own row looking silly.
        """
        start, end = self._page(offset, limit)
        rows = []
        for i in range(start, end):
            addr = self.pets[i]
            try:
                state = gl.get_contract_at(addr).view(
                    state=StorageType.LATEST_FINAL
                ).get_state()
                if not isinstance(state, dict):
                    continue
                rows.append({
                    "address": addr.as_hex,
                    "name": _clean(str(state.get("name", "")), MAX_NAME),
                    # normalized on the way out, so the sort below and every
                    # client can rely on this being a base-10 integer
                    "total_fed_wei": str(_num(state.get("total_fed_wei", 0))),
                    "age_days": _num(state.get("age_days", 0)),
                    "stage": _clean(str(state.get("stage", "")), MAX_NAME),
                    "alive": bool(state.get("alive", False)),
                    "mood": _num(state.get("mood", 0)),
                    "character": _clean(str(state.get("character", "")), MAX_NAME),
                })
            except Exception:
                continue
        rows.sort(key=lambda r: int(r["total_fed_wei"]), reverse=True)
        return rows

    @gl.public.view
    def is_registered(self, pet: str) -> bool:
        try:
            return self.listed.get(Address(pet)) is not None
        except Exception:
            return False

    @gl.public.view
    def get_info(self) -> dict:
        return {
            "admin": self.admin.as_hex,
            "pets": len(self.pets),
            "open_to_all": bool(self.open_to_all),
            "page_max": PAGE_MAX,
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
