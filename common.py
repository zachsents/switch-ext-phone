"""Shared bits for the phone appendage: secrets, ElevenLabs and Twilio calls, recording to the brain."""
import base64, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
import threading

import sbmcp

HOME = os.environ.get("SB_HOME") or os.path.dirname(os.path.abspath(__file__))
TWILIO_SID = os.environ.get("PHONE_TWILIO_SID", "")


SWITCH = bool(os.environ.get("SWITCH_MACHINE"))
"""Run by Switch: the Twilio and ElevenLabs keys are the user's connections (kind "key"), and the agents' and number's
ids are config in SB_HOME/config.json; nothing secret is kept here."""
SECRET_KEYS = {"twilio_token": "twilio", "eleven_key": "elevenlabs"}


def _connection(provider):
    """The first connected account of a provider and its key."""
    accounts = app.accounts(provider)
    if not accounts:
        raise RuntimeError(f"{provider} isn't connected")
    account = accounts[0]["account"]
    return account, app.token(provider, account)[0]


def _adopt(path):
    """Hands the keys a Switchboard copy kept to the user's connections, then keeps only the ids, as config."""
    with open(path) as f:
        held = json.load(f)
    # The Twilio account is named by its SID (an older copy kept it in code; its file says it as twilio_sid).
    sid = held.get("twilio_sid") or TWILIO_SID
    if held.get("twilio_token") and not str(sid).startswith("AC"):
        raise RuntimeError(f"{path} has a Twilio token but no twilio_sid (AC…) to name its account")
    accounts = {"twilio": sid, "elevenlabs": "elevenlabs"}
    for key, provider in SECRET_KEYS.items():
        if held.get(key):
            app.adopt(provider, accounts[provider], {"secret": held[key]})
    config = {k: v for k, v in held.items() if k not in SECRET_KEYS}
    fd = os.open(os.path.join(HOME, "config.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(config, f)
    os.remove(path)


def line():
    """The Twilio number calls go out from (and come back to): config.json's "line", else PHONE_LINE."""
    path = os.path.join(HOME, "config.json")
    if os.path.exists(path):
        with open(path) as f:
            got = json.load(f).get("line")
        if got:
            return got
    return os.environ.get("PHONE_LINE", "")


def secrets():
    """{eleven_key, twilio_token, agent_id, callback_agent_id, phone_number_id}: in Switch the keys from the user's
    connections and the ids from SB_HOME/config.json; else all kept in SB_HOME/secrets.json (0600)."""
    path = os.environ.get("PHONE_SECRETS") or os.path.join(HOME, "secrets.json")
    if not SWITCH:
        with open(path) as f:
            return json.load(f)
    if os.path.exists(path):
        _adopt(path)
    with open(os.path.join(HOME, "config.json")) as f:
        out = json.load(f)
    global TWILIO_SID
    account, out["twilio_token"] = _connection("twilio")
    TWILIO_SID = out.get("twilio_sid") or account
    out["eleven_key"] = _connection("elevenlabs")[1]
    return out


ME_CARD = ("const c = Application('Contacts').myCard(); "
           "JSON.stringify(c ? {name: c.nickname() || c.firstName() || '', name_ja: c.phoneticFirstName() || ''} : {})")


def caller_name():
    """(name, name_ja): the user's name as callers hear it, and how to say it in Japanese (e.g. katakana). From
    SB_HOME/config.json's "name" and "name_ja", else this Mac's Contacts card for the user (My Card: its nickname or
    first name, and its phonetic first name)."""
    path = os.path.join(HOME, "config.json")
    config = {}
    if os.path.exists(path):
        with open(path) as f:
            config = json.load(f)
    card = {}
    if not (config.get("name") and config.get("name_ja")):
        r = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", ME_CARD], capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and r.stdout.strip():
            card = json.loads(r.stdout)
    name = (config.get("name") or card.get("name") or "").strip()
    if not name:
        raise RuntimeError("no name for the user: set \"name\" in the phone extension's config.json or fill in My Card in Contacts")
    return name, (config.get("name_ja") or card.get("name_ja") or name).strip()


def http(method, url, body=None, headers=None, form=False, timeout=30):
    data = None
    headers = dict(headers or {})
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:1500]
        raise RuntimeError(f"{method} {url.split('?')[0]} -> {e.code}: {detail}") from None


def eleven(method, path, body=None):
    return http(method, "https://api.elevenlabs.io" + path, body, {"xi-api-key": secrets()["eleven_key"]})


def twilio(method, path, body=None):
    token = secrets()["twilio_token"]  # first: in Switch it also says which account
    auth = base64.b64encode(f"{TWILIO_SID}:{token}".encode()).decode()
    return http(method, f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}{path}", body,
                {"Authorization": "Basic " + auth}, form=True)


