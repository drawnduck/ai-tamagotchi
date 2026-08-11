# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Which time sources actually work inside GenVM on Testnet Bradbury?

datetime.now() returns 0 there, which makes every idle-decay mechanic inert.
gl.message_raw carries a 'datetime' field supplied by consensus — this checks
whether that one is real, and whether all validators agree on it.
"""

from genlayer import *

from datetime import datetime, timezone


class Clock(gl.Contract):
    wall: str
    msg_dt: str
    parsed: u256

    def __init__(self) -> None:
        self.wall = ""
        self.msg_dt = ""
        self.parsed = u256(0)

    @gl.public.write
    def sample(self) -> str:
        self.wall = str(int(datetime.now(timezone.utc).timestamp()))

        raw = gl.message_raw.get("datetime", "<missing>")
        self.msg_dt = str(raw)

        try:
            self.parsed = u256(int(datetime.fromisoformat(str(raw)).timestamp()))
        except Exception as exc:  # noqa: BLE001 — a probe wants the message, not the type
            self.msg_dt = f"{raw} | parse failed: {exc}"

        return self.msg_dt

    @gl.public.view
    def get_all(self) -> dict:
        return {
            "wall_clock": str(self.wall),
            "message_datetime": str(self.msg_dt),
            "parsed_unix": str(int(self.parsed)),
        }
