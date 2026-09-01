"""Direct-mode tests for AiPetFactory — the directory of pets.

    ACCOUNT_PRIVATE_KEY_1=0x…01 pytest tests/direct/test_pet_factory.py -v

The 2026-08-27 redesign changed what this contract trusts, and the tests follow:

* `register()` no longer reads the candidate at all — it fetches the candidate's
  CODE from the network's RPC inside `strict_eq` and checks its sha256 against
  an allowlist of known builds. Here the RPC is `mock_web` (strict_eq + mock_web
  works in direct mode under genlayer-test 0.29.x); the fetch goes to one URL
  regardless of candidate, so tests set exactly the response the next register
  should see and `clear_mocks()` between candidates.
* the board lives in factory storage: pets push rows through `report()` (the
  sender IS the authentication, so tests set `direct_vm.sender` to the pet's
  address), and `refresh()` is the one remaining cross-contract read — the
  `Chain` double in conftest.py makes it visible, as before.
* `get_leaderboard` sorts the FULL set and pages AFTER sorting — the regression
  tests pin exactly the bug the GenLayer team called out (a page used to be
  sliced from the roster first and sorted within itself).
"""

import base64
import hashlib
import json
import os

import pytest

from tests.direct.conftest import Chain, self_address, to_hex

FACTORY = os.environ.get("AIPET_FACTORY", "contracts/pet_factory.py")

ALICE_PET = "0x" + "a1" * 20
BOB_PET = "0x" + "b2" * 20
CAROL_PET = "0x" + "c3" * 20
DAVE_PET = "0x" + "d4" * 20

# Two "released builds": what the mocked RPC serves, and what the allowlist holds.
PET_CODE = b"# { Depends: py-genlayer:test }\nclass AiPet: ...\n"
OLD_PET_CODE = b"# { Depends: py-genlayer:test }\nclass AiPet: ...  # v1\n"
FP = hashlib.sha256(PET_CODE).hexdigest()
OLD_FP = hashlib.sha256(OLD_PET_CODE).hexdigest()
IMPOSTOR_CODE = b"class AiPet:  # looks right, hashes wrong\n    pass\n"

RPC_PATTERN = r".*rpc-bradbury\.genlayer\.com.*"


def _rpc_serves(vm, code=PET_CODE):
    """The next register() sees a network that stores `code` at the candidate."""
    vm.clear_mocks()
    vm.mock_web(RPC_PATTERN, {
        "method": "POST",
        "status": 200,
        "body": json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "result": base64.b64encode(code).decode(),
        }).encode("utf-8"),
    })


def _rpc_serves_nothing(vm):
    """…a network that has no contract at the candidate (EOA, typo, nothing)."""
    vm.clear_mocks()
    vm.mock_web(RPC_PATTERN, {
        "method": "POST",
        "status": 200,
        "body": json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "error": {"code": -32001, "message": "contract code not found at address"},
        }).encode("utf-8"),
    })


def _deploy(direct_deploy, open_to_all=True):
    return direct_deploy(FACTORY, open_to_all)


def _deploy_with_build(direct_vm, direct_deploy, direct_owner, open_to_all=True):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy, open_to_all)
    factory.add_fingerprint(FP)
    return factory


def _register(direct_vm, factory, pet, code=PET_CODE):
    _rpc_serves(direct_vm, code)
    factory.register(pet)


def _report(direct_vm, factory, pet, *, name="Pixel", owner=None, fed=0,
            age=0, stage="egg", alive=True, mood=70, character=""):
    """A pet pushes its row: the sender is the pet's own contract address."""
    from genlayer.py.types import Address

    prev = direct_vm.sender
    direct_vm.sender = Address(pet)
    factory.report(name, owner if owner is not None else pet,
                   fed, age, stage, alive, mood, character)
    direct_vm.sender = prev


# --------------------------------------------------------------------------- #
# Membership: the code decides, nothing else
# --------------------------------------------------------------------------- #


