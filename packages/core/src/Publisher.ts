/**
 * The northbound side. The MQTT package provides the real implementation;
 * the console publisher is for development and tests.
 */
import { Console, Context, Effect, Layer } from "effect"
import type { PublishError } from "./Errors.ts"

export interface PublishOptions {
  readonly retain?: boolean
  readonly qos?: 0 | 1 | 2
  /** Echo of a request's correlation data, when answering one (MQTT 5 request/response). */
  readonly correlationData?: Uint8Array
  /**
   * Only worth delivering now (a command result): not stored for later if the
   * broker is unavailable, since by then it would mislead.
   */
  readonly transient?: boolean
}

export class Publisher extends Context.Service<
  Publisher,
  {
    readonly publish: (topic: string, payload: string, options?: PublishOptions) => Effect.Effect<void, PublishError>
  }
>()("@ot-gateway/core/Publisher") {}

/** Prints every message to stdout. */
export const ConsolePublisher: Layer.Layer<Publisher> = Layer.succeed(Publisher, {
  publish: (topic, payload, options) =>
    Console.log(`${options?.retain === true ? "[retained] " : ""}${topic} ${payload}`)
})

/** Collects messages in memory, for tests. */
export const makeMemoryPublisher = Effect.sync(() => {
  const messages: Array<{ topic: string; payload: string; retain: boolean }> = []
  const layer = Layer.succeed(Publisher, {
    publish: (topic, payload, options) =>
      Effect.sync(() => {
        messages.push({ topic, payload, retain: options?.retain === true })
      })
  })
  return { messages, layer } as const
})
