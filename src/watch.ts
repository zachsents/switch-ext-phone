// Watches for calls back to the line: each finished one becomes a record in comms/phone and a
// notification. Its heartbeat (vitals/phone-call) says, from this loop, what is failing now.
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { AppEvents, writeFileAtomic } from "switch-ext-kit"

import {
  eleven,
  health,
  HOME,
  keepAudio,
  line,
  need,
  progress,
  record,
  secrets,
  summarize,
} from "./common.ts"
import type { Health } from "./common.ts"
import { Heartbeat } from "./events.ts"
import { errorText, get, list, named, obj, or, str, textOr, truthy } from "./json.ts"

const STATE = path.join(HOME, "watch-state.json")
const EVERY_S = 120
const HEARTBEAT_S = 300
const LINE_EVERY_S = 6 * 3600

const Skipped = Schema.Struct({
  why: Schema.String,
  at: Schema.Finite,
  start: Schema.optionalKey(Schema.Finite),
})
type Skip = typeof Skipped.Type

const Saved = Schema.Struct({
  since: Schema.Finite,
  seen: Schema.Array(Schema.String),
  skipped: Schema.optionalKey(Schema.Record(Schema.String, Skipped)),
  balance_at: Schema.optionalKey(Schema.Finite),
  warned_broken: Schema.optionalKey(Schema.Boolean),
  warned_low: Schema.optionalKey(Schema.Boolean),
})
const savedOf = Schema.decodeUnknownOption(Schema.fromJsonString(Saved))

interface State {
  since: number
  seen: string[]
  skipped: Map<string, Skip>
  balance_at?: number
  warned_broken?: boolean
  warned_low?: boolean
}

/** What's failing now, by part (callbacks, line), each cleared once that part works again. */
const FAILING = new Map<string, string>()
const LAST: { line: Partial<Health>; lineChecked: number } = { line: {}, lineChecked: 0 }

const now = () => Date.now() / 1000

const load = (): State => {
  let text = ""
  try {
    text = readFileSync(STATE, "utf-8")
  } catch {
    // None yet.
  }
  return Option.match(savedOf(text), {
    onNone: () => ({ since: Math.trunc(now()) - 3600, seen: [], skipped: new Map() }),
    onSome: (s) => ({
      ...s,
      seen: [...s.seen],
      skipped: new Map(Object.entries(s.skipped ?? {})),
    }),
  })
}

const save = (state: State) => {
  writeFileAtomic(STATE, JSON.stringify({ ...state, skipped: Object.fromEntries(state.skipped) }))
}

/** A notification on the user's phone, as `sb notify` sent it: through the core's HTTP port. */
const notify = (title: string, text: string) =>
  Effect.promise(async () => {
    const core = textOr(process.env.SWITCH_URL, "")
    if (core === "") {
      return
    }
    const url = new URL("/widgets/iphone/notify", core)
    if (process.env.SWITCH_TOKEN !== undefined) {
      url.searchParams.set("token", process.env.SWITCH_TOKEN)
    }
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ title, body: text }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null)
  })

const mark = (part: string, trouble: string | null) => {
  if (trouble !== null && trouble !== "") {
    FAILING.set(part, trouble.slice(0, 300))
  } else {
    FAILING.delete(part)
  }
}

/** What's failing now, in a line, or null. */
const failing = (state: State) => {
  const parts = [...FAILING].map(([part, why]) => `${part}: ${why}`)
  const skipped = [...state.skipped]
  let [latest] = skipped
  for (const kept of skipped) {
    if (latest !== undefined && kept[1].at > latest[1].at) {
      latest = kept
    }
  }
  if (latest !== undefined) {
    const n = skipped.length
    parts.push(
      `skipped ${n} call${n === 1 ? "" : "s"} back it couldn't record ` +
        `(latest ${latest[0]}: ${latest[1].why})`,
    )
  }
  return parts.join("; ") || null
}

/** Records one finished call back. */
const take = (cid: string) =>
  Effect.gen(function* taking() {
    const conv = obj(yield* eleven("GET", `/v1/convai/conversations/${cid}`))
    const s = summarize(conv)
    const dc = obj(obj(conv.analysis).data_collection_results)
    const caller = String(or(get(obj(dc.caller), "value"), s.their_number, "someone"))
    const message = String(or(get(obj(dc.message), "value"), s.summary, "(no message)"))
    const back = get(obj(dc.callback_number), "value")
    const rec = truthy(s.duration_secs) ? yield* keepAudio(cid) : null
    yield* record(
      {
        entity: `phone-call:${cid}`,
        kind: "phone-call",
        name: `Call from ${caller}`,
        summary: `${caller} called back: ${message}`.slice(0, 400),
        facts: {
          direction: "inbound",
          caller,
          message,
          callback_number: back,
          their_number: s.their_number,
          duration_secs: s.duration_secs,
          transcript: s.transcript.map((l) => `${l.who}: ${l.text}`).join("\n"),
          recording: rec,
        },
      },
      [`phone-call:${cid}`],
      0.7,
    )
    const secs = typeof s.duration_secs === "number" ? s.duration_secs : 0
    if (s.transcript.length > 0 && secs > 5) {
      yield* notify(`${caller} called back`, message.slice(0, 300))
    }
  })

