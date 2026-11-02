import { Schema } from "effect"
import type { SocketError } from "effect/socket/Socket"

/** An expected failure while talking to a field device. */
export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  device: Schema.String,
  reason: Schema.Literals(["timeout", "connection", "protocol", "invalid-response", "not-implemented"]),
  message: Schema.String
}) {}

/**
 * A failure while publishing northbound. `unavailable`: the broker cannot be
 * reached right now, so the message may be retried (or buffered).
 * `rejected`: this message is refused (too large, not authorized, invalid
 * topic), so retrying it will not help.
 */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  topic: Schema.String,
  reason: Schema.Literals(["unavailable", "rejected"]),
  message: Schema.String
}) {}

/**
 * The most specific text in a Node error. Dialing a name with several
 * addresses (`localhost` is `::1` and `127.0.0.1`) fails with an
 * `AggregateError` whose message is empty; its parts carry the detail.
 */
const causeText = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error)) return undefined
  if (cause.message !== "") return cause.message
  if (cause instanceof AggregateError) {
    const parts = cause.errors.map(causeText).filter((part) => part !== undefined)
    if (parts.length > 0) return [...new Set(parts)].join("; ")
  }
  return "code" in cause && typeof cause.code === "string" ? cause.code : undefined
}

const withCause = (what: string, cause: unknown) => {
  const text = causeText(cause)
  return text === undefined ? what : `${what}: ${text}`
}

/**
 * A log-friendly description of a socket failure, for the protocol clients.
 * `SocketError.message` alone is a bare close code ("1000") or a generic
 * "An error occurred during Open"; the useful part (ECONNREFUSED, a timeout)
 * is in `reason`.
 */
export const describeSocketError = (error: SocketError): string => {
  const reason = error.reason
  switch (reason._tag) {
    case "SocketCloseError":
      return reason.code === 1000 ? "connection closed by the peer" : `connection closed with code ${reason.message}`
    case "SocketOpenError":
      return reason.kind === "Timeout"
        ? "timed out opening the connection"
        : withCause("could not connect", reason.cause)
    case "SocketReadError":
      return withCause("read failed", reason.cause)
    case "SocketWriteError":
      return withCause("write failed", reason.cause)
    case "SocketUpgradeError":
      return reason.message
  }
}
