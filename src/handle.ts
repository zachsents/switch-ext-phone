// What the phone extension does for a request: place a call, follow one, and say how the line stands.
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Result, Schema } from "effect"
import { writeFileAtomic } from "switch-ext-kit"

import { EN_VOICE, JA_VOICE } from "./agent.ts"
import {
  callerName,
  eleven,
  fail,
  HOME,
  keepAudio,
  line,
  need,
  progress,
  record,
  secrets,
  summarize,
  transcriptLines,
  twilio,
} from "./common.ts"
import type { Summary } from "./common.ts"
import { get, numberOr, obj, or, str, textOr, truthy } from "./json.ts"
import type { Json } from "./json.ts"

const LANGS = { ja: "Japanese", en: "English" } as const
type Lang = keyof typeof LANGS
const isLang = (s: string): s is Lang => s === "ja" || s === "en"

const CURRENCIES = [
  ["+852", "HKD"],
  ["+886", "TWD"],
  ["+81", "JPY"],
  ["+82", "KRW"],
  ["+44", "GBP"],
  ["+61", "AUD"],
  ["+65", "SGD"],
  ["+1", "USD"],
] as const
const SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  JPY: "¥",
  GBP: "£",
  AUD: "A$",
  KRW: "₩",
  HKD: "HK$",
  TWD: "NT$",
  SGD: "S$",
}
// Currencies counted without cents.
const WHOLE = new Set(["JPY", "KRW", "TWD"])

/** What the call tool takes. */
export interface CallArgs {
  readonly to: string
  readonly goal: string
  readonly business?: string
  readonly context?: string
  readonly language?: string
  readonly country?: string
  readonly may_book?: boolean
  readonly max_spend?: number
  readonly currency?: string
  readonly max_minutes?: number
  readonly about?: readonly string[]
  readonly thread?: string
  readonly dry_run?: boolean
  readonly allow_late?: boolean
  readonly keywords?: readonly string[]
  readonly ring_secs?: number
}

/** The most the user approved paying, and its currency. */
type Limit = readonly [number, string]

const currencyOf = (e164: string) => CURRENCIES.find(([prefix]) => e164.startsWith(prefix))?.[1]

/** An amount as it's said: $10.00, ¥3,000, 25.00 EUR. */
const money = ([amount, currency]: Limit) => {
  const digits = WHOLE.has(currency) ? 0 : 2
  const figure = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount)
  const symbol = SYMBOLS[currency]
  return symbol === undefined ? `${figure} ${currency}` : symbol + figure
}

/**
 * The most the user approved paying on the call, all in, and its currency. A call that may book
 * must say it; one that may not can pay nothing.
 */
const spendLimit = (args: CallArgs, to: string) =>
  Effect.gen(function* limiting() {
    const currency = textOr(args.currency, currencyOf(to) ?? "").toUpperCase()
    if (args.may_book !== true) {
      return [0, currency || "USD"] as const
    }
    if (args.max_spend === undefined) {
      return yield* fail(
        "may_book needs max_spend: the most the user approved paying on this call, all in (fees, fare " +
          "differences, taxes, deposits), as a number; 0 if nothing may be charged",
      )
    }
    if (!currency) {
      return yield* fail(`give currency for max_spend: I can't tell which one ${to} pays in`)
    }
    if (args.max_spend < 0) {
      return yield* fail("max_spend can't be negative")
    }
    return [args.max_spend, currency] as const
  })

const CODES: Readonly<Record<string, string>> = { JP: "81", UK: "44", GB: "44", KR: "82", AU: "61" }

/** E.164 from what people write: +81 848-00-0000, 0848-00-0000 (Japan), (555) 010-0000, 1-555-... */
const normalize = (number: string, country?: string) =>
  Effect.gen(function* normalizing() {
    const raw = number.trim()
    const digits = raw.replaceAll(/\D/gu, "")
    let e164: string
    if (raw.startsWith("+")) {
      e164 = `+${digits}`
    } else if (raw.startsWith("00")) {
      e164 = `+${digits.slice(2)}`
    } else if (digits.startsWith("0")) {
      // A domestic number with a trunk 0: Japan unless told otherwise.
      const cc = CODES[textOr(country, "JP").toUpperCase()]
      if (cc === undefined) {
        return yield* fail(`don't know the country code for ${str(country)}`)
      }
      e164 = `+${cc}${digits.slice(1)}`
    } else if (digits.length === 10) {
      e164 = `+1${digits}`
    } else if (digits.length === 11 && digits.startsWith("1")) {
      e164 = `+${digits}`
    } else {
      return yield* fail(
        `can't tell what country '${number}' is in: give it with + and its country code`,
      )
    }
    if (e164.length < 9 || e164.length > 16) {
      return yield* fail(`${e164} doesn't look like a phone number`)
    }
    return e164
  })

