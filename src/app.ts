// The phone extension: `call`, `result` and `status` are its tools, the calls it places and takes go
// out as `call` events (comms/phone), and the line's health as `line`. The callback watcher runs
// beside it (watch.ts).
import { Schema } from "effect"
import { defineApp, tool } from "switch-ext-kit"
import type { AppEventsService, HostService } from "switch-ext-kit"

import { health } from "./common.ts"
import { Call, Heartbeat, Line } from "./events.ts"
import { follow, placeCall } from "./handle.ts"
import { numberOr, textOr } from "./json.ts"

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description })

const CallInput = Schema.Struct({
  to: described(
    Schema.String,
    "The number as written: +81 848-..., 0848-00-0000 (a leading 0 means Japan unless country says otherwise), (310) 555-0100.",
  ),
  goal: described(
    Schema.String,
    "What to find out or do, specifically, with what matters for judging the answer (e.g. 'Do they have 2 adult crossbikes left to rent at Setoda port today, until what time can we pick up, and can we drop off in Imabari?').",
  ),
  business: Schema.optionalKey(
    described(
      Schema.String,
      "Who you're calling, as you'd name them on the phone (e.g. 'Shimanami Rent-a-cycle, Setoda terminal').",
    ),
  ),
  context: Schema.optionalKey(
    described(
      Schema.String,
      "Facts the caller may share if asked: party size, dates, arrival time. Nothing secret.",
    ),
  ),
  language: Schema.optionalKey(
    described(Schema.Literals(["ja", "en"]), "Default: ja for +81 numbers, else en."),
  ),
  country: Schema.optionalKey(
    described(
      Schema.String,
      "For a domestic number with a leading 0 that isn't Japanese: UK, KR, AU.",
    ),
  ),
  may_book: Schema.optionalKey(
    described(
      Schema.Boolean,
      "Allow it to make the reservation or change the goal describes. Only with the user's approval, and only with max_spend.",
    ),
  ),
  max_spend: Schema.optionalKey(
    described(
      Schema.Finite,
      "With may_book: the most the user approved paying on this call, all in (every fee, fare difference, tax and deposit), like 10 for $10; 0 if nothing may be charged. The caller won't agree to a total above it, even by a little.",
    ),
  ),
  currency: Schema.optionalKey(
    described(
      Schema.String,
      "max_spend's currency, like USD or JPY (default: the one where the number rings).",
    ),
  ),
  max_minutes: Schema.optionalKey(
    described(Schema.Int, "Hang up after this long (default 6, or 12 with may_book; at most 15)."),
  ),
  about: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "Entities the call record is about, like project:japan-trip.",
    ),
  ),
  thread: Schema.optionalKey(described(Schema.String, "The thread asking, kept on the record.")),
  dry_run: Schema.optionalKey(
    described(Schema.Boolean, "Build the brief and check the number without dialing."),
  ),
  allow_late: Schema.optionalKey(
    described(Schema.Boolean, "Call outside 08:00-21:00 local time anyway."),
  ),
  keywords: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "Words the recognizer should expect, beside the business's name.",
    ),
  ),
  ring_secs: Schema.optionalKey(
    described(Schema.Finite, "How long it rings before giving up, in seconds. Default 40."),
  ),
})

const ResultInput = Schema.Struct({
  conversation_id: Schema.String,
  call_sid: Schema.optionalKey(Schema.String),
  wait_secs: Schema.optionalKey(Schema.Int),
})

const call = tool(
  "call",
  {
    description:
      "Phone a business and find something out (stock, hours, availability, prices), then hand back the answer and full transcript; it waits for the call to end (allow ~10 min: give timeout_seconds 600; 15 for a booking). It speaks for the user: place information-only calls when he asked for the answer; may_book needs his approval and max_spend, the exact amount he approved, which the caller never goes over (it says it'll check with him and call back). The result's warning says when it agreed to more anyway, and unfinished when a booking call ended before they said it was done: check the booking itself then. Introduces itself as an AI assistant calling for the user. Won't call Japan/Korea/UK numbers 21:00-08:00 their time. Costs ~$0.16/min to Japanese landlines, ~$0.27/min to Japanese mobiles, ~$0.10/min in the US.",
    speaks: true,
    input: CallInput,
  },
  placeCall,
)

const result = tool(
  "result",
  {
    description:
      "A call's result by conversation_id (when a call's request timed out before it ended), waiting up to wait_secs for it to finish.",
    readOnly: true,
    input: ResultInput,
  },
  (input) =>
    follow(
      input.conversation_id,
      textOr(input.call_sid, "") || null,
      Date.now() / 1000 + numberOr(input.wait_secs, 5),
    ),
)

const status = tool(
  "status",
  {
    description:
      "Whether the line can place a call right now, checked live: Twilio credit and the number, the ElevenLabs agent and number, callbacks answered, ElevenLabs credit left. ok, and problems when not.",
    readOnly: true,
  },
  () => health,
)

export const phoneApp = defineApp<HostService | AppEventsService>({
  name: "phone-call",
  version: "7",
  instructions:
    "Switch's phone: places calls to businesses (Japanese or English) from the user's Twilio number through an ElevenLabs voice agent, holds the conversation toward a goal, and returns the answer, transcript and recording. A call that may book is held to the most the user approved paying (max_spend), and its result warns if it agreed to more anyway. Every call, out or back in, is recorded: its audio (both sides, mp3) is kept as a blob in the call's record (facts.recording) and in its folder, beside the transcript. Takes messages when they call back. Checks every 6 hours that it can still place calls (Twilio credit and number, the ElevenLabs agent and credit) and records it as phone-line:switch.",
  connections: [
    { provider: "twilio", kind: "key", label: "Twilio", scopes: [], multiple: false },
    { provider: "elevenlabs", kind: "key", label: "ElevenLabs", scopes: [], multiple: false },
  ],
  tools: [call, result, status],
  events: [Call, Line, Heartbeat],
})
