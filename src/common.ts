// Shared bits for the phone extension: config and keys, ElevenLabs and Twilio calls, sending what
// happened as events.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import path from "node:path"
import { Cause, Data, Effect, Result, Schema } from "effect"
import { AppEvents, Host, Progress, writeFileAtomic } from "switch-ext-kit"
import type { Message, Sender } from "switch-ext-kit"

import { Call, Line } from "./events.ts"
import { errorText, get, list, obj, or, parseJson, str, textOr, truthy } from "./json.ts"
import type { Json } from "./json.ts"

/** Its state, where the shim's SB_HOME was: `home` in the folder its host runs it in. */
export const HOME = path.resolve("home")
const CONFIG = path.join(HOME, "config.json")

export class PhoneError extends Data.TaggedError("PhoneError")<{ readonly message: string }> {}

export const fail = (message: string) => Effect.fail(new PhoneError({ message }))

const readJson = (file: string) =>
  Effect.try({
    try: () => parseJson(readFileSync(file, "utf-8")),
    catch: (e) => new PhoneError({ message: errorText(e) }),
  })

/** A field the code can't do without, as Python's `s["key"]` read it. */
export const need = (o: Json, key: string) =>
  o[key] === undefined ? fail(`${key} is missing`) : Effect.succeed(o[key])

/**
 * Run by Switch: the Twilio and ElevenLabs keys are the user's connections (kind "key"), and the
 * agents' and number's ids are config in home/config.json; nothing secret is kept here.
 */
const SWITCH = Boolean(process.env.SWITCH_MACHINE)
const SECRET_KEYS = [
  ["twilio_token", "twilio"],
  ["eleven_key", "elevenlabs"],
] as const

let twilioSid = process.env.PHONE_TWILIO_SID ?? ""

/** The first connected account of a provider and its key. */
const connection = (provider: string) =>
  Effect.gen(function* connecting() {
    const host = yield* Host
    const [account] = yield* host.accounts(provider)
    if (account === undefined) {
      return yield* fail(`${provider} isn't connected`)
    }
    return [account, yield* host.token(provider, account)] as const
  }).pipe(Effect.mapError((e) => new PhoneError({ message: e.message })))

/** Hands the keys a Switchboard copy kept to the user's connections, then keeps only the ids, as config. */
const adopt = (file: string) =>
  Effect.gen(function* adopting() {
    const host = yield* Host
    const held = obj(yield* readJson(file))
    // The Twilio account is named by its SID (an older copy kept it in code; its file says it as twilio_sid).
    const sid = String(or(held.twilio_sid, twilioSid))
    if (truthy(held.twilio_token) && !sid.startsWith("AC")) {
      yield* fail(`${file} has a Twilio token but no twilio_sid (AC…) to name its account`)
    }
    for (const [key, provider] of SECRET_KEYS) {
      if (truthy(held[key])) {
        yield* host
          .request(
            "connections/adopt",
            {
              provider,
              account: provider === "twilio" ? sid : "elevenlabs",
              grant: { secret: held[key] },
            },
            Schema.Unknown,
          )
          .pipe(Effect.mapError((e) => new PhoneError({ message: e.message })))
      }
    }
    const config = Object.fromEntries(
      Object.entries(held).filter(([k]) => !SECRET_KEYS.some(([secret]) => secret === k)),
    )
    writeFileAtomic(CONFIG, JSON.stringify(config))
    chmodSync(CONFIG, 0o600)
    rmSync(file)
  })

/** The Twilio number calls go out from (and come back to): config.json's "line", else PHONE_LINE. */
export const line = (): string => {
  if (existsSync(CONFIG)) {
    const got = obj(
      Result.getOrUndefined(Result.try(() => parseJson(readFileSync(CONFIG, "utf-8")))),
    ).line
    if (truthy(got)) {
      return String(got)
    }
  }
  return process.env.PHONE_LINE ?? ""
}

/**
 * {eleven_key, twilio_token, agent_id, callback_agent_id, phone_number_id}: in Switch the keys from
 * the user's connections and the ids from home/config.json; else all kept in home/secrets.json (0600).
 */
export const secrets = Effect.gen(function* reading() {
  const file = textOr(process.env.PHONE_SECRETS, path.join(HOME, "secrets.json"))
  if (!SWITCH) {
    return obj(yield* readJson(file))
  }
  if (existsSync(file)) {
    yield* adopt(file)
  }
  const out = { ...obj(yield* readJson(CONFIG)) }
  const [account, token] = yield* connection("twilio")
  out.twilio_token = token
  twilioSid = String(or(out.twilio_sid, account))
  const [, key] = yield* connection("elevenlabs")
  out.eleven_key = key
  return out
})