const ZONES = [
  ["+81", 9],
  ["+82", 9],
  ["+44", 0],
  ["+852", 8],
  ["+886", 8],
  ["+65", 8],
] as const

/** The hour where the number rings, for the countries a single zone covers; null elsewhere. */
const localHour = (e164: string) => {
  const zone = ZONES.find(([prefix]) => e164.startsWith(prefix))
  return zone === undefined ? null : (new Date().getUTCHours() + zone[1]) % 24
}

/** The brief's hard spending limit, for a call that may book: the one rule the caller never bends. */
const moneyRules = (limit: Limit, lang: Lang, name: string, nameJa: string) => {
  const cap = money(limit)
  const refusal =
    lang === "ja"
      ? `「申し訳ございません。${nameJa}が了承している金額を超えてしまうため、こちらではお受けできません。` +
        "変更やご請求はせずにお待ちいただけますでしょうか。本人に確認して、改めてお電話いたします。」"
      : `"I'm sorry, that's more than ${name} approved, so I can't agree to it. Please don't make the change or ` +
        `charge anything. I'll check with him and call back."`
  const allowed =
    limit[0] > 0
      ? `- If the total is ${cap} or less, you may agree: say the total back once ("So that's [total] in all") and go ahead.\n`
      : `- ${name} hasn't approved paying anything, so if anything at all would be charged (a fee, a deposit, a card guarantee charge), you can't agree to it.\n`
  return `
# Money: ${name}'s limit, which you never go over
${name} approved paying at most ${cap} on this call, all in: every fee, fare or price difference, tax, surcharge, deposit, upgrade and separate charge, added together. This limit is absolute. Nothing lets you go over it: not a small difference ("it's only a few dollars more"), not a fare increase or a fee you weren't told about, not a reason that sounds fair, and not their having already started.
- Before you agree to anything that costs money, ask for the total that will be charged, all in, and add up every charge they mention yourself.
${allowed}- If the total is more than ${cap}, even by a little, or they can't tell you the total: do NOT agree, and never say "that's fine", "okay" or "go ahead" to it. Say: ${refusal} Then ask what the total would be and how long the price or the seat holds, thank them, and end the call.
- If they bring up another charge after you've agreed (a fare increase, a tax, a second charge), add it to the total and decide again by the same rule before they process it.
- If they say they've already charged more than ${cap}, say ${name} didn't approve that and ask them to reverse it, and note exactly what they say.
`
}

