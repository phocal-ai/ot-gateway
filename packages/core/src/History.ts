/**
 * Where the pipeline hands every read for the on-device history (`@ot-gateway/history`). Every read, whatever the
 * point's publish mode: the history is what the device said, not what went to the broker. `record` is synchronous
 * and must not block: a store batches and writes on its own schedule.
 */
import type { PointValue } from "./Driver.ts"

export interface HistorySink {
  /** One scaled, finite read of `point` on `device`, at `ts` (Unix ms, wall clock). */
  readonly record: (device: string, point: string, value: PointValue, ts: number) => void
}
