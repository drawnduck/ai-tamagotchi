# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Minimal probe for the withdraw() defect: how do you pay an EOA from GenVM?

AiPet.withdraw() reaches FINALIZED and moves nothing; consensus logs
UnissuedMessagesAtFinalization(unissuedCount=1). Nothing about the pet matters here,
so this strips the transfer down to its own contract and A/Bs the routes.

Measured on Testnet Bradbury (see ROADMAP §3b):

    pay_on_finalized -> EOA        ❌ message type 1, data 0xc20680 — unissued
    pay_on_accepted  -> EOA        ❌ same message — never processed
    pay_to           -> contract   ✅ paid instantly, 0.01 GEN moved
    eth_pay_owner    -> EOA        message type 0, data 0x — the right shape

The difference is the calldata. emit_transfer on a GenVM proxy always posts a
__receive__ *method call*, and an externally owned account has no code to run it.
gl.evm.contract_interface posts an EthSend with empty calldata instead — a plain
value transfer. Run with: node tools/transferProbe.mjs
"""

from genlayer import *


@gl.evm.contract_interface
class _Payee:
    """An EVM-side proxy. Its emit_transfer issues EthSend with EMPTY calldata —
    a plain value transfer, not a __receive__ call — which is the only shape an
    externally owned account can accept."""

    class View:
        pass

    class Write:
        pass


class Vault(gl.Contract):
    owner: Address
    received: u256

    def __init__(self) -> None:
        self.owner = gl.message.sender_address
        self.received = u256(0)


    @gl.public.write.payable
    def fund(self) -> None:
        """Put money in. Nothing else."""

    @gl.public.write.payable
    def __receive__(self) -> None:
        """Accept plain transfers, so a contract recipient is a fair test."""
        self.received = u256(int(self.received) + int(gl.message.value))

    @gl.public.write
    def pay_to(self, recipient: str, amount_wei: int) -> None:
        gl.get_contract_at(Address(recipient)).emit_transfer(
            value=u256(int(amount_wei)), on="accepted"
        )

    @gl.public.write
    def eth_pay_owner(self, amount_wei: int) -> None:
        """The candidate fix for AiPet.withdraw()."""
        _Payee(self.owner).emit_transfer(value=u256(int(amount_wei)))

    @gl.public.write
    def pay_on_finalized(self, amount_wei: int) -> None:
        gl.get_contract_at(self.owner).emit_transfer(value=u256(int(amount_wei)))

    @gl.public.write
    def pay_on_accepted(self, amount_wei: int) -> None:
        gl.get_contract_at(self.owner).emit_transfer(
            value=u256(int(amount_wei)), on="accepted"
        )

    @gl.public.view
    def held(self) -> str:
        return str(int(self.balance))

    @gl.public.view
    def who(self) -> str:
        return self.owner.as_hex
