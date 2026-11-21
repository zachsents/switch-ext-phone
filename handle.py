"""What the phone appendage does for a request: place a call, follow one, and say how the line stands."""
import datetime, json, os, re, sys, time

from common import HOME, LINE, caller_name, eleven, health, keep_audio, progress, record, secrets, summarize, twilio, transcript_lines
from agent_config import EN_VOICE, JA_VOICE

LANGS = {"ja": "Japanese", "en": "English"}
CURRENCIES = {"+852": "HKD", "+886": "TWD", "+81": "JPY", "+82": "KRW", "+44": "GBP", "+61": "AUD", "+65": "SGD", "+1": "USD"}
SYMBOLS = {"USD": "$", "JPY": "¥", "GBP": "£", "AUD": "A$", "KRW": "₩", "HKD": "HK$", "TWD": "NT$", "SGD": "S$"}
WHOLE = {"JPY", "KRW", "TWD"}  # currencies counted without cents


def currency_of(e164):
    return next((c for prefix, c in CURRENCIES.items() if e164.startswith(prefix)), None)


def money(amount, currency):
    """An amount as it's said: $10.00, ¥3,000, 25.00 EUR."""
    figure = f"{amount:,.0f}" if currency in WHOLE else f"{amount:,.2f}"
    return SYMBOLS[currency] + figure if currency in SYMBOLS else f"{figure} {currency}"


def spend_limit(args, to):
    """The most the user approved paying on the call, all in, and its currency. A call that may book must say it;
    one that may not can pay nothing."""
    currency = (args.get("currency") or currency_of(to) or "").upper()
    if not args.get("may_book"):
        return 0.0, currency or "USD"
    if args.get("max_spend") is None:
        raise ValueError("may_book needs max_spend: the most the user approved paying on this call, all in (fees, fare "
                         "differences, taxes, deposits), as a number; 0 if nothing may be charged")
    if not currency:
        raise ValueError(f"give currency for max_spend: I can't tell which one {to} pays in")
    try:
        amount = float(str(args["max_spend"]).replace(",", "").lstrip("$¥£"))
    except ValueError:
        raise ValueError(f"max_spend must be a number, like 10 or 3000, not {args['max_spend']!r}") from None
    if amount < 0:
        raise ValueError("max_spend can't be negative")
    return amount, currency


def normalize(number, country=None):
    """E.164 from what people write: +81 848-00-0000, 0848-00-0000 (Japan), (555) 010-0000, 1-555-..."""
    raw = number.strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        e164 = "+" + digits
    elif raw.startswith("00"):
        e164 = "+" + digits[2:]
    elif digits.startswith("0"):  # a domestic number with a trunk 0: Japan unless told otherwise
        cc = {"JP": "81", "UK": "44", "GB": "44", "KR": "82", "AU": "61"}.get((country or "JP").upper())
        if not cc:
            raise ValueError(f"don't know the country code for {country}")
        e164 = f"+{cc}{digits[1:]}"
    elif len(digits) == 10:
        e164 = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1"):
        e164 = "+" + digits
    else:
        raise ValueError(f"can't tell what country {number!r} is in: give it with + and its country code")
    if not 9 <= len(e164) <= 16:
        raise ValueError(f"{e164} doesn't look like a phone number")
    return e164


def local_hour(e164):
    """The hour where the number rings, for the countries a single zone covers; None elsewhere."""
    zones = {"+81": 9, "+82": 9, "+44": 0, "+852": 8, "+886": 8, "+65": 8}
    for prefix, offset in zones.items():
        if e164.startswith(prefix):
            return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=offset)).hour
    return None