/** New calls back, and those skipped before: one that fails is kept, with why, and tried again next time. */
const once = (state: State) =>
  Effect.gen(function* checking() {
    const agent = yield* need(yield* secrets, "callback_agent_id")
    const page = obj(
      yield* eleven(
        "GET",
        `/v1/convai/conversations?agent_id=${str(agent)}&page_size=30&call_start_after_unix=${state.since - 600}`,
      ),
    )
    const { skipped } = state
    const todo = new Map<string, number>()
    for (const raw of list(page.conversations)) {
      const c = obj(raw)
      const cid = String(c.conversation_id)
      if (state.seen.includes(cid) || !(c.status === "done" || c.status === "failed")) {
        continue
      }
      todo.set(cid, Math.trunc(Number(or(c.start_time_unix_secs, 0))))
    }
    for (const [cid, kept] of skipped) {
      if (!todo.has(cid)) {
        todo.set(cid, kept.start ?? 0)
      }
    }
    for (const [cid, start] of todo) {
      const done = yield* Effect.exit(take(cid))
      if (Exit.isFailure(done)) {
        skipped.set(cid, {
          why: named(Cause.squash(done.cause)).slice(0, 300),
          at: Math.trunc(now()),
          start,
        })
        continue
      }
      skipped.delete(cid)
      state.seen = [...state.seen, cid].slice(-200)
      state.since = Math.max(state.since, start)
    }
    save(state)
  })

/**
 * The line's health every 6 hours, recorded as phone-line:switch: a notification once when it
 * can't place calls, and once when Twilio's credit drops under $5. While it can't, checked again
 * each heartbeat, unrecorded, so its failing clears once it can.
 */
const checkup = (state: State) =>
  Effect.gen(function* checking() {
    const due = now() - (state.balance_at ?? 0) >= LINE_EVERY_S
    if (!due && !(FAILING.has("line") && now() - LAST.lineChecked >= HEARTBEAT_S)) {
      return
    }
    LAST.lineChecked = now()
    const h = yield* health
    LAST.line = h
    const problems = h.problems.join("; ")
    mark("line", h.ok ? null : problems)
    if (!due) {
      return
    }
    state.balance_at = now()
    const b = h.twilio_balance_usd
    let summary = line() + (b === undefined ? "" : `, Twilio credit $${b.toFixed(2)}`)
    summary += h.ok ? ", ready to call" : `: ${problems}`
    yield* record({
      entity: "phone-line:switch",
      kind: "phone-line",
      name: "Switch's phone line",
      summary: summary.slice(0, 400),
      facts: { ...h, number: line() },
    })
    if (!h.ok && state.warned_broken !== true) {
      yield* notify("My phone line can't place calls", problems.slice(0, 300))
      state.warned_broken = true
    } else if (h.ok) {
      state.warned_broken = false
    }
    if (b !== undefined && b < 5 && state.warned_low !== true) {
      yield* notify(
        "My phone line is low on credit",
        `Twilio has $${b.toFixed(2)} left, about ${Math.trunc(b / 0.16)} minutes of calls to Japanese landlines.`,
      )
      state.warned_low = true
    } else if (b !== undefined && b >= 5) {
      state.warned_low = false
    }
    save(state)
  })

const heartbeat = (state: State) =>
  Effect.gen(function* beating() {
    const events = yield* AppEvents
    const trouble = failing(state)
    const h = LAST.line
    yield* events.emit(
      Heartbeat.record({
        entity: "sense:phone-call",
        summary: (trouble === null ? "Ready" : `Failing: ${trouble}`).slice(0, 600),
        facts: {
          failing: trouble,
          skipped: Object.fromEntries(state.skipped),
          line_ok: h.ok ?? null,
          twilio_balance_usd: h.twilio_balance_usd ?? null,
          line_checked_at: h.checked_at ?? null,
        },
      }),
    )
  })

/** The loop, beside the server for as long as it runs. */
export const watching = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.gen(function* watch() {
      const state = load()
      let lastBeat = 0
      let said: string | null = null
      for (;;) {
        const steps = [
          ["callbacks", "once", once],
          ["line", "checkup", checkup],
        ] as const
        for (const [part, name, step] of steps) {
          const done = yield* Effect.exit(step(state))
          if (Exit.isSuccess(done)) {
            if (part === "callbacks") {
              mark(part, null)
            }
          } else {
            const e = Cause.squash(done.cause)
            mark(part, named(e))
            yield* progress(`watch: ${name}: ${errorText(e)}`)
          }
        }
        const trouble = failing(state)
        if (now() - lastBeat >= HEARTBEAT_S || trouble !== said) {
          const beat = yield* Effect.exit(heartbeat(state))
          if (Exit.isSuccess(beat)) {
            said = trouble
            lastBeat = now()
          } else {
            yield* progress(`watch: heartbeat: ${errorText(Cause.squash(beat.cause))}`)
          }
        }
        yield* Effect.sleep(EVERY_S * 1000)
      }
    }),
  ),
)