def health():
    """Whether the line can place a call now: Twilio's credit and the number still on the account, ElevenLabs' key,
    the caller agent, the number there with outbound calls, callbacks reaching the message-taking agent, and credit left."""
    s = secrets()
    out, problems = {"number": line()}, []

    def check(what, f):
        try:
            return f()
        except Exception as e:  # each check says what failed; the rest still run
            problems.append(f"{what}: {e}"[:300])
            return None

    balance = check("Twilio credit", lambda: float(twilio("GET", "/Balance.json")["balance"]))
    if balance is not None:
        out["twilio_balance_usd"] = round(balance, 2)
        if balance < 1:
            problems.append(f"Twilio has ${balance:.2f} left, too little for a call")
    numbers = check("Twilio number", lambda: twilio("GET", "/IncomingPhoneNumbers.json?PhoneNumber=" + urllib.parse.quote(line()))["incoming_phone_numbers"])
    if numbers is not None and not numbers:
        problems.append(f"{line()} is no longer on the Twilio account")
    check("ElevenLabs caller agent", lambda: eleven("GET", f"/v1/convai/agents/{s['agent_id']}")["agent_id"])
    phone = check("ElevenLabs phone number", lambda: eleven("GET", f"/v1/convai/phone-numbers/{s['phone_number_id']}"))
    if phone:
        if not phone.get("supports_outbound"):
            problems.append("ElevenLabs has the number without outbound calls")
        out["callbacks_answered"] = (phone.get("assigned_agent") or {}).get("agent_id") == s.get("callback_agent_id")
        if not out["callbacks_answered"]:
            problems.append("calls back to the line no longer reach the message-taking agent")
    plan = check("ElevenLabs credit", lambda: eleven("GET", "/v1/user/subscription"))
    if plan and plan.get("character_limit"):
        out["elevenlabs_credits_left"] = plan["character_limit"] - (plan.get("character_count") or 0)
        if out["elevenlabs_credits_left"] < 1000:
            problems.append(f"ElevenLabs has {out['elevenlabs_credits_left']} credits left")
    out.update(ok=not problems, problems=problems, checked_at=int(time.time() * 1000))
    return out


app = sbmcp.Server("phone-call", version="7", connections=[
    {"provider": "twilio", "kind": "key", "label": "Twilio", "scopes": [], "multiple": False},
    {"provider": "elevenlabs", "kind": "key", "label": "ElevenLabs", "scopes": [], "multiple": False},
], instructions="Switch's phone: places calls to businesses (Japanese or English) from the user's Twilio number through an ElevenLabs voice agent, holds the conversation toward a goal, and returns the answer, transcript and recording. A call that may book is held to the most the user approved paying (max_spend), and its result warns if it agreed to more anyway. Every call, out or back in, is recorded: its audio (both sides, mp3) is kept as a blob in the call's record (facts.recording) and in its folder, beside the transcript. Takes messages when they call back. Checks every 6 hours that it can still place calls (Twilio credit and number, the ElevenLabs agent and credit) and records it as phone-line:switch.")
app.event("call", "A call it placed or took, once it's over: who, what was said, the answer, the recording", stream="comms/phone", kind="observation")
app.event("line", "How the line stands: Twilio and ElevenLabs credit, the number, callbacks", stream="comms/phone", kind="observation")

current = threading.local()
"""The call a thread works for (its Context), so what it says on the way is that call's progress."""


