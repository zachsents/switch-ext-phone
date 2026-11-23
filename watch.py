"""Watches for calls back to the line: each finished one becomes a record in comms/phone and a notification. Its
heartbeat (vitals/phone-call) says, from this loop, what is failing now."""
import json, os, time

from common import HOME, app, eleven, line, health, keep_audio, record, secrets, summarize

STATE = os.path.join(HOME, "watch-state.json")
EVERY = 120
HEARTBEAT_S = 300
LINE_EVERY = 6 * 3600

FAILING = {}
"""What's failing now, by part (callbacks, line), each cleared once that part works again."""
LAST = {"line": {}, "line_checked": 0.0}


def load():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {"since": int(time.time()) - 3600, "seen": []}


def notify(title, text):
    if os.environ.get("SB_TOKEN"):
        os.system("sb notify --title " + json.dumps(title) + " --open now " + json.dumps(text) + " >/dev/null 2>&1")


def mark(part, trouble):
    if trouble:
        FAILING[part] = trouble[:300]
    else:
        FAILING.pop(part, None)


def failing(state):
    """What's failing now, in a line, or None."""
    now = [f"{part}: {why}" for part, why in FAILING.items()]
    skipped = state.get("skipped") or {}
    if skipped:
        cid, latest = max(skipped.items(), key=lambda kv: kv[1]["at"])
        now.append(f"skipped {len(skipped)} call{'s' if len(skipped) != 1 else ''} back it couldn't record "
                   f"(latest {cid}: {latest['why']})")
    return "; ".join(now) or None


def take(cid):
    """Records one finished call back."""
    conv = eleven("GET", f"/v1/convai/conversations/{cid}")
    s = summarize(conv)
    dc = ((conv.get("analysis") or {}).get("data_collection_results") or {})
    caller = (dc.get("caller") or {}).get("value") or s.get("their_number") or "someone"
    message = (dc.get("message") or {}).get("value") or s.get("summary") or "(no message)"
    back = (dc.get("callback_number") or {}).get("value")
    rec = keep_audio(cid) if s.get("duration_secs") else None
    record("comms/phone", "observation", {
        "entity": f"phone-call:{cid}", "kind": "phone-call", "name": f"Call from {caller}",
        "summary": f"{caller} called back: {message}"[:400],
        "facts": {"direction": "inbound", "caller": caller, "message": message, "callback_number": back,
                  "their_number": s.get("their_number"), "duration_secs": s.get("duration_secs"),
                  "transcript": "\n".join(f"{l['who']}: {l['text']}" for l in s["transcript"]),
                  "recording": rec},
    }, about=[f"phone-call:{cid}"], importance=0.7)
    if s["transcript"] and s.get("duration_secs", 0) > 5:
        notify(f"{caller} called back", message[:300])


def once(state):
    """New calls back, and those skipped before: one that fails is kept, with why, and tried again next time."""
    agent = secrets()["callback_agent_id"]
    page = eleven("GET", f"/v1/convai/conversations?agent_id={agent}&page_size=30&call_start_after_unix={state['since'] - 600}")
    skipped = state.setdefault("skipped", {})
    todo = {}
    for c in page.get("conversations") or []:
        cid = c["conversation_id"]
        if cid in state["seen"] or c.get("status") not in ("done", "failed"):
            continue
        todo[cid] = int(c.get("start_time_unix_secs") or 0)
    for cid, kept in skipped.items():
        todo.setdefault(cid, kept.get("start", 0))
    for cid, start in todo.items():
        try:
            take(cid)
        except Exception as e:
            skipped[cid] = {"why": f"{type(e).__name__}: {e}"[:300], "at": int(time.time()), "start": start}
            continue
        skipped.pop(cid, None)
        state["seen"] = (state["seen"] + [cid])[-200:]
        state["since"] = max(state["since"], start)
    json.dump(state, open(STATE, "w"))


def checkup(state):
    """The line's health every 6 hours, recorded as phone-line:switch: a notification once when it can't place calls,
    and once when Twilio's credit drops under $5. While it can't, checked again each heartbeat, unrecorded, so its
    failing clears once it can."""
    due = time.time() - state.get("balance_at", 0) >= LINE_EVERY
    if not due and not ("line" in FAILING and time.time() - LAST["line_checked"] >= HEARTBEAT_S):
        return
    LAST["line_checked"] = time.time()
    h = health()
    LAST["line"] = h
    mark("line", None if h["ok"] else "; ".join(h["problems"]))
    if not due:
        return
    state["balance_at"] = time.time()
    b = h.get("twilio_balance_usd")
    summary = line() + (f", Twilio credit ${b:.2f}" if b is not None else "")
    summary += ", ready to call" if h["ok"] else ": " + "; ".join(h["problems"])
    record("comms/phone", "observation", {"entity": "phone-line:switch", "kind": "phone-line", "name": "Switch's phone line",
           "summary": summary[:400], "facts": {**h, "number": line()}})
    if not h["ok"] and not state.get("warned_broken"):
        notify("My phone line can't place calls", "; ".join(h["problems"])[:300])
        state["warned_broken"] = True
    elif h["ok"]:
        state["warned_broken"] = False
    if b is not None and b < 5 and not state.get("warned_low"):
        notify("My phone line is low on credit", f"Twilio has ${b:.2f} left, about {int(b / 0.16)} minutes of calls to Japanese landlines.")
        state["warned_low"] = True
    elif b is not None and b >= 5:
        state["warned_low"] = False
    json.dump(state, open(STATE, "w"))


def heartbeat(state):
    trouble = failing(state)
    h = LAST["line"]
    app.emit("heartbeat", {"entity": "sense:phone-call", "summary": (f"Failing: {trouble}" if trouble else "Ready")[:600],
                           "facts": {"failing": trouble, "skipped": state.get("skipped") or {},
                                     "line_ok": h.get("ok"), "twilio_balance_usd": h.get("twilio_balance_usd"),
                                     "line_checked_at": h.get("checked_at")}})


def main():
    state = load()
    last_beat, said = 0.0, None
    while True:
        for part, step in (("callbacks", once), ("line", checkup)):
            try:
                step(state)
                if part == "callbacks":
                    mark(part, None)
            except Exception as e:
                mark(part, f"{type(e).__name__}: {e}")
                app.log(f"watch: {step.__name__}: {e}")
        trouble = failing(state)
        if time.time() - last_beat >= HEARTBEAT_S or trouble != said:
            try:
                heartbeat(state)
                said, last_beat = trouble, time.time()
            except Exception as e:
                app.log(f"watch: heartbeat: {e}")
        time.sleep(EVERY)