const ME_CARD =
  "const c = Application('Contacts').myCard(); " +
  "JSON.stringify(c ? {name: c.nickname() || c.firstName() || '', name_ja: c.phoneticFirstName() || ''} : {})"

/**
 * [name, nameJa]: the user's name as callers hear it, and how to say it in Japanese (e.g. katakana).
 * From home/config.json's "name" and "name_ja", else this Mac's Contacts card for the user (My Card:
 * its nickname or first name, and its phonetic first name).
 */
export const callerName = Effect.gen(function* naming() {
  const config = existsSync(CONFIG) ? obj(yield* readJson(CONFIG)) : {}
  let card: Json = {}
  if (!(truthy(config.name) && truthy(config.name_ja))) {
    const said = yield* Effect.promise(async () => {
      const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", ME_CARD], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      })
      const stdout = await new Response(proc.stdout).text()
      return { code: await proc.exited, stdout }
    })
    if (said.code === 0 && said.stdout.trim()) {
      card = obj(
        yield* Effect.try({
          try: () => parseJson(said.stdout),
          catch: (e) => new PhoneError({ message: errorText(e) }),
        }),
      )
    }
  }
  const name = String(or(config.name, card.name, "")).trim()
  if (!name) {
    return yield* fail(
      'no name for the user: set "name" in the phone extension\'s config.json or fill in My Card in Contacts',
    )
  }
  return [name, String(or(config.name_ja, card.name_ja, name)).trim()] as const
})

const http = (
  method: string,
  url: string,
  body: Json | null = null,
  headers: Readonly<Record<string, string>> = {},
  form = false,
  timeout = 30,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const sent: Record<string, string> = { ...headers }
      let data: string | null = null
      if (body !== null) {
        if (form) {
          data = new URLSearchParams(
            Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]),
          ).toString()
          sent["Content-Type"] = "application/x-www-form-urlencoded"
        } else {
          data = JSON.stringify(body)
          sent["Content-Type"] = "application/json"
        }
      }
      const res = await fetch(url, {
        method,
        headers: sent,
        body: data,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]),
      })
      const raw = await res.text()
      if (!res.ok) {
        throw new PhoneError({
          message: `${method} ${url.split("?")[0]} -> ${res.status}: ${raw.slice(0, 1500)}`,
        })
      }
      return raw ? parseJson(raw) : {}
    },
    catch: (e) => (e instanceof PhoneError ? e : new PhoneError({ message: errorText(e) })),
  })

export const eleven = (method: string, route: string, body: Json | null = null) =>
  Effect.gen(function* asking() {
    const key = yield* need(yield* secrets, "eleven_key")
    return yield* http(method, `https://api.elevenlabs.io${route}`, body, {
      "xi-api-key": str(key),
    })
  })