const brief = (args: CallArgs, lang: Lang, limit: Limit) =>
  Effect.gen(function* briefing() {
    const business = textOr(args.business, "the business")
    const goal = args.goal.trim()
    const context = textOr(args.context, "").trim()
    const mayBook = args.may_book === true
    const [name, nameJa] = yield* callerName
    const intro =
      lang === "ja"
        ? "Open, once they've answered, with a short polite introduction in natural phone Japanese, e.g. " +
          `「お忙しいところ恐れ入ります。${nameJa}というお客様の代わりにお電話しております、AIアシスタントです。」 ` +
          "then ask your question straight away. Speak polite 敬語 (です/ます, 恐れ入りますが, よろしいでしょうか), " +
          `short sentences, the way a considerate customer would. Say ${name}'s name as ${nameJa}. ` +
          "End with 「お忙しいところありがとうございました。失礼いたします。」"
        : `Open, once they've answered, with a short friendly introduction, e.g. "Hi, I'm an AI assistant ` +
          `calling on behalf of a customer, ${name}. This call is recorded." (always say it's recorded) then ask your question straight away.`
    const booking = mayBook
      ? "You MAY make the booking, reservation or change described in the goal, within exactly the terms given there " +
        `and ${name}'s money limit; confirm every detail back before agreeing, and get any confirmation number or name ` +
        "it's under. It isn't done until they say it's done: stay on the line while they make it, then confirm what's " +
        "booked and the total charged. If they start to wrap up before saying it's done or giving a confirmation " +
        "number, ask for it before you say goodbye."
      : `Do NOT make, hold or cancel any reservation, booking, order or payment, and don't promise ${name} will come. ` +
        `If they offer to hold something, thank them, say ${name} will decide and call back, and note what they offered ` +
        "(how long they'd hold it, under what name)."
    return `You are Switch, ${name}'s AI assistant, on a phone call you placed to ${business} for him. You speak ${LANGS[lang]} on this call.

# Why you're calling
${goal}

# What you may tell them if it helps or they ask
${context || `Only that you're calling for a customer named ${name}. You don't have other details; say ${name} will follow up if they need more.`}
${mayBook ? moneyRules(limit, lang, name, nameJa) : ""}
# How to handle the call
- Wait for them to answer and speak first. ${intro}
- You are an AI and say so in your introduction. If asked, never claim to be human.
- Keep each turn to one or two short sentences; this is a phone call. Let them finish; don't talk over them.
- Get concrete facts: yes/no, numbers, times, prices, conditions (e.g. how late you can arrive, whether it's first come first served, whether they take reservations by phone).
- The line is a noisy phone line and numbers are what matter most. If a number, time or price sounds odd, garbled, or doesn't fit what was said before, ask them to say it again (e.g. 「恐れ入ります、何時までとおっしゃいましたか」 / "Sorry, what time was that?"). Never guess a number.
- Before hanging up, confirm the key facts back one at a time in a short list, and listen for corrections; if they correct something, repeat the corrected figure back once more.
- ${booking}
- Never give card numbers, addresses, ID numbers or anyone's personal details beyond what's listed above.
- If they ask something you don't know, say ${name} will check and call back. Don't invent details.
- Phone menu (IVR): use the keypad tool to reach a person or the right department.
- Holds: when they put you on hold, transfer you, or ask you to wait ("give me a moment", "let me check", 少々お待ちください), say once that you'll wait, then stay silent with the skip_turn tool until they speak again. Silence and hold music are normal; never end the call while they're looking something up or making a change, and don't keep checking in.
- A recording or voicemail (e.g. closed today, outside hours): listen to the whole message for hours or other numbers, leave no message, then end the call.
- If they're busy, can't help, or ask you to call back later, ask when is best, thank them and end the call.
- When you have the answer${mayBook ? " (for a booking or change: once they've said it's done and you've confirmed what's booked and the total)" : ""}, thank them and end the call with the end_call tool. Don't linger.
`
  })

/** Words the recognizer should expect: the business's name and whatever the caller adds. */
const keywords = (args: CallArgs) => {
  const business = textOr(args.business, "")
  const words = business ? business.split(/[\s,、・()（）]+/u).filter((w) => w.length > 1) : []
  return [...new Set([...(args.keywords ?? []), ...words])].slice(0, 50)
}

const overrideFor = (args: CallArgs, lang: Lang, maxMinutes: number, limit: Limit) =>
  Effect.map(brief(args, lang, limit), (prompt) => ({
    agent: { prompt: { prompt }, language: lang, first_message: "" },
    tts: { voice_id: lang === "ja" ? JA_VOICE : EN_VOICE },
    conversation: { max_duration_seconds: maxMinutes * 60 },
    asr: { keywords: keywords(args) },
  }))

type Override = Effect.Success<ReturnType<typeof overrideFor>>

export const placeCall = (args: CallArgs) =>
  Effect.gen(function* placing() {
    const s = yield* secrets
    const to = yield* normalize(args.to, args.country)
    const lang = textOr(args.language, to.startsWith("+81") ? "ja" : "en").toLowerCase()
    if (!isLang(lang)) {
      return yield* fail(`language must be one of ${JSON.stringify(Object.keys(LANGS).toSorted())}`)
    }
    if (!args.goal.trim()) {
      return yield* fail("goal is required: what to find out or do on the call")
    }
    const hour = localHour(to)
    if (hour !== null && !(hour >= 8 && hour < 21) && args.allow_late !== true) {
      return yield* fail(
        `it's ${hour}:00 where ${to} rings; I don't call businesses between 21:00 and 08:00 their time ` +
          "(allow_late: true overrides)",
      )
    }
    const limit = yield* spendLimit(args, to)
    // A booking or change waits on their systems and holds, so it gets longer than a question.
    const maxMinutes = Math.max(
      1,
      Math.min(numberOr(args.max_minutes, args.may_book === true ? 12 : 6), 15),
    )
    const override = yield* overrideFor(args, lang, maxMinutes, limit)
    if (args.dry_run === true) {
      return {
        dry_run: true,
        to,
        language: lang,
        max_minutes: maxMinutes,
        max_spend: money(limit),
        keywords: override.asr.keywords,
        brief: override.agent.prompt.prompt,
      }
    }
    yield* progress(
      `Dialing ${textOr(args.business, to)} (${to}) in ${LANGS[lang]} from ${line()}${args.may_book === true ? `, may spend up to ${money(limit)}` : ""}`,
    )
    return yield* dial(s, to, lang, args, override, maxMinutes, limit)
  })

