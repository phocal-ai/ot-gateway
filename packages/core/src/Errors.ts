import { Schema } from "effect"
import type { SocketError } from "effect/socket/Socket"

/** An expected failure while talking to a field device. */
export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  device: Schema.String,
  reason: Schema.Literals(["timeout", "connection", "protocol", "invalid-response", "not-implemented"]),
  message: Schema.String
}) {}

/** A failure while publishing northbound. */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  topic: Schema.String,
  message: Schema.String
}) {}

const withCause = (what: string, cause: unknown) => (cause instanceof Error ? `${what}: ${cause.message}` : what)

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
