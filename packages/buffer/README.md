# @plenum/buffer

Store-and-forward for the northbound path: a SQLite outbox that keeps values while the MQTT broker is unreachable and delivers them, in order, once it is back. The outbox is a file, so it survives a gateway restart.

- **Publisher** (`BufferedPublisher.ts`): `BufferedPublisher(config.buffer)` wraps the `Publisher` it is given and provides a `Publisher` itself. The gateway turns it on when the config has a `buffer` section.
  - A value goes straight to the broker while nothing is waiting. If the broker is unavailable, or older values are still in the outbox, it is stored instead, so delivery keeps the order values were read in.
  - A drainer delivers the oldest rows in batches of 100, up to 16 at a time, and removes each row once the broker has acknowledged it. While the broker is unreachable it retries every 5 s.
  - Only values are buffered. Retained messages (`$meta`, health) pass straight through: the pipeline retries `$meta` and the MQTT publisher replays retained state after a reconnect.
  - A message the broker refuses (too large, not authorized) is never stored, because retrying cannot help. If one is already in the outbox, it is dropped and counted so it never blocks the queue.
  - Past `maxRows` (default 1,000,000) the oldest rows are dropped and counted. Rows already being delivered are left alone, since they arrive anyway.
  - A row that no longer decodes (say, written by a different version) is dropped and counted, so it cannot stop forwarding either.
- **Outbox** (`Outbox.ts`): the table, its migrations (`SqliteMigrator`) and the queries. Rows are decoded with Schema on the way out, and deletes return the ids they removed, so the row count stays exact.

It uses `@effect/sql-sqlite-node`, which runs on Node's built-in `node:sqlite`, so there is no native addon to build on a Pi.

With a buffer, the gateway sets the MQTT client's `waitForConnection: false`: a publish during an outage fails at once and is stored, instead of waiting for the broker and holding up the next read.

Metrics: `plenum_buffer_rows` (rows waiting), `plenum_buffer_written_total`, `plenum_buffer_drained_total` and `plenum_buffer_dropped_total{reason}` (`overflow`, `rejected`, `unreadable`).

Part of [Plenum](../../README.md).
