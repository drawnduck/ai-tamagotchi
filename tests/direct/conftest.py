"""Shared helpers for direct-mode tests.

The direct-mode fixtures themselves (direct_vm, direct_deploy, direct_owner,
direct_alice, direct_bob, ...) are provided by the `genlayer-test` pytest
plugin — they are NOT defined here.
"""

from datetime import datetime, timedelta, timezone

# Fixed base so every time-dependent test is reproducible. direct_vm.warp()
# patches datetime.now(), which is exactly what the contract's _now() reads.
BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def warp_hours(vm, hours):
    """Move block time to BASE + `hours`. Call before deploy to pin birth_ts."""
    vm.warp((BASE + timedelta(hours=hours)).isoformat().replace("+00:00", "Z"))


def warp_days(vm, days):
    warp_hours(vm, days * 24)


def warp_seconds(vm, seconds):
    """Move block time by real seconds — for time_scale'd demo pets."""
    vm.warp((BASE + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z"))


def self_address(vm):
    """The deployed contract's own address (what gl.message.contract_address is)."""
    from genlayer.py.types import Address

    return Address(vm._contract_address)


class Neighbour:
    """A stand-in for a second pet, for the cross-contract calls in visit().

    WHY THIS EXISTS. Direct mode hands `DeployContract` / `CallContract` /
    `PostMessage` to an optional hook and, when none is installed, just traces
    "Unknown gl_call request type" and returns failure. That silence is exactly
    how a `withdraw()` that paid nobody survived 27 green tests. Installing a
    hook turns both halves of a visit into something a test can assert on:

      * `CallContract`  -> answers `get_state()` with `self.state`, so the
        contract's view of a neighbour is real data with a real shape;
      * `PostMessage`   -> appended to `self.messages` instead of vanishing, so a
        test can prove the greeting was actually sent, to whom, and with what.

    It is still a double, not a second GenVM: nothing here executes the other
    pet's code. Two real pets talking is proved in tests/network/.

        nb = Neighbour(vm, address, name="Kuzya")
        pet.visit(nb.address_hex)
        assert nb.messages[0]["calldata"]["method"] == "receive_visit"
    """

    def __init__(self, vm, address, **state):
        from genlayer.py.types import Address

        self.address = address if isinstance(address, Address) else Address(address)
        self.messages = []
        self.calls = []
        self.state = {
            "name": "Neighbour",
            "persona": "a quiet pet next door",
            "city": "Lisbon",
            "satiety": 70,
            "mood": 70,
            "health": 100,
            "age_days": 4,
            "stage": "kitten",
            "alive": True,
            "last_quote": "",
        }
        self.state.update(state)
        # `answers` lets a test override any view method by name; anything not
        # listed falls through to `state` for get_state, and to None otherwise.
        self.answers = {}
        vm._gl_call_hook = self._hook

    @property
    def address_hex(self):
        return self.address.as_hex

    def _hook(self, vm, request):
        from genlayer.py import calldata
        from genlayer.py.public_abi import ResultCode

        if "CallContract" in request:
            req = request["CallContract"]
            self.calls.append(req)
            if req["address"] != self.address:
                # not our neighbour: behave like a call into empty space
                return bytes([ResultCode.USER_ERROR]) + b"no contract at address"
            method = req["calldata"].get("method")
            if method in self.answers:
                value = self.answers[method]
            elif method == "get_state":
                value = self.state
            else:
                return bytes([ResultCode.USER_ERROR]) + f"no method {method}".encode()
            return bytes([ResultCode.RETURN]) + calldata.encode(value)

        if "PostMessage" in request:
            self.messages.append(request["PostMessage"])
            return {"ok": None}

        return None


class Chain:
    """Several other contracts, for code that talks to more than one.

    The same direct-mode hook `Neighbour` uses (see there for why installing it
    matters), but keyed by address and with `DeployContract` recorded too — which
    is what makes the factory testable offline at all: a spawn is a deploy message
    plus bookkeeping, and without the hook both halves vanish silently.

        chain = Chain(vm)
        pixel = chain.add_pet("0x…", name="Pixel", total_fed_wei="5")
        factory.register(pixel.as_hex)
        assert chain.deploys[0]["salt_nonce"] == 1
    """

    def __init__(self, vm):
        self.vm = vm
        self.contracts = {}      # Address -> {method: value}
        self.deploys = []
        self.messages = []
        self.calls = []
        vm._gl_call_hook = self._hook

    def _addr(self, address):
        from genlayer.py.types import Address

        return address if isinstance(address, Address) else Address(address)

    def add_pet(self, address, **state):
        """Register a pretend AiPet that answers get_state()/get_owner()."""
        addr = self._addr(address)
        owner = state.pop("owner", None)
        full = {
            "name": "Neighbour",
            "persona": "a quiet pet next door",
            "city": "Lisbon",
            "satiety": 70,
            "mood": 70,
            "health": 100,
            "age_days": 4,
            "stage": "kitten",
            "alive": True,
            "last_quote": "",
            "total_fed_wei": "0",
            "character": "",
        }
        full.update(state)
        self.contracts[addr] = {
            "get_state": full,
            "get_owner": (self._addr(owner).as_hex if owner is not None else addr.as_hex),
        }
        return addr

    def silence(self, address):
        """Make an address stop answering, the way a broken contract would."""
        self.contracts.pop(self._addr(address), None)

    def _hook(self, vm, request):
        from genlayer.py import calldata
        from genlayer.py.public_abi import ResultCode

        if "CallContract" in request:
            req = request["CallContract"]
            self.calls.append(req)
            answers = self.contracts.get(req["address"])
            method = req["calldata"].get("method")
            if answers is None or method not in answers:
                return bytes([ResultCode.USER_ERROR]) + b"no contract at address"
            return bytes([ResultCode.RETURN]) + calldata.encode(answers[method])

        if "DeployContract" in request:
            self.deploys.append(request["DeployContract"])
            return {"ok": None}

        if "PostMessage" in request:
            self.messages.append(request["PostMessage"])
            return {"ok": None}

        return None


def to_plain_hex(addr):
    """Lowercase 0x… for an address, WITHOUT needing the SDK on sys.path.

    `to_hex` produces the EIP-55 checksummed form the contract returns, but it
    imports the GenLayer SDK, which only exists after the first direct_deploy.
    Constructor arguments have to be built before that — and `Address()` accepts
    an unchecksummed hex string, so this is enough for passing one in.
    """
    raw = bytes(addr.as_bytes if hasattr(addr, "as_bytes") else addr)
    return "0x" + raw.hex()


def to_hex(addr_bytes):
    """Convert a test address (raw bytes or Address) to EIP-55 checksummed hex.

    Matches what the contract returns via Address.as_hex. Call after
    direct_deploy so the GenLayer SDK is on sys.path.
    """
    if hasattr(addr_bytes, "as_hex"):
        return addr_bytes.as_hex
    from genlayer.py.types import Address

    return Address(addr_bytes).as_hex
