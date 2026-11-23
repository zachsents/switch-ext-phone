// Loose JSON from ElevenLabs, Twilio and the files in its home, read the way the Python read it:
// a missing field is null, and Python's truthiness decides `a or b`.
import { isJson } from "switch-ext-kit"
import type { Json } from "switch-ext-kit"

export type { Json } from "switch-ext-kit"

export const parseJson: (text: string) => unknown = JSON.parse

export const obj = (v: unknown): Json => (isJson(v) ? v : {})

export const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** Python's truthiness: an empty list or object is false too. */
export const truthy = (v: unknown): boolean => {
  if (Array.isArray(v)) {
    return v.length > 0
  }
  if (isJson(v)) {
    return Object.keys(v).length > 0
  }
  return Boolean(v)
}

/** Python's `a or b or …`: the first truthy value, else the last. */
export const or = (...values: readonly unknown[]): unknown => values.find(truthy) ?? values.at(-1)

/** A field as Python's `.get()` gave it: null when it's missing. */
export const get = (o: Json, key: string): unknown => o[key] ?? null

/** Python's `s or fallback`, for a string that may be missing or empty. */
export const textOr = (s: string | undefined, fallback: string): string =>
  s === undefined || s === "" ? fallback : s

/** Python's `n or fallback`, for a number that may be missing or 0. */
export const numberOr = (n: number | undefined, fallback: number): number =>
  n === undefined || n === 0 ? fallback : n

/** A value in words: a string as it is, anything else as JSON. */
export const str = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? "undefined")

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `Type: message`, as the Python said an exception it kept. */
export const named = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e)
