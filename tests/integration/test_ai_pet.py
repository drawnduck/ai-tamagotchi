"""SUPERSEDED — do not trust this file as coverage. See tests/network/aiPet.test.mjs.

    ⚠️  These tests have never executed, anywhere, and currently cannot.

`gltest 0.29.2` builds its contract wrapper via the RPC method
`gen_getContractSchemaForCode`, which Testnet Bradbury answers with
`-32601 method not found`; `gen_getContractSchema` returns
`VMError: invalid_contract absent_runner_comment`. Localnet would work but needs
Docker. Three further version-drift breakages are already shimmed in conftest.py
(ROADMAP §3b) — the schema one cannot be shimmed.

The coverage moved to **`tests/network/aiPet.test.mjs`** (`npm run test:network`),
written against `genlayer-js`, which does drive Bradbury. That suite also fixes a
wrong assertion carried here: `test_withdraw_moves_food_money_to_the_owner` expects
the contract balance to drop as soon as `withdraw()` succeeds. It does not — the
payout is a message consensus dispatches at FINALIZED, roughly half an hour later —
so this test would fail even on a perfectly healthy network.

Kept rather than deleted because this project is not under version control; if the
Python tooling catches up it is a useful starting point. Until then it is a
historical artifact, not a safety net.

Original header follows.
--------------------------------------------------------------------------------
Integration tests for AiPet — require a running GenLayer node.

    gltest tests/integration/ -v -s --network localnet
    # or --network studionet / --network testnet_bradbury

These run the FULL flow against a real node: check() hits the real open-meteo
API and a real LLM. Assertions are therefore tolerant — we check structure and
the *direction* of state changes, not exact reply text (the LLM is non-det).
"""

import pytest

from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded

CTOR = ["Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon"]

# real LLM/web calls are slow — give consensus room to finalize
WAIT = {"wait_interval": 10000, "wait_retries": 30}


def _deploy():
    factory = get_contract_factory("AiPet")
    return factory.deploy(args=CTOR)


@pytest.mark.integration
def test_initial_state():
    pet = _deploy()
    s = pet.get_state(args=[])
    assert s["name"] == "Pixel"
    assert int(s["satiety"]) == 70
    assert int(s["mood"]) == 70
    assert int(s["health"]) == 100


@pytest.mark.integration
def test_check_reads_world_and_speaks():
    pet = _deploy()
    receipt = pet.check(args=[], **WAIT)
    assert tx_execution_succeeded(receipt)
    s = pet.get_state(args=[])
    assert len(s["last_quote"]) > 0          # the pet actually said something
    assert len(pet.get_history(args=[])) == 1


@pytest.mark.integration
def test_play_costs_satiety():
    pet = _deploy()
    before = int(pet.get_state(args=[])["satiety"])
    receipt = pet.play(args=[], **WAIT)
    assert tx_execution_succeeded(receipt)
    after = int(pet.get_state(args=[])["satiety"])
    assert after < before                     # playing burns satiety


@pytest.mark.integration
def test_feed_accepts_value_and_grows_satiety():
    # NOTE: passing `value` (wei) on a payable method may need to match your
    # installed gltest version's signature — adjust if it differs.
    pet = _deploy()
    receipt = pet.feed(args=[], value=10 ** 17, **WAIT)   # 0.1 GEN
    assert tx_execution_succeeded(receipt)
    s = pet.get_state(args=[])
    assert int(s["total_fed_wei"]) >= 10 ** 17
    assert int(s["satiety"]) >= 70            # fed -> satiety did not drop


@pytest.mark.integration
def test_fresh_pet_is_alive_and_an_egg():
    pet = _deploy()
    s = pet.get_state(args=[])
    assert s["alive"] is True
    assert s["stage"] == "egg"                # a pet born today is 0 days old
    assert int(s["revives"]) == 0


@pytest.mark.integration
def test_feeding_builds_the_leaderboard():
    pet = _deploy()
    assert pet.get_top_feeders(args=[0]) == []
    assert tx_execution_succeeded(pet.feed(args=[], value=10 ** 17, **WAIT))
    board = pet.get_top_feeders(args=[0])
    assert len(board) == 1
    assert int(board[0]["wei"]) >= 10 ** 17


@pytest.mark.integration
def test_cannot_revive_a_living_pet():
    pet = _deploy()
    receipt = pet.revive(args=[], value=10 ** 18, **WAIT)
    assert not tx_execution_succeeded(receipt)   # guard: it is not dead


@pytest.mark.integration
def test_withdraw_moves_food_money_to_the_owner():
    """The one thing direct mode CANNOT prove: emit_transfer actually pays out.

    In direct mode PostMessage has no handler, so withdraw() is a silent no-op
    there (see the note in tests/direct/test_ai_pet.py). Only a real node
    settles the transfer, which is why this assertion lives here.
    """
    pet = _deploy()
    assert tx_execution_succeeded(pet.feed(args=[], value=5 * 10 ** 17, **WAIT))
    held = int(pet.get_balance(args=[]))
    assert held >= 5 * 10 ** 17               # the contract is holding the food money

    assert tx_execution_succeeded(pet.withdraw(args=[10 ** 17], **WAIT))
    assert int(pet.get_balance(args=[])) == held - 10 ** 17