def test_a_fresh_factory_is_empty(direct_vm, direct_deploy, direct_owner):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)
    info = factory.get_info()
    assert info["pets"] == 0
    assert info["open_to_all"] is True
    assert info["page_max"] == 50
    assert info["rpc_url"].startswith("https://")
    assert info["admin"].lower() == to_hex(direct_owner).lower()
    assert factory.count() == 0
    assert factory.get_pets(0, 0) == []


def test_a_known_build_registers_and_its_fingerprint_is_recorded(
        direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)

    _register(direct_vm, factory, ALICE_PET)

    assert factory.is_registered(ALICE_PET) is True
    assert factory.get_fingerprint(ALICE_PET) == FP
    assert factory.count() == 1
    # the row starts empty — report()/refresh() fill it, registration never does
    rows = factory.get_pets(0, 0)
    assert rows[0]["address"].lower() == ALICE_PET.lower()
    assert rows[0]["name"] == ""
    assert rows[0]["owner"] == ""


def test_an_impostor_with_the_right_shape_but_wrong_code_cannot_join(
        direct_vm, direct_deploy, direct_owner):
    """THE test of the redesign: shape no longer matters, only the code hash."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)

    _rpc_serves(direct_vm, IMPOSTOR_CODE)
    with direct_vm.expect_revert("not a known AiPet build"):
        factory.register(BOB_PET)
    assert factory.count() == 0
    assert factory.get_fingerprint(BOB_PET) == ""


def test_an_address_with_no_code_gets_a_civil_refusal(
        direct_vm, direct_deploy, direct_owner):
    """The old shape test aborted un-catchably on an EOA. This is a UserError."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)

    _rpc_serves_nothing(direct_vm)
    with direct_vm.expect_revert("no contract code at that address"):
        factory.register(BOB_PET)


def test_a_pet_cannot_be_registered_twice(direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)

    _rpc_serves(direct_vm)
    with direct_vm.expect_revert("already registered"):
        factory.register(ALICE_PET)
    assert factory.count() == 1


def test_the_factory_cannot_register_itself(direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    with direct_vm.expect_revert("not a pet"):
        factory.register(self_address(direct_vm).as_hex)


def test_a_closed_directory_is_admin_only(
        direct_vm, direct_deploy, direct_owner, direct_alice):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner,
                                 open_to_all=False)

    direct_vm.sender = direct_alice
    _rpc_serves(direct_vm)
    with direct_vm.expect_revert("admin-only"):
        factory.register(ALICE_PET)

    direct_vm.sender = direct_owner
    _register(direct_vm, factory, ALICE_PET)
    assert factory.count() == 1