def progress(line):
    print(line, file=sys.stderr, flush=True)
    ctx = getattr(current, "ctx", None)
    if ctx is not None:
        ctx.progress(line)


def record(stream, kind, body, about=None, importance=None):
    """Sends what happened as an event, for its keeper to record in comms/phone."""
    event = "line" if body.get("entity", "").startswith("phone-line:") else "call"
    if event == "line":
        app.emit(event, body, about=about, importance=importance)
        return
    f = body.get("facts") or {}
    number = f.get("their_number") or ""
    if f.get("direction") == "inbound":
        sender = {"handle": number or "unknown", "via": "phone"}
        if f.get("caller") and f.get("caller") != "someone":
            sender["name"] = f["caller"]
    else:
        sender = {"handle": "me", "via": "phone", "me": True}
    message = {"id": body.get("entity"), "conversation": f"phone:{number}",
               "text": f.get("message") or body.get("summary") or "", "at": int(time.time() * 1000), "channel": "phone"}
    app.emit(event, body, about=about, importance=importance, sender=sender, message=message)


def keep_audio(cid, tries=5):
    """Saves the call's recording (both sides, mp3) beside the appendage and as a blob; returns {blob, type, bytes} or None."""
    folder = os.path.join(HOME, "recordings")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{cid}.mp3")
    for i in range(tries):
        if not os.path.exists(path):
            req = urllib.request.Request(f"https://api.elevenlabs.io/v1/convai/conversations/{cid}/audio",
                                         headers={"xi-api-key": secrets()["eleven_key"]})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                if len(data) > 1000:
                    open(path, "wb").write(data)
            except (urllib.error.URLError, OSError) as e:
                progress(f"(recording not ready: {e})")
        if os.path.exists(path):
            break
        time.sleep(5 * (i + 1))  # the audio lands a little after the conversation closes
    if not os.path.exists(path):
        return None
    out = {"type": "audio/mpeg", "bytes": os.path.getsize(path), "name": f"{cid}.mp3"}
    if os.environ.get("SB_TOKEN"):
        try:
            ref = subprocess.run(["sb", "blob", "put", "--type", "audio/mpeg", path], capture_output=True, text=True, timeout=120).stdout.strip()
            out["blob"] = json.loads(ref)["blob"] if ref.startswith("{") else ref
        except Exception as e:
            progress(f"(couldn't store the recording: {e})")
    return out


def transcript_lines(conv):
    out = []
    for t in conv.get("transcript") or []:
        msg = (t.get("message") or "").strip()
        if not msg:
            continue
        who = "Me" if t.get("role") == "agent" else "Them"
        out.append({"t": round(t.get("time_in_call_secs") or 0), "who": who, "text": msg})
    return out


def amount(value):
    """A figure from the call's analysis as a number, whether it came as 14, "14" or "$14.00"; None when it's none."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip().lstrip("$¥£€"))
    except ValueError:
        return None


def summarize(conv, extra=None):
    """The parts of a finished ElevenLabs conversation worth handing back."""
    meta = conv.get("metadata") or {}
    analysis = conv.get("analysis") or {}
    dc = analysis.get("data_collection_results") or {}
    phone = meta.get("phone_call") or {}
    result = {
        "conversation_id": conv.get("conversation_id"),
        "status": conv.get("status"),
        "answer": (dc.get("answer") or {}).get("value"),
        "reached_human": (dc.get("reached_human") or {}).get("value"),
        "unsure": (dc.get("unsure") or {}).get("value") or None,
        "outcome": analysis.get("call_successful"),
        "summary": analysis.get("transcript_summary"),
        "duration_secs": meta.get("call_duration_secs"),
        "ended_because": meta.get("termination_reason") or None,
        "direction": phone.get("direction"),
        "their_number": phone.get("external_number"),
        "call_sid": phone.get("call_sid"),
        "transcript": transcript_lines(conv),
        "elevenlabs_cost_usd": meta.get("cost_fiat") if isinstance(meta.get("cost_fiat"), (int, float)) else None,
        "charged_total": amount((dc.get("charged_total") or {}).get("value")),
        "completed": (dc.get("completed") or {}).get("value"),
    }
    if extra:
        result.update(extra)
    return result