const termsPath = (cid: unknown) => path.join(HOME, "calls", `${str(cid)}.json`)

/** Keeps what the call was allowed to commit to, so its result can be held to it, however it's fetched. */
const keepTerms = (cid: string, args: CallArgs, limit: Limit) => {
  writeFileAtomic(
    termsPath(cid),
    JSON.stringify({ may_book: args.may_book === true, max_spend: limit[0], currency: limit[1] }),
  )
}

const Terms = Schema.Struct({
  may_book: Schema.Boolean,
  max_spend: Schema.Finite,
  currency: Schema.String,
})
const termsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Terms))

/**
 * Holds a finished call to its terms: a total agreed over the limit (anything at all, on a call
 * that may not book) becomes a warning, and a booking call that ended before they said it was done
 * is marked unfinished.
 */
const judge = (out: Summary) => {
  const read = Result.try(() => readFileSync(termsPath(out.conversation_id), "utf-8"))
  const terms = Result.isSuccess(read) ? termsOf(read.success) : undefined
  if (terms === undefined || terms._tag === "None") {
    return out
  }
  const { may_book: mayBook, max_spend: limit, currency } = terms.value
  const agreed = out.charged_total
  const over = typeof agreed === "number" && agreed > limit + 0.005
  out.spend = { limit, currency, agreed, over_limit: over }
  if (over && typeof agreed === "number") {
    const allowed = mayBook
      ? `the ${money([limit, currency])} the user approved`
      : "a call that wasn't allowed to pay anything"
    out.warning =
      `The caller agreed to ${money([agreed, currency])}, over ${allowed}. Tell the user first, ` +
      "and check what was actually charged."
  }
  if (mayBook && out.status === "done" && out.completed !== true) {
    out.unfinished = `They hadn't said the booking or change was done when the call ended${
      truthy(out.ended_because) ? ` (${str(out.ended_because).replace(/\.+$/u, "")})` : ""
    }: check the booking page or the confirmation email before telling the user it went through.`
  }
  return out
}

const dial = (
  s: Json,
  to: string,
  lang: Lang,
  args: CallArgs,
  override: Override,
  maxMinutes: number,
  limit: Limit,
) =>
  Effect.gen(function* dialing() {
    const started = Date.now() / 1000
    const r = obj(
      yield* eleven("POST", "/v1/convai/twilio/outbound-call", {
        agent_id: yield* need(s, "agent_id"),
        agent_phone_number_id: yield* need(s, "phone_number_id"),
        to_number: to,
        conversation_initiation_client_data: { conversation_config_override: override },
        telephony_call_config: { ringing_timeout_secs: Math.trunc(args.ring_secs ?? 40) },
      }),
    )
    if (!truthy(r.success) || !truthy(r.conversation_id)) {
      return yield* fail(`the call didn't start: ${str(or(r.message, JSON.stringify(r)))}`)
    }
    const cid = str(r.conversation_id)
    const callSid = truthy(r.callSid) ? str(r.callSid) : null
    keepTerms(cid, args, limit)
    yield* progress(`Ringing (conversation ${cid})`)
    const result = yield* follow(cid, callSid, started + maxMinutes * 60 + 180)
    Object.assign(result, {
      to,
      business: args.business ?? null,
      goal: args.goal,
      language: lang,
    })
    yield* remember(result, args)
    return result
  })

const ENDED = new Set(["busy", "no-answer", "failed", "canceled"])
const ended = (status: unknown) => typeof status === "string" && ENDED.has(status)
const finished = (conv: Json) => conv.status === "done" || conv.status === "failed"