def test_two_builds_can_be_current_at_once(direct_vm, direct_deploy, direct_owner):
    """Old pets run old artifacts; the allowlist holds every released build."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    factory.add_fingerprint(OLD_FP)

    _register(direct_vm, factory, ALICE_PET, code=PET_CODE)
    _register(direct_vm, factory, BOB_PET, code=OLD_PET_CODE)

    assert factory.get_fingerprint(ALICE_PET) == FP
    assert factory.get_fingerprint(BOB_PET) == OLD_FP


def test_retiring_a_build_stops_new_registrations_not_old_members(
        direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)

    factory.remove_fingerprint(FP)
    assert factory.is_known_build(FP) is False

    _rpc_serves(direct_vm)
    with direct_vm.expect_revert("not a known AiPet build"):
        factory.register(BOB_PET)
    # Alice keeps her membership and her recorded build
    assert factory.is_registered(ALICE_PET) is True
    assert factory.get_fingerprint(ALICE_PET) == FP


# --------------------------------------------------------------------------- #
# Admin surface
# --------------------------------------------------------------------------- #


def test_only_the_admin_manages_fingerprints_and_the_rpc(
        direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("only the factory admin"):
        factory.add_fingerprint(FP)
    with direct_vm.expect_revert("only the factory admin"):
        factory.remove_fingerprint(FP)
    with direct_vm.expect_revert("only the factory admin"):
        factory.set_rpc("https://example.org")
    with direct_vm.expect_revert("only the factory admin"):
        factory.set_open(False)


def test_a_fingerprint_must_be_sha256_shaped(direct_vm, direct_deploy, direct_owner):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)

    with direct_vm.expect_revert("64 hex chars"):
        factory.add_fingerprint("deadbeef")
    with direct_vm.expect_revert("64 hex chars"):
        factory.add_fingerprint("g" * 64)
    # 0x prefix and case are forgiven — sha256sum output pastes straight in
    factory.add_fingerprint("0x" + FP.upper())
    assert factory.is_known_build(FP) is True
    assert factory.is_known_build("0x" + FP.upper()) is True


def test_the_rpc_must_be_https(direct_vm, direct_deploy, direct_owner):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)
    with direct_vm.expect_revert("https"):
        factory.set_rpc("http://rpc.evil.example")
    factory.set_rpc("https://rpc.example.org")
    assert factory.get_info()["rpc_url"] == "https://rpc.example.org"


# --------------------------------------------------------------------------- #
# The board: push (report), pull (refresh)
# --------------------------------------------------------------------------- #


def test_a_registered_pet_reports_its_own_row(
        direct_vm, direct_deploy, direct_owner, direct_alice):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)

    _report(direct_vm, factory, ALICE_PET, name="Pixel",
            owner=to_hex(direct_alice), fed=5 * 10**16, age=4,
            stage="kitten", alive=True, mood=88, character="a little curious")

    row = factory.get_leaderboard(0, 0)[0]
    assert row["address"].lower() == ALICE_PET.lower()
    assert row["name"] == "Pixel"
    assert row["owner"].lower() == to_hex(direct_alice).lower()
    assert row["total_fed_wei"] == str(5 * 10**16)
    assert row["age_days"] == 4
    assert row["stage"] == "kitten"
    assert row["alive"] is True
    assert row["mood"] == 88
    assert row["character"] == "a little curious"
    assert row["fingerprint"] == FP


def test_only_registered_pets_may_report(direct_vm, direct_deploy, direct_owner):
    """The sender is the authentication — and membership is the authorization."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)

    from genlayer.py.types import Address

    direct_vm.sender = Address(BOB_PET)
    with direct_vm.expect_revert("only registered pets"):
        factory.report("Impostor", BOB_PET, 10**30, 0, "egg", True, 70, "")


def test_a_report_cannot_speak_for_another_pet(
        direct_vm, direct_deploy, direct_owner):
    """report() has no pet argument at all: the row written is the SENDER's."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)
    _register(direct_vm, factory, BOB_PET)

    _report(direct_vm, factory, BOB_PET, name="Bob", fed=7)

    by_addr = {r["address"].lower(): r for r in factory.get_leaderboard(0, 0)}
    assert by_addr[BOB_PET.lower()]["total_fed_wei"] == "7"
    assert by_addr[ALICE_PET.lower()]["total_fed_wei"] == "0"


def test_a_hostile_report_degrades_to_a_silly_row_not_a_broken_board(
        direct_vm, direct_deploy, direct_owner):
    """§3c still holds: sanitize every field, even from a code-verified pet."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)

    from genlayer.py.types import Address

    direct_vm.sender = Address(ALICE_PET)
    factory.report("<b>[pwned]</b>\nX", "not-an-address", -5, -1,
                   "y" * 300, True, 100000, "z" * 300)
    direct_vm.sender = direct_owner

    row = factory.get_leaderboard(0, 0)[0]
    assert "<" not in row["name"] and "\n" not in row["name"]
    assert row["owner"] == ""             # junk owner is dropped, row survives
    assert row["total_fed_wei"] == "0"    # negative numbers count as absent
    assert row["age_days"] == 0
    assert len(row["stage"]) <= 64
    assert row["mood"] == 100             # clamped to the meter's ceiling
    assert len(row["character"]) <= 64
    # and the board itself still answers
    assert len(factory.get_leaderboard(0, 0)) == 1