export const twilio = (method: string, route: string, body: Json | null = null) =>
  Effect.gen(function* asking() {
    // First: in Switch it also says which account.
    const token = yield* need(yield* secrets, "twilio_token")
    const auth = Buffer.from(`${twilioSid}:${str(token)}`).toString("base64")
    return yield* http(
      method,
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}${route}`,
      body,
      { Authorization: `Basic ${auth}` },
      true,
    )
  })

/** A number as Python's float() reads one: a number or a numeric string, else a failure. */
const float = (v: unknown) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v
  return typeof n === "number" && !Number.isNaN(n)
    ? Effect.succeed(n)
    : fail(`could not convert to float: ${JSON.stringify(v)}`)
}

const field = (o: unknown, key: string) =>
  key in obj(o) ? Effect.succeed(obj(o)[key]) : fail(`no ${key} in the answer`)

export interface Health {
  readonly [key: string]: unknown
  readonly number: string
  readonly twilio_balance_usd?: number
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly checked_at: number
}

/**
 * Whether the line can place a call now: Twilio's credit and the number still on the account,
 * ElevenLabs' key, the caller agent, the number there with outbound calls, callbacks reaching the
 * message-taking agent, and credit left.
 */
export const health = Effect.gen(function* checking() {
  const s = yield* secrets
  const number = line()
  const out: Record<string, unknown> = { number }
  const problems: string[] = []

  // Each check says what failed; the rest still run.
  const check = <A, E, R>(what: string, f: Effect.Effect<A, E, R>) =>
    Effect.catchCause(f, (cause) =>
      Effect.sync(() => {
        problems.push(`${what}: ${errorText(Cause.squash(cause))}`.slice(0, 300))
        return null
      }),
    )

  const balance = yield* check(
    "Twilio credit",
    Effect.flatMap(twilio("GET", "/Balance.json"), (r) =>
      Effect.flatMap(field(r, "balance"), float),
    ),
  )
  let twilioBalance: number | undefined
  if (balance !== null) {
    twilioBalance = Math.round(balance * 100) / 100
    out.twilio_balance_usd = twilioBalance
    if (balance < 1) {
      problems.push(`Twilio has $${balance.toFixed(2)} left, too little for a call`)
    }
  }
  const numbers = yield* check(
    "Twilio number",
    Effect.flatMap(
      twilio("GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(line())}`),
      (r) => field(r, "incoming_phone_numbers"),
    ),
  )
  if (numbers !== null && !truthy(numbers)) {
    problems.push(`${line()} is no longer on the Twilio account`)
  }
  yield* check(
    "ElevenLabs caller agent",
    Effect.gen(function* agent() {
      const id = yield* need(s, "agent_id")
      return yield* field(yield* eleven("GET", `/v1/convai/agents/${str(id)}`), "agent_id")
    }),
  )
  const phone = yield* check(
    "ElevenLabs phone number",
    Effect.gen(function* phoneNumber() {
      const id = yield* need(s, "phone_number_id")
      return yield* eleven("GET", `/v1/convai/phone-numbers/${str(id)}`)
    }),
  )
  if (truthy(phone)) {
    const p = obj(phone)
    if (!truthy(p.supports_outbound)) {
      problems.push("ElevenLabs has the number without outbound calls")
    }
    const answered = get(obj(p.assigned_agent), "agent_id") === get(s, "callback_agent_id")
    out.callbacks_answered = answered
    if (!answered) {
      problems.push("calls back to the line no longer reach the message-taking agent")
    }
  }
  const plan = obj(yield* check("ElevenLabs credit", eleven("GET", "/v1/user/subscription")))
  if (truthy(plan.character_limit)) {
    const left = Number(plan.character_limit) - Number(or(plan.character_count, 0))
    out.elevenlabs_credits_left = left
    if (left < 1000) {
      problems.push(`ElevenLabs has ${left} credits left`)
    }
  }
  const checked: Health = {
    ...out,
    number,
    ...(twilioBalance !== undefined && { twilio_balance_usd: twilioBalance }),
    ok: problems.length === 0,
    problems,
    checked_at: Date.now(),
  }
  return checked
})

/** Says how a call is going: on stderr, and to whoever called the tool (its progress). */
export const progress = (said: string) =>
  Effect.gen(function* saying() {
    process.stderr.write(`${said}\n`)
    const tell = yield* Progress
    yield* tell(said)
  })

/** Sends what happened as an event, for its keeper to record in comms/phone. */
export const record = (body: Json, about?: readonly string[], importance?: number) =>
  Effect.gen(function* recording() {
    const events = yield* AppEvents
    const envelope = {
      ...(about !== undefined && { about }),
      ...(importance !== undefined && { importance }),
    }
    if (String(or(body.entity, "")).startsWith("phone-line:")) {
      yield* Effect.orDie(events.emit(Line.record(body, envelope)))
      return
    }
    const f = obj(body.facts)
    const number = String(or(f.their_number, ""))
    const sender: Sender =
      f.direction === "inbound"
        ? {
            handle: number || "unknown",
            via: "phone",
            ...(truthy(f.caller) && f.caller !== "someone" && { name: String(f.caller) }),
          }
        : { handle: "me", via: "phone", me: true }
    const message: Message = {
      id: String(body.entity),
      conversation: `phone:${number}`,
      text: String(or(f.message, body.summary, "")),
      at: Date.now(),
      channel: "phone",
    }
    yield* Effect.orDie(events.emit(Call.record(body, { ...envelope, sender, message })))
  })

/** A file of the core's blob store, as `sb blob put` stored it: through the core's HTTP port. */
const putBlob = (file: string, type: string) =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL("/blobs", process.env.SWITCH_URL)
      if (process.env.SWITCH_TOKEN !== undefined) {
        url.searchParams.set("token", process.env.SWITCH_TOKEN)
      }
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": type },
        body: Bun.file(file),
        signal: AbortSignal.timeout(120_000),
      })
      const said = obj(await res.json().catch(() => ({})))
      if (!res.ok || typeof said.hash !== "string") {
        throw new Error(`blob put: ${String(or(said.error, res.status))}`)
      }
      return `sha256:${said.hash}`
    },
    catch: errorText,
  })

