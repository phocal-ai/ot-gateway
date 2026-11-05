import { Schema } from "effect"
import type { DatagramSocketError } from "effect/socket/DatagramSocket"
import type { SocketError } from "effect/socket/Socket"

/** An expected failure while talking to a field device. */
export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  device: Schema.String,
  reason: Schema.Literals([
    "timeout",
    "connection",
    "protocol",
    "invalid-response",
    "configuration",
    "not-implemented"
  ]),
  message: Schema.String
}) {}

/**
 * A failure while publishing northbound. `unavailable`: the broker cannot be
 * reached right now, so the message may be retried (or buffered).
 * `rejected`: this message is refused (too large, not authorized, invalid
 * topic), so retrying it will not help.
 *
 * `inFlight` marks an `unavailable` failure after the message went out: the
 * connection broke while it waited for its acknowledgement. The broker may
 * have it, or the message itself may be what broke the connection, so a
 * store-and-forward buffer counts these per message. A missing acknowledgement
 * on a connection that stays up is a slow broker and is not `inFlight`.
 */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  topic: Schema.String,
  reason: Schema.Literals(["unavailable", "rejected"]),
  message: Schema.String,
  inFlight: Schema.optionalKey(Schema.Boolean)
}) {}

/**
 * A step of a device's pipeline that did not finish within the device's
 * cycle deadline: a polling cycle (`poll-cycle`: reading the device and
 * publishing its values), or handling one value the device pushed
 * (`pushed-value`). Something below it hangs, a device or the broker side.
 */
export class PipelineTimeout extends Schema.TaggedError<PipelineTimeout>()("PipelineTimeout", {
  device: Schema.String,
  stage: Schema.Literals(["poll-cycle", "pushed-value", "publish-window"]),
  timeoutMs: Schema.Number,
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

/** A log-friendly description of a UDP socket failure, for the BACnet/IP client. */
export const describeDatagramSocketError = (error: DatagramSocketError): string => {
  const reason = error.reason
  switch (reason._tag) {
    case "DatagramSocketOpenError":
      return reason.kind === "AddressInUse"
        ? withCause("could not open the UDP socket, the port is in use", reason.cause)
        : withCause("could not open the UDP socket", reason.cause)
    case "DatagramSocketReadError":
      return withCause("UDP read failed", reason.cause)
    case "DatagramSocketWriteError":
      return withCause("UDP write failed", reason.cause)
    case "DatagramSocketClosedError":
      return "UDP socket closed"
    case "DatagramSocketUnsupportedError":
      return reason.message
  }
}
