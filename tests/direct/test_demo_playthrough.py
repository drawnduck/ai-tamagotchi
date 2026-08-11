"""A narrated end-to-end demo of AiPet, runnable in seconds with no Docker/network.

    ACCOUNT_PRIVATE_KEY_1=0x00..01 pytest tests/direct/test_demo_playthrough.py -s

Runs the contract in the real GenVM runtime. The weather and the LLM lines are
MOCKED here for a deterministic playthrough — on Studio / a real node the weather
comes from the live web and the lines from a real LLM. It also asserts the key
state transitions, so it doubles as a test (silent without -s).
"""

import json

from tests.direct.conftest import warp_hours

CONTRACT = "contracts/ai_pet.py"
CTOR = ("Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon")
GEN = 10 ** 18


def _show(step, pet):
    s = pet.get_state()
    grave = "" if s["alive"] else "  💀 DEAD"
    print(f"\n=== {step} ==={grave}")
    print(f'  🐾 "{s["last_quote"]}"')
    print(f'  satiety {s["satiety"]:>3} | mood {s["mood"]:>3} | health {s["health"]:>3} '
          f'| {s["stage"]} {s["age_days"]}d | fed {int(s["total_fed_wei"]) / GEN:.3f} GEN')


def test_demo(direct_vm, direct_deploy):
    warp_hours(direct_vm, 0)
    print("\n" + "=" * 56)
    print(" AiPet demo — Pixel, a sleepy philosopher cat in Lisbon")
    print(" (weather + LLM lines are mocked for a deterministic run)")
    print("=" * 56)

    pet = direct_deploy(CONTRACT, *CTOR)
    _show("birth (deploy)", pet)
    assert int(pet.get_state()["mood"]) == 70

    # --- check(): reads the world (mock: rain in Lisbon) and speaks ---
    direct_vm.mock_web(
        r".*geocoding-api\.open-meteo\.com.*",
        {"status": 200, "body": json.dumps({"results": [{"latitude": 38.7, "longitude": -9.1}]}).encode()},
    )
    direct_vm.mock_web(
        r".*api\.open-meteo\.com/v1/forecast.*",
        {"status": 200, "body": json.dumps({"current": {"temperature_2m": 14.0, "weather_code": 61}}).encode()},
    )
    direct_vm.mock_llm(r".*", json.dumps(
        {"quote": "It rains in Lisbon, just like in my soul. Feed me, mortal.", "mood_delta": -1}))
    pet.check()
    _show("check()  — rain drags the mood down", pet)
    assert int(pet.get_state()["mood"]) == 66          # 70 -3 (rain) -1 (delta)

    # --- feed(): send 0.5 GEN ---
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", json.dumps(
        {"quote": "Sustenance. The void in my stomach recedes, briefly.", "mood_delta": 2}))
    direct_vm.value = 5 * 10 ** 17                       # 0.5 GEN
    pet.feed()
    direct_vm.value = 0
    _show("feed()  — 0.5 GEN, satiety + mood up", pet)
    assert int(pet.get_state()["total_fed_wei"]) == 5 * 10 ** 17
    assert int(pet.get_state()["satiety"]) == 100        # 70 + clamp(50) cap

    # --- play(): mood up, satiety down ---
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", json.dumps(
        {"quote": "A chase! For a moment I forget I am made of state and storage.", "mood_delta": 1}))
    pet.play()
    _show("play()  — fun, but it burns satiety", pet)

    # --- pet(): a gentle boost ---
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", json.dumps(
        {"quote": "Mmm. You may continue.", "mood_delta": 1}))
    pet.pet()
    _show("pet()   — a content purr", pet)

    # --- neglect: nobody shows up for ~6 days and the pet starves to death ---
    direct_vm.clear_mocks()
    warp_hours(direct_vm, 150)
    pet.pet()                                            # the visit that arrives too late
    _show("neglect — 150 h without a visit", pet)
    assert pet.get_state()["alive"] is False
    assert int(pet.get_state()["health"]) == 0

    # a dead pet refuses everything until someone pays
    with direct_vm.expect_revert("pet is dead"):
        pet.play()

    # --- revive(): 1 GEN brings it back, weakened ---
    direct_vm.mock_llm(r".*", json.dumps(
        {"quote": "So that was death. Overrated. What is for dinner?", "mood_delta": 1}))
    direct_vm.value = GEN
    pet.revive()
    direct_vm.value = 0
    _show("revive() — 1 GEN, back from the void", pet)
    assert pet.get_state()["alive"] is True
    assert int(pet.get_state()["revives"]) == 1

    print("\n--- community leaderboard (who fed the most) ---")
    for i, row in enumerate(pet.get_top_feeders(0), 1):
        print(f"  {i}. {row['address']}  {int(row['wei']) / GEN:.3f} GEN")
    print(f"  contract holds: {int(pet.get_balance()) / GEN:.3f} GEN")

    print("\n--- lines feed (history) ---")
    for i, line in enumerate(pet.get_history(), 1):
        print(f"  {i}. {line}")
    assert len(pet.get_history()) == 6                   # 4 actions + death + revive
    print("\n✓ playthrough complete\n")
