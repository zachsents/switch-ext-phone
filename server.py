"""The phone appendage as an MCP server (sbmcp): `call`, `result` and `status` are its
tools, the calls it places and takes go out as `call` events (comms/phone), and the
line's health as `line`. The callback watcher runs beside it."""
import time

import handle
import watch
from common import app, current, health

TOOLS = [
    {
        "name": "call",
        "description": "Phone a business and find something out (stock, hours, availability, prices), then hand back the answer and full transcript; it waits for the call to end (allow ~10 min: give timeout_seconds 600; 15 for a booking). It speaks for the user: place information-only calls when he asked for the answer; may_book needs his approval and max_spend, the exact amount he approved, which the caller never goes over (it says it'll check with him and call back). The result's warning says when it agreed to more anyway, and unfinished when a booking call ended before they said it was done: check the booking itself then. Introduces itself as an AI assistant calling for the user. Won't call Japan/Korea/UK numbers 21:00-08:00 their time. Costs ~$0.16/min to Japanese landlines, ~$0.27/min to Japanese mobiles, ~$0.10/min in the US.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "The number as written: +81 848-..., 0848-00-0000 (a leading 0 means Japan unless country says otherwise), (310) 555-0100."
                },
                "goal": {
                    "type": "string",
                    "description": "What to find out or do, specifically, with what matters for judging the answer (e.g. 'Do they have 2 adult crossbikes left to rent at Setoda port today, until what time can we pick up, and can we drop off in Imabari?')."
                },
                "business": {
                    "type": "string",
                    "description": "Who you're calling, as you'd name them on the phone (e.g. 'Shimanami Rent-a-cycle, Setoda terminal')."
                },
                "context": {
                    "type": "string",
                    "description": "Facts the caller may share if asked: party size, dates, arrival time. Nothing secret."
                },
                "language": {
                    "type": "string",
                    "enum": [
                        "ja",
                        "en"
                    ],
                    "description": "Default: ja for +81 numbers, else en."
                },
                "country": {
                    "type": "string",
                    "description": "For a domestic number with a leading 0 that isn't Japanese: UK, KR, AU."
                },
                "may_book": {
                    "type": "boolean",
                    "description": "Allow it to make the reservation or change the goal describes. Only with the user's approval, and only with max_spend."
                },
                "max_spend": {
                    "type": "number",
                    "description": "With may_book: the most the user approved paying on this call, all in (every fee, fare difference, tax and deposit), like 10 for $10; 0 if nothing may be charged. The caller won't agree to a total above it, even by a little."
                },
                "currency": {
                    "type": "string",
                    "description": "max_spend's currency, like USD or JPY (default: the one where the number rings)."
                },
                "max_minutes": {
                    "type": "integer",
                    "description": "Hang up after this long (default 6, or 12 with may_book; at most 15)."
                },
                "about": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "Entities the call record is about, like project:japan-trip."
                },
                "thread": {
                    "type": "string",
                    "description": "The thread asking, kept on the record."
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "Build the brief and check the number without dialing."
                },
                "allow_late": {
                    "type": "boolean",
                    "description": "Call outside 08:00-21:00 local time anyway."
                }
            },
            "required": [
                "to",
                "goal"
            ]
        }
    },
    {
        "name": "result",
        "description": "A call's result by conversation_id (when a call's request timed out before it ended), waiting up to wait_secs for it to finish.",
        "input_schema": {
            "type": "object",
            "properties": {
                "conversation_id": {
                    "type": "string"
                },
                "call_sid": {
                    "type": "string"
                },
                "wait_secs": {
                    "type": "integer"
                }
            },
            "required": [
                "conversation_id"
            ]
        }
    },
    {
        "name": "status",
        "description": "Whether the line can place a call right now, checked live: Twilio credit and the number, the ElevenLabs agent and number, callbacks answered, ElevenLabs credit left. ok, and problems when not.",
        "input_schema": {
            "type": "object",
            "properties": {}
        }
    }
]


def call(ctx, **args):
    current.ctx = ctx
    try:
        return handle.place_call(args)
    finally:
        current.ctx = None


def result(ctx, conversation_id, call_sid=None, wait_secs=None, **_):
    current.ctx = ctx
    try:
        return handle.follow(conversation_id, call_sid, deadline=time.time() + int(wait_secs or 5))
    finally:
        current.ctx = None


def status(**_):
    return health()


HANDLERS = {"call": call, "result": result, "status": status}
for spec in TOOLS:
    app.tool(HANDLERS[spec["name"]], name=spec["name"], description=spec["description"], schema=spec["input_schema"],
             read_only=spec["name"] in ("result", "status"), speaks_for_person=spec["name"] == "call")

app.background(watch.main)

if __name__ == "__main__":
    app.run()