/** Waits for the call to end and its analysis to finish, saying the conversation as it goes. */
export const follow = (cid: string, callSid: string | null, deadline?: number) =>
  Effect.gen(function* following() {
    let seen = 0
    let conv: Json = {}
    let twilioStatus: unknown = null
    const until = deadline ?? Date.now() / 1000 + 900
    while (Date.now() / 1000 < until) {
      yield* Effect.sleep(3000)
      const got = yield* Effect.result(eleven("GET", `/v1/convai/conversations/${cid}`))
      if (Result.isFailure(got)) {
        yield* progress(`(waiting: ${got.failure.message})`)
        continue
      }
      conv = obj(got.success)
      const lines = transcriptLines(conv)
      for (const l of lines.slice(seen)) {
        yield* progress(`${l.who}: ${l.text}`)
      }
      seen = lines.length
      if (callSid !== null && lines.length === 0) {
        const call = yield* Effect.result(twilio("GET", `/Calls/${callSid}.json`))
        if (Result.isSuccess(call)) {
          twilioStatus = get(obj(call.success), "status")
        }
        if (ended(twilioStatus)) {
          yield* progress(`The call ended: ${str(twilioStatus)}`)
          // Give ElevenLabs a moment to close the conversation, then hand back what we know.
          yield* Effect.sleep(4000)
          const again = yield* Effect.result(eleven("GET", `/v1/convai/conversations/${cid}`))
          if (Result.isSuccess(again)) {
            conv = obj(again.success)
          }
          break
        }
      }
      if (finished(conv)) {
        break
      }
    }
    return yield* settle(cid, callSid, conv, twilioStatus)
  })

/** What a call came to, once it ended or the wait did. */
const settle = (cid: string, callSid: string | null, conv: Json, twilioStatus: unknown) =>
  Effect.gen(function* settling() {
    const extra: Record<string, unknown> = { phone_status: twilioStatus }
    if (callSid !== null) {
      const call = yield* Effect.result(twilio("GET", `/Calls/${callSid}.json`))
      if (Result.isSuccess(call)) {
        const c = obj(call.success)
        extra.phone_status = get(c, "status")
        const price = truthy(c.price) ? Number(c.price) : null
        if (price === null) {
          extra.twilio_cost_usd = null
        } else if (!Number.isNaN(price)) {
          extra.twilio_cost_usd = Math.abs(price)
        }
      }
    }
    if (!finished(conv) && !ended(extra.phone_status)) {
      extra.note = "Stopped waiting before the call finished; the result action fetches it later."
    }
    const out = summarize(truthy(conv) ? conv : { conversation_id: cid }, extra)
    if (ended(out.phone_status) && out.transcript.length === 0) {
      out.answer = or(out.answer, `No conversation: the line was ${str(out.phone_status)}.`)
      out.reached_human = false
    } else if (finished(conv) && out.transcript.length === 0) {
      // Answered and gone at once: hung up, a fax or a machine that said nothing the agent heard.
      out.answer = or(
        out.answer,
        "No conversation: the call connected and ended before anyone spoke (they hung up, or it was a machine).",
      )
      out.reached_human = false
    }
    return judge(out)
  })

const FACTS = [
  "to",
  "business",
  "goal",
  "language",
  "answer",
  "reached_human",
  "outcome",
  "duration_secs",
  "phone_status",
  "ended_because",
  "call_sid",
  "twilio_cost_usd",
  "elevenlabs_cost_usd",
  "charged_total",
  "completed",
  "spend",
  "warning",
  "unfinished",
] as const

const remember = (result: Summary, args: CallArgs) =>
  Effect.gen(function* remembering() {
    const who = str(or(result.business, result.to))
    const answer = str(or(result.answer, result.summary, result.phone_status, "no answer"))
    const entity = `phone-call:${str(result.conversation_id)}`
    const facts: Record<string, unknown> = {}
    for (const k of FACTS) {
      if (result[k] !== null && result[k] !== undefined) {
        facts[k] = result[k]
      }
    }
    facts.direction = "outbound"
    facts.transcript = result.transcript.map((l) => `${l.who}: ${l.text}`).join("\n")
    if (textOr(args.thread, "") !== "") {
      facts.thread = args.thread
    }
    if (truthy(result.duration_secs)) {
      const rec = yield* keepAudio(str(result.conversation_id))
      if (rec) {
        facts.recording = rec
        result.recording = rec
      }
    }
    const body = {
      entity,
      kind: "phone-call",
      name: `Call to ${who}`,
      summary:
        (truthy(result.warning) ? `${str(result.warning)} ` : "") +
        `Called ${who}: ${answer}`.slice(0, 400),
      facts,
    }
    yield* record(body, [...(args.about ?? []), entity], truthy(result.warning) ? 0.9 : undefined)
  })
