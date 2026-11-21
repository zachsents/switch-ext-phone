"""Watches for calls back to the line: each finished one becomes a record in comms/phone and a notification."""
import json, os, time

from common import HOME, eleven, line, health, keep_audio, record, secrets, summarize

STATE = os.path.join(HOME, "watch-state.json")
EVERY = 120


def load():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {"since": int(time.time()) - 3600, "seen": []}


def notify(title, text):
    if os.environ.get("SB_TOKEN"):
        os.system("sb notify --title " + json.dumps(title) + " --open now " + json.dumps(text) + " >/dev/null 2>&1")


def once(state):
    agent = secrets()["callback_agent_id"]
    page = eleven("GET", f"/v1/convai/conversations?agent_id={agent}&page_size=30&call_start_after_unix={state['since'] - 600}")
    for c in page.get("conversations") or []:
        cid = c["conversation_id"]
        if cid in state["seen"] or c.get("status") not in ("done", "failed"):
            continue
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
        state["seen"] = (state["seen"] + [cid])[-200:]
        state["since"] = max(state["since"], int(c.get("start_time_unix_secs") or 0))
    json.dump(state, open(STATE, "w"))


def checkup(state):
    """The line's health every 6 hours, recorded as phone-line:switch (the appendage's heartbeat): a notification once
    when it can't place calls, and once when Twilio's credit drops under $5."""
    if time.time() - state.get("balance_at", 0) < 6 * 3600:
        return
    h = health()
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


def main():
    state = load()
    while True:
        for step in (once, checkup):
            try:
                step(state)
            except Exception as e:
                print(f"watch: {step.__name__}: {e}", flush=True)
        time.sleep(EVERY)