def money_rules(limit, lang, name, name_ja):
    """The brief's hard spending limit, for a call that may book: the one rule the caller never bends."""
    cap = money(*limit)
    refusal = (f"「申し訳ございません。{name_ja}が了承している金額を超えてしまうため、こちらではお受けできません。"
               "変更やご請求はせずにお待ちいただけますでしょうか。本人に確認して、改めてお電話いたします。」"
               if lang == "ja" else
               f"\"I'm sorry, that's more than {name} approved, so I can't agree to it. Please don't make the change or "
               "charge anything. I'll check with him and call back.\"")
    allowed = (f"- If the total is {cap} or less, you may agree: say the total back once (\"So that's [total] in all\") and go ahead.\n"
               if limit[0] > 0 else
               f"- {name} hasn't approved paying anything, so if anything at all would be charged (a fee, a deposit, a card guarantee charge), you can't agree to it.\n")
    return f"""
# Money: {name}'s limit, which you never go over
{name} approved paying at most {cap} on this call, all in: every fee, fare or price difference, tax, surcharge, deposit, upgrade and separate charge, added together. This limit is absolute. Nothing lets you go over it: not a small difference ("it's only a few dollars more"), not a fare increase or a fee you weren't told about, not a reason that sounds fair, and not their having already started.
- Before you agree to anything that costs money, ask for the total that will be charged, all in, and add up every charge they mention yourself.
{allowed}- If the total is more than {cap}, even by a little, or they can't tell you the total: do NOT agree, and never say "that's fine", "okay" or "go ahead" to it. Say: {refusal} Then ask what the total would be and how long the price or the seat holds, thank them, and end the call.
- If they bring up another charge after you've agreed (a fare increase, a tax, a second charge), add it to the total and decide again by the same rule before they process it.
- If they say they've already charged more than {cap}, say {name} didn't approve that and ask them to reverse it, and note exactly what they say.
"""


def brief(args, lang, limit=(0.0, "USD")):
    business = args.get("business") or "the business"
    goal = args["goal"].strip()
    context = (args.get("context") or "").strip()
    may_book = bool(args.get("may_book"))
    name, name_ja = caller_name()
    if lang == "ja":
        intro = ("Open, once they've answered, with a short polite introduction in natural phone Japanese, e.g. "
                 f"「お忙しいところ恐れ入ります。{name_ja}というお客様の代わりにお電話しております、AIアシスタントです。」 "
                 "then ask your question straight away. Speak polite 敬語 (です/ます, 恐れ入りますが, よろしいでしょうか), "
                 f"short sentences, the way a considerate customer would. Say {name}'s name as {name_ja}. "
                 "End with 「お忙しいところありがとうございました。失礼いたします。」")
    else:
        intro = ("Open, once they've answered, with a short friendly introduction, e.g. \"Hi, I'm an AI assistant "
                 f"calling on behalf of a customer, {name}. This call is recorded.\" (always say it's recorded) then ask your question straight away.")
    booking = ("You MAY make the booking, reservation or change described in the goal, within exactly the terms given there "
               f"and {name}'s money limit; confirm every detail back before agreeing, and get any confirmation number or name "
               "it's under. It isn't done until they say it's done: stay on the line while they make it, then confirm what's "
               "booked and the total charged. If they start to wrap up before saying it's done or giving a confirmation "
               "number, ask for it before you say goodbye."
               if may_book else
               f"Do NOT make, hold or cancel any reservation, booking, order or payment, and don't promise {name} will come. "
               f"If they offer to hold something, thank them, say {name} will decide and call back, and note what they offered "
               "(how long they'd hold it, under what name).")
    return f"""You are Switch, {name}'s AI assistant, on a phone call you placed to {business} for him. You speak {LANGS[lang]} on this call.

# Why you're calling
{goal}

# What you may tell them if it helps or they ask
{context or f"Only that you're calling for a customer named {name}. You don't have other details; say {name} will follow up if they need more."}
{money_rules(limit, lang, name, name_ja) if may_book else ""}
# How to handle the call
- Wait for them to answer and speak first. {intro}
- You are an AI and say so in your introduction. If asked, never claim to be human.
- Keep each turn to one or two short sentences; this is a phone call. Let them finish; don't talk over them.
- Get concrete facts: yes/no, numbers, times, prices, conditions (e.g. how late you can arrive, whether it's first come first served, whether they take reservations by phone).
- The line is a noisy phone line and numbers are what matter most. If a number, time or price sounds odd, garbled, or doesn't fit what was said before, ask them to say it again (e.g. 「恐れ入ります、何時までとおっしゃいましたか」 / "Sorry, what time was that?"). Never guess a number.
- Before hanging up, confirm the key facts back one at a time in a short list, and listen for corrections; if they correct something, repeat the corrected figure back once more.
- {booking}
- Never give card numbers, addresses, ID numbers or anyone's personal details beyond what's listed above.
- If they ask something you don't know, say {name} will check and call back. Don't invent details.
- Phone menu (IVR): use the keypad tool to reach a person or the right department.
- Holds: when they put you on hold, transfer you, or ask you to wait ("give me a moment", "let me check", 少々お待ちください), say once that you'll wait, then stay silent with the skip_turn tool until they speak again. Silence and hold music are normal; never end the call while they're looking something up or making a change, and don't keep checking in.
- A recording or voicemail (e.g. closed today, outside hours): listen to the whole message for hours or other numbers, leave no message, then end the call.
- If they're busy, can't help, or ask you to call back later, ask when is best, thank them and end the call.
- When you have the answer{" (for a booking or change: once they've said it's done and you've confirmed what's booked and the total)" if may_book else ""}, thank them and end the call with the end_call tool. Don't linger.
"""