def test_refresh_pulls_a_row_live_from_finalized_state(
        direct_vm, direct_deploy, direct_owner, direct_alice):
    """The pull half, for pets built before report() existed."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)

    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Old-Timer", total_fed_wei=str(3 * 10**16),
                  age_days=30, stage="cat", mood=61, character="grumpy",
                  owner=to_hex(direct_alice))

    factory.refresh(ALICE_PET)

    assert [c["calldata"]["method"] for c in chain.calls] == ["get_state", "get_owner"]
    assert all(call["state"] == 1 for call in chain.calls)   # 1 = LATEST_FINAL
    row = factory.get_leaderboard(0, 0)[0]
    assert row["name"] == "Old-Timer"
    assert row["owner"].lower() == to_hex(direct_alice).lower()
    assert row["total_fed_wei"] == str(3 * 10**16)
    assert row["age_days"] == 30


def test_refresh_is_for_members_only(direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    Chain(direct_vm).add_pet(BOB_PET)
    with direct_vm.expect_revert("not a registered pet"):
        factory.refresh(BOB_PET)


# --------------------------------------------------------------------------- #
# The leaderboard: full-set ranking, pages cut AFTER sorting
# --------------------------------------------------------------------------- #


def _board_of_four(direct_vm, direct_deploy, direct_owner):
    """Registration order deliberately disagrees with rank order."""
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    for pet, fed in [(ALICE_PET, 10), (BOB_PET, 40), (CAROL_PET, 20), (DAVE_PET, 30)]:
        _register(direct_vm, factory, pet)
        _report(direct_vm, factory, pet, name=pet[:6], fed=fed)
    return factory


def test_the_ranking_covers_the_full_set_not_the_requested_page(
        direct_vm, direct_deploy, direct_owner):
    """THE regression test for the second team finding. The champion (Bob,
    registered second) must lead page 1, and a page is a slice of the GLOBAL
    ranking — the old code sliced the roster first and sorted within it."""
    factory = _board_of_four(direct_vm, direct_deploy, direct_owner)

    fed = [r["total_fed_wei"] for r in factory.get_leaderboard(0, 0)]
    assert fed == ["40", "30", "20", "10"]

    page1 = factory.get_leaderboard(0, 2)
    page2 = factory.get_leaderboard(2, 2)
    assert [r["total_fed_wei"] for r in page1] == ["40", "30"]
    assert [r["total_fed_wei"] for r in page2] == ["20", "10"]
    assert page1[0]["address"].lower() == BOB_PET.lower()


def test_ties_rank_in_registration_order_and_never_flap(
        direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    for pet in (ALICE_PET, BOB_PET, CAROL_PET):
        _register(direct_vm, factory, pet)
        _report(direct_vm, factory, pet, fed=5)

    order = [r["address"].lower() for r in factory.get_leaderboard(0, 0)]
    assert order == [ALICE_PET.lower(), BOB_PET.lower(), CAROL_PET.lower()]
    assert order == [r["address"].lower() for r in factory.get_leaderboard(0, 0)]


def test_a_member_that_never_reported_is_a_zero_row_not_a_missing_one(
        direct_vm, direct_deploy, direct_owner):
    factory = _deploy_with_build(direct_vm, direct_deploy, direct_owner)
    _register(direct_vm, factory, ALICE_PET)
    _register(direct_vm, factory, BOB_PET)
    _report(direct_vm, factory, BOB_PET, fed=1)

    rows = factory.get_leaderboard(0, 0)
    assert len(rows) == 2
    assert rows[0]["address"].lower() == BOB_PET.lower()
    assert rows[1]["address"].lower() == ALICE_PET.lower()
    assert rows[1]["total_fed_wei"] == "0"


def test_paging_is_clamped_and_never_errors(direct_vm, direct_deploy, direct_owner):
    factory = _board_of_four(direct_vm, direct_deploy, direct_owner)
    assert factory.get_leaderboard(100, 10) == []
    assert factory.get_leaderboard(-5, 2) == factory.get_leaderboard(0, 2)
    assert len(factory.get_leaderboard(0, -1)) == 4
    assert len(factory.get_pets(3, 0)) == 1
