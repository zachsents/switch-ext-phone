// Its events, as the shim made the Python's: a call it placed or took, how the line stands, and how
// it is itself.
import { defineRecord } from "switch-ext-kit"

/** A call it placed or took, once it's over: who, what was said, the answer, the recording. */
export const Call = defineRecord("phone-call.call", { kind: "observation", stream: "comms/phone" })

/** How the line stands: Twilio and ElevenLabs credit, the number, callbacks. */
export const Line = defineRecord("phone-call.line", { kind: "observation", stream: "comms/phone" })

/** How it is itself. */
export const Heartbeat = defineRecord("phone-call.heartbeat", {
  kind: "observation",
  stream: "vitals/phone-call",
})
