import { Schema } from "effect"

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
