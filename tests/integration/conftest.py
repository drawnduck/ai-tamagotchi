"""Compatibility shim for running the integration suite against Testnet Bradbury.

THE PROBLEM
-----------
Bradbury's consensus reports transaction status **14 = LEADER_REVEALING**, a state
added to the protocol after `genlayer-py 0.16.3` was cut. That version's
`TRANSACTION_STATUS_NUMBER_TO_NAME` only maps 0..13, so the moment a polled
transaction happens to sit in that state the client raises a bare `KeyError: '14'`,
which surfaces as an unhelpful `DeploymentError: Failed to deploy contract AiPet: '14'`.

WHY NOT JUST UPGRADE
--------------------
`genlayer-py 0.18.0` has the mapping, but `genlayer-test 0.29.2` — the newest
release — pins `genlayer-py <0.17.0`. Forcing the upgrade breaks that contract and
risks the 27 passing direct-mode tests for a one-line lookup table gap.

THE FIX
-------
Add the missing entry in place. The dict is imported by reference across
`genlayer_py.transactions.actions` and `genlayer_py.types.transactions`, so a single
in-place mutation reaches every consumer. LEADER_REVEALING is a *transient* phase, so
mapping it onto REVEALING is semantically right: waiters keep polling instead of
crashing, and still stop on the real terminal states.

Delete this file once `genlayer-test` allows `genlayer-py >= 0.17`.
"""

from genlayer_py.types import TRANSACTION_STATUS_NUMBER_TO_NAME
from genlayer_py.types.transactions import TransactionStatus

import gltest.assertions
import gltest.utils
import gltest.contracts.contract_factory

# 0.17+ has a dedicated member; older versions fall back to the closest phase.
_LEADER_REVEALING = getattr(
    TransactionStatus, "LEADER_REVEALING", TransactionStatus.REVEALING
)

TRANSACTION_STATUS_NUMBER_TO_NAME.setdefault("14", _LEADER_REVEALING)


# --------------------------------------------------------------------------- #
# Second incompatibility: the success check
#
# gltest decides success by digging into consensus_data.leader_receipt[0]
# .execution_result == "SUCCESS". On Bradbury a transaction at ACCEPTED comes back
# with `consensus_data: {}` and `tx_receipt: '0x'` — the RLP leader receipt simply
# isn't exposed at that stage — so the check reports failure for transactions that
# demonstrably succeeded. (Verified: a deploy it called "failed" produced a live,
# readable contract at 0xB1c187Eb13E1E2B6139e56472655AAcFADC814d9.)
#
# The real outcome IS in the receipt, one level up: tx_execution_result_name.
# So: keep the original check, and only fall back to the top-level field when the
# leader receipt is genuinely absent — never override a failure the original saw in
# a populated receipt, and never claim success when stdout/stderr had to be matched
# (that evidence lives in the leader receipt we don't have).
# --------------------------------------------------------------------------- #

_orig_succeeded = gltest.assertions.tx_execution_succeeded


def _succeeded(result, match_std_out=None, match_std_err=None) -> bool:
    if _orig_succeeded(result, match_std_out, match_std_err):
        return True
    if (result.get("consensus_data") or {}).get("leader_receipt"):
        return False  # receipt was present and said no — trust it
    if match_std_out is not None or match_std_err is not None:
        return False  # cannot verify output without the leader receipt
    return result.get("tx_execution_result_name") == "FINISHED_WITH_RETURN"


def _failed(result, match_std_out=None, match_std_err=None) -> bool:
    return not _succeeded(result, match_std_out, match_std_err)


gltest.assertions.tx_execution_succeeded = _succeeded
gltest.assertions.tx_execution_failed = _failed
# contract_factory bound the name at import time, so patch its reference too
gltest.contracts.contract_factory.tx_execution_failed = _failed


# --------------------------------------------------------------------------- #
# Third incompatibility: finding the deployed address
#
# extract_contract_address() reads receipt["tx_data_decoded"]["contract_address"],
# but Bradbury returns tx_data_decoded = None (the RLP input blob isn't decodable
# at ACCEPTED), so it raises `TypeError: argument of type 'NoneType' is not
# iterable`. The address is still right there in the receipt as `recipient` —
# confirmed by reading live state back from it.
# --------------------------------------------------------------------------- #

_orig_extract = gltest.utils.extract_contract_address


def _extract(receipt) -> str:
    try:
        return _orig_extract(receipt)
    except (TypeError, ValueError):
        recipient = receipt.get("recipient")
        if recipient:
            return recipient
        raise


gltest.utils.extract_contract_address = _extract
gltest.contracts.contract_factory.extract_contract_address = _extract
