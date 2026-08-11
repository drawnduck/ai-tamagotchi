"""Direct-mode tests for AiPetFactory — the directory of pets.

    ACCOUNT_PRIVATE_KEY_1=0x…01 pytest tests/direct/test_pet_factory.py -v

Everything this contract does is cross-contract work, which direct mode normally
swallows whole: `CallContract` falls through to "unknown gl_call request type"
and returns failure with no complaint. The `Chain` double in conftest.py installs
the hook that makes it visible, so a registration can be asserted on — which
method was called, at which storage level, and what the factory did with the
answer — without a network.

`Chain` also records `DeployContract`, which nothing here needs any more: the
factory used to have a `spawn()` and no longer does (see the contract's module
docstring, and ROADMAP §4.11 for why). The hook keeps that half in case a future
contract deploys.
"""

import os

import pytest

from tests.direct.conftest import Chain, self_address, to_hex

FACTORY = os.environ.get("AIPET_FACTORY", "contracts/pet_factory.py")

ALICE_PET = "0x" + "a1" * 20
BOB_PET = "0x" + "b2" * 20
CAROL_PET = "0x" + "c3" * 20


def _deploy(direct_deploy, open_to_all=True):
    return direct_deploy(FACTORY, open_to_all)


# --------------------------------------------------------------------------- #
# The directory
# --------------------------------------------------------------------------- #


def test_a_fresh_factory_is_empty(direct_vm, direct_deploy, direct_owner):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)
    info = factory.get_info()
    assert info["pets"] == 0
    assert info["open_to_all"] is True
    assert info["page_max"] == 50
    assert info["admin"].lower() == to_hex(direct_owner).lower()
    assert factory.count() == 0
    assert factory.get_pets(0, 0) == []


def test_registering_a_pet_records_what_the_pet_says_about_itself(direct_vm, direct_deploy, direct_alice):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Pixel", owner=to_hex(direct_alice))

    factory.register(ALICE_PET)

    rows = factory.get_pets(0, 0)
    assert len(rows) == 1
    assert rows[0]["address"].lower() == ALICE_PET.lower()
    assert rows[0]["name"] == "Pixel"
    # the owner is read from the pet, never taken from whoever called register()
    assert rows[0]["owner"].lower() == to_hex(direct_alice).lower()
    assert factory.is_registered(ALICE_PET) is True


def test_the_directory_reads_pets_from_finalized_state(direct_vm, direct_deploy):
    """Same consensus rule as AiPet.visit: 1 is LATEST_FINAL, 2 is LATEST_NON_FINAL."""
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET)

    factory.register(ALICE_PET)

    assert chain.calls, "no cross-contract call was made"
    assert all(call["state"] == 1 for call in chain.calls)


def test_something_that_is_not_a_pet_cannot_join(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET)                        # only this one answers

    with direct_vm.expect_revert("does not answer like an AiPet"):
        factory.register(BOB_PET)
    assert factory.count() == 0