/** Saves the call's recording (both sides, mp3) beside the extension and as a blob; {blob, type, bytes} or null. */
export const keepAudio = (cid: string, tries = 5) =>
  Effect.gen(function* keeping() {
    const folder = path.join(HOME, "recordings")
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, `${cid}.mp3`)
    for (let i = 0; i < tries; i += 1) {
      if (!existsSync(file)) {
        const key = str(yield* need(yield* secrets, "eleven_key"))
        const got = yield* Effect.result(
          Effect.tryPromise({
            try: async () => {
              const res = await fetch(
                `https://api.elevenlabs.io/v1/convai/conversations/${cid}/audio`,
                { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(60_000) },
              )
              if (!res.ok) {
                throw new Error(`HTTP Error ${res.status}: ${res.statusText}`)
              }
              const data = await res.bytes()
              if (data.length > 1000) {
                const temp = `${file}.${process.pid}.tmp`
                await Bun.write(temp, data)
                renameSync(temp, file)
              }
            },
            catch: errorText,
          }),
        )
        if (Result.isFailure(got)) {
          yield* progress(`(recording not ready: ${got.failure})`)
        }
      }
      if (existsSync(file)) {
        break
      }
      // The audio lands a little after the conversation closes.
      yield* Effect.sleep(5000 * (i + 1))
    }
    if (!existsSync(file)) {
      return null
    }
    const out: Record<string, unknown> = {
      type: "audio/mpeg",
      bytes: statSync(file).size,
      name: `${cid}.mp3`,
    }
    if (textOr(process.env.SWITCH_URL, "") !== "") {
      const stored = yield* Effect.result(putBlob(file, "audio/mpeg"))
      if (Result.isSuccess(stored)) {
        out.blob = stored.success
      } else {
        yield* progress(`(couldn't store the recording: ${stored.failure})`)
      }
    }
    return out
  })

export interface TranscriptLine {
  readonly t: number
  readonly who: string
  readonly text: string
}

export const transcriptLines = (conv: Json): TranscriptLine[] =>
  list(conv.transcript).flatMap((raw) => {
    const t = obj(raw)
    const text = String(or(t.message, "")).trim()
    if (!text) {
      return []
    }
    const who = t.role === "agent" ? "Me" : "Them"
    return [{ t: Math.round(Number(or(t.time_in_call_secs, 0))), who, text }]
  })

/** A figure from the call's analysis as a number, whether it came as 14, "14" or "$14.00"; null when it's none. */
export const amount = (value: unknown): number | null => {
  if (typeof value === "number") {
    return value
  }
  const said = String(value)
    .replaceAll(",", "")
    .trim()
    .replace(/^[$¥£€]+/u, "")
  const n = said.trim() ? Number(said) : Number.NaN
  return Number.isNaN(n) ? null : n
}

/** A call's result: what summarize found, and what was added on the way. */
export interface Summary {
  [key: string]: unknown
  readonly transcript: readonly TranscriptLine[]
}

/** The parts of a finished ElevenLabs conversation worth handing back. */
export const summarize = (conv: Json, extra?: Json): Summary => {
  const meta = obj(conv.metadata)
  const analysis = obj(conv.analysis)
  const dc = obj(analysis.data_collection_results)
  const phone = obj(meta.phone_call)
  const value = (key: string) => get(obj(dc[key]), "value")
  const result: Summary = {
    conversation_id: get(conv, "conversation_id"),
    status: get(conv, "status"),
    answer: value("answer"),
    reached_human: value("reached_human"),
    unsure: or(value("unsure"), null),
    outcome: get(analysis, "call_successful"),
    summary: get(analysis, "transcript_summary"),
    duration_secs: get(meta, "call_duration_secs"),
    ended_because: or(meta.termination_reason, null),
    direction: get(phone, "direction"),
    their_number: get(phone, "external_number"),
    call_sid: get(phone, "call_sid"),
    transcript: transcriptLines(conv),
    elevenlabs_cost_usd: typeof meta.cost_fiat === "number" ? meta.cost_fiat : null,
    charged_total: amount(value("charged_total")),
    completed: value("completed"),
  }
  if (extra !== undefined && truthy(extra)) {
    Object.assign(result, extra)
  }
  return result
}