def keywords(args):
    """Words the recognizer should expect: the business's name and whatever the caller adds."""
    words = list(args.get("keywords") or [])
    if args.get("business"):
        words += [w for w in re.split(r"[\s,、・()（）]+", args["business"]) if len(w) > 1]
    return list(dict.fromkeys(words))[:50]


def place_call(args):
    s = secrets()
    to = normalize(args["to"], args.get("country"))
    lang = (args.get("language") or ("ja" if to.startswith("+81") else "en")).lower()
    if lang not in LANGS:
        raise ValueError(f"language must be one of {sorted(LANGS)}")
    if not (args.get("goal") or "").strip():
        raise ValueError("goal is required: what to find out or do on the call")
    hour = local_hour(to)
    if hour is not None and not (8 <= hour < 21) and not args.get("allow_late"):
        raise ValueError(f"it's {hour}:00 where {to} rings; I don't call businesses between 21:00 and 08:00 their time "
                         "(allow_late: true overrides)")
    limit = spend_limit(args, to)
    # A booking or change waits on their systems and holds, so it gets longer than a question.
    max_minutes = max(1, min(int(args.get("max_minutes") or (12 if args.get("may_book") else 6)), 15))
    override = override_for(args, lang, max_minutes, limit)
    prompt = override["agent"]["prompt"]["prompt"]
    if args.get("dry_run"):
        return {"dry_run": True, "to": to, "language": lang, "max_minutes": max_minutes, "max_spend": money(*limit),
                "keywords": override["asr"]["keywords"], "brief": prompt}

    progress(f"Dialing {args.get('business') or to} ({to}) in {LANGS[lang]} from {LINE}"
             + (f", may spend up to {money(*limit)}" if args.get("may_book") else ""))
    return dial(s, to, lang, args, override, max_minutes, limit)


def override_for(args, lang, max_minutes=6, limit=(0.0, "USD")):
    prompt = brief(args, lang, limit)
    return {
        "agent": {"prompt": {"prompt": prompt}, "language": lang, "first_message": ""},
        "tts": {"voice_id": JA_VOICE if lang == "ja" else EN_VOICE},
        "conversation": {"max_duration_seconds": max_minutes * 60},
        "asr": {"keywords": keywords(args)},
    }


def terms_path(cid):
    return os.path.join(HOME, "calls", f"{cid}.json")


def keep_terms(cid, args, limit):
    """Keeps what the call was allowed to commit to, so its result can be held to it, however it's fetched."""
    os.makedirs(os.path.dirname(terms_path(cid)), exist_ok=True)
    with open(terms_path(cid), "w") as f:
        json.dump({"may_book": bool(args.get("may_book")), "max_spend": limit[0], "currency": limit[1]}, f)


def judge(out):
    """Holds a finished call to its terms: a total agreed over the limit (anything at all, on a call that may not
    book) becomes a warning, and a booking call that ended before they said it was done is marked unfinished."""
    try:
        with open(terms_path(out.get("conversation_id"))) as f:
            terms = json.load(f)
    except (OSError, ValueError, TypeError):
        return out
    limit, currency, agreed = terms["max_spend"], terms["currency"], out.get("charged_total")
    over = isinstance(agreed, (int, float)) and agreed > limit + 0.005
    out["spend"] = {"limit": limit, "currency": currency, "agreed": agreed, "over_limit": over}
    if over:
        allowed = f"the {money(limit, currency)} the user approved" if terms["may_book"] else "a call that wasn't allowed to pay anything"
        out["warning"] = (f"The caller agreed to {money(agreed, currency)}, over {allowed}. Tell the user first, "
                          "and check what was actually charged.")
    if terms["may_book"] and out.get("status") == "done" and out.get("completed") is not True:
        out["unfinished"] = ("They hadn't said the booking or change was done when the call ended"
                             + (f" ({out['ended_because'].rstrip('.')})" if out.get("ended_because") else "")
                             + ": check the booking page or the confirmation email before telling the user it went through.")
    return out