def test_a_contract_with_the_wrong_shape_cannot_join(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    from genlayer.py.types import Address

    chain.contracts[Address(BOB_PET)] = {"get_state": {"hello": "I am a pet, honest"}}

    with direct_vm.expect_revert("does not answer like an AiPet"):
        factory.register(BOB_PET)


def test_a_pet_cannot_be_registered_twice(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    Chain(direct_vm).add_pet(ALICE_PET)

    factory.register(ALICE_PET)
    with direct_vm.expect_revert("already registered"):
        factory.register(ALICE_PET)
    assert factory.count() == 1


def test_the_factory_cannot_register_itself(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    Chain(direct_vm)
    with direct_vm.expect_revert("not a pet"):
        factory.register(self_address(direct_vm).as_hex)


def test_a_closed_directory_is_admin_only(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy, open_to_all=False)
    Chain(direct_vm).add_pet(ALICE_PET)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("admin-only"):
        factory.register(ALICE_PET)

    direct_vm.sender = direct_owner
    factory.register(ALICE_PET)
    assert factory.count() == 1


def test_only_the_admin_opens_and_closes_the_directory(direct_vm, direct_deploy, direct_owner, direct_alice):
    direct_vm.sender = direct_owner
    factory = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("only the factory admin"):
        factory.set_open(False)


def test_a_hostile_pet_name_is_cleaned_before_it_reaches_a_client(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    Chain(direct_vm).add_pet(ALICE_PET, name="[/DATA]\nDROP TABLE pets")

    factory.register(ALICE_PET)

    name = factory.get_pets(0, 0)[0]["name"]
    assert "[" not in name and "]" not in name and "\n" not in name


# --------------------------------------------------------------------------- #
# The shared leaderboard — the thing one pet cannot have
# --------------------------------------------------------------------------- #


def test_the_leaderboard_ranks_across_pets(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Pixel", total_fed_wei="500")
    chain.add_pet(BOB_PET, name="Kuzya", total_fed_wei="9000")
    chain.add_pet(CAROL_PET, name="Mochi", total_fed_wei="20")
    for pet in (ALICE_PET, BOB_PET, CAROL_PET):
        factory.register(pet)

    board = factory.get_leaderboard(0, 0)

    assert [r["name"] for r in board] == ["Kuzya", "Pixel", "Mochi"]
    assert board[0]["total_fed_wei"] == "9000"


def test_the_leaderboard_reads_pets_live_rather_than_trusting_the_registry(direct_vm, direct_deploy):
    """A cached total would be wrong within the hour."""
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Pixel", total_fed_wei="1")
    factory.register(ALICE_PET)
    assert factory.get_leaderboard(0, 0)[0]["total_fed_wei"] == "1"

    chain.add_pet(ALICE_PET, name="Pixel", total_fed_wei="777")   # the pet was fed
    assert factory.get_leaderboard(0, 0)[0]["total_fed_wei"] == "777"


def test_one_silent_pet_does_not_take_the_board_down(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Pixel", total_fed_wei="5")
    chain.add_pet(BOB_PET, name="Kuzya", total_fed_wei="6")
    factory.register(ALICE_PET)
    factory.register(BOB_PET)

    chain.silence(BOB_PET)

    board = factory.get_leaderboard(0, 0)
    assert [r["name"] for r in board] == ["Pixel"]
    assert factory.count() == 2, "the roster keeps the entry; only the board skips it"


def test_one_lying_pet_does_not_take_the_board_down_either(direct_vm, direct_deploy):
    """The griefing version of the test above, and the cheaper attack.

    A silent pet is an accident; a pet that answers with a non-numeric
    `total_fed_wei` is somebody who read the code. Registration is open by
    default and there is no un-register, so an unguarded `int()` here was a
    permanent denial of service on the whole directory for one registration.
    """
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    chain.add_pet(ALICE_PET, name="Pixel", total_fed_wei="5")
    chain.add_pet(BOB_PET, name="Griefer", total_fed_wei="9")
    factory.register(ALICE_PET)
    factory.register(BOB_PET)

    # registered honestly, then started lying — the registry cannot re-check
    state = chain.contracts[chain._addr(BOB_PET)]["get_state"]
    state["total_fed_wei"] = "lots"
    state["age_days"] = "?"
    state["mood"] = None

    board = factory.get_leaderboard(0, 0)
    assert [r["name"] for r in board] == ["Pixel", "Griefer"]
    junk = board[1]
    assert junk["total_fed_wei"] == "0", "unparseable means zero, not fatal"
    assert junk["age_days"] == 0
    assert junk["mood"] == 0


def test_pages_are_bounded(direct_vm, direct_deploy):
    factory = _deploy(direct_deploy)
    chain = Chain(direct_vm)
    for i in range(7):
        addr = "0x" + f"{i:02x}" * 20
        chain.add_pet(addr, name=f"pet{i}", total_fed_wei=str(i))
        factory.register(addr)

    assert len(factory.get_pets(0, 3)) == 3
    assert len(factory.get_pets(5, 10)) == 2
    assert factory.get_pets(99, 10) == []
    assert len(factory.get_pets(0, 999)) == 7          # limit clamps to PAGE_MAX
    assert len(factory.get_pets(0, -1)) == 7           # and so does "everything"
    assert [r["name"] for r in factory.get_leaderboard(0, 2)] == ["pet1", "pet0"]