def dial(s, to, lang, args, override, max_minutes, limit=(0.0, "USD")):
    started = time.time()
    r = eleven("POST", "/v1/convai/twilio/outbound-call", {
        "agent_id": s["agent_id"],
        "agent_phone_number_id": s["phone_number_id"],
        "to_number": to,
        "conversation_initiation_client_data": {"conversation_config_override": override},
        "telephony_call_config": {"ringing_timeout_secs": int(args.get("ring_secs") or 40)},
    })
    if not r.get("success") or not r.get("conversation_id"):
        raise RuntimeError(f"the call didn't start: {r.get('message') or r}")
    cid, call_sid = r["conversation_id"], r.get("callSid")
    keep_terms(cid, args, limit)
    progress(f"Ringing (conversation {cid})")
    result = follow(cid, call_sid, deadline=started + max_minutes * 60 + 180)
    result.update({"to": to, "business": args.get("business"), "goal": args["goal"], "language": lang})
    remember(result, args)
    return result


def follow(cid, call_sid=None, deadline=None):
    """Waits for the call to end and its analysis to finish, streaming the conversation as progress."""
    seen, conv, twilio_status = 0, {}, None
    deadline = deadline or time.time() + 900
    while time.time() < deadline:
        time.sleep(3)
        try:
            conv = eleven("GET", f"/v1/convai/conversations/{cid}")
        except RuntimeError as e:
            progress(f"(waiting: {e})")
            continue
        lines = transcript_lines(conv)
        for line in lines[seen:]:
            progress(f"{line['who']}: {line['text']}")
        seen = len(lines)
        if call_sid and not lines:
            try:
                twilio_status = twilio("GET", f"/Calls/{call_sid}.json").get("status")
            except RuntimeError:
                pass
            if twilio_status in ("busy", "no-answer", "failed", "canceled"):
                progress(f"The call ended: {twilio_status}")
                # Give ElevenLabs a moment to close the conversation, then hand back what we know.
                time.sleep(4)
                try:
                    conv = eleven("GET", f"/v1/convai/conversations/{cid}")
                except RuntimeError:
                    pass
                break
        if conv.get("status") in ("done", "failed"):
            break
    extra = {"phone_status": twilio_status}
    if call_sid:
        try:
            c = twilio("GET", f"/Calls/{call_sid}.json")
            extra["phone_status"] = c.get("status")
            extra["twilio_cost_usd"] = abs(float(c["price"])) if c.get("price") else None
        except (RuntimeError, ValueError):
            pass
    if conv.get("status") not in ("done", "failed") and extra.get("phone_status") not in ("busy", "no-answer", "failed", "canceled"):
        extra["note"] = "Stopped waiting before the call finished; the result action fetches it later."
    out = summarize(conv or {"conversation_id": cid}, extra)
    if out.get("phone_status") in ("busy", "no-answer", "failed", "canceled") and not out["transcript"]:
        out["answer"] = out["answer"] or f"No conversation: the line was {out['phone_status']}."
        out["reached_human"] = False
    elif conv.get("status") in ("done", "failed") and not out["transcript"]:
        # Answered and gone at once: hung up, a fax or a machine that said nothing the agent heard.
        out["answer"] = out["answer"] or "No conversation: the call connected and ended before anyone spoke (they hung up, or it was a machine)."
        out["reached_human"] = False
    return judge(out)


def remember(result, args):
    who = result.get("business") or result.get("to")
    answer = result.get("answer") or result.get("summary") or result.get("phone_status") or "no answer"
    body = {
        "entity": f"phone-call:{result['conversation_id']}",
        "kind": "phone-call",
        "name": f"Call to {who}",
        "summary": ((result["warning"] + " ") if result.get("warning") else "") + f"Called {who}: {answer}"[:400],
        "facts": {k: result.get(k) for k in ("to", "business", "goal", "language", "answer", "reached_human", "outcome",
                                             "duration_secs", "phone_status", "ended_because", "call_sid",
                                             "twilio_cost_usd", "elevenlabs_cost_usd", "charged_total", "completed",
                                             "spend", "warning", "unfinished")
                  if result.get(k) is not None},
    }
    body["facts"]["direction"] = "outbound"
    body["facts"]["transcript"] = "\n".join(f"{l['who']}: {l['text']}" for l in result.get("transcript") or [])
    if args.get("thread"):
        body["facts"]["thread"] = args["thread"]
    if result.get("duration_secs"):
        rec = keep_audio(result["conversation_id"])
        if rec:
            body["facts"]["recording"] = rec
            result["recording"] = rec
    record("comms/phone", "observation", body, about=list(args.get("about") or []) + [body["entity"]],
           importance=0.9 if result.get("warning") else None)


