# @plenum/buffer

Store-and-forward for the northbound path: a SQLite outbox that keeps values while the MQTT broker is unreachable and delivers them, in order, once it is back. The outbox is a file, so it survives a gateway restart.

- **Publisher** (`BufferedPublisher.ts`): `BufferedPublisher(config.buffer)` wraps the `Publisher` it is given and provides a `Publisher` itself. The gateway turns it on when the config has a `buffer` section.
  - A value goes straight to the broker while nothing is waiting. If the broker is unavailable, or older values are still in the outbox, it is stored instead, so delivery keeps the order values were read in.
  - A drainer delivers the oldest rows in batches of 100, up to 16 at a time, and removes delivered rows in steps of 16 as acknowledgements arrive, so a shutdown mid-drain resends at most a few. It starts no new deliveries after the first failure. While the broker is unreachable it retries every 5 s.
  - A row that is in flight when the connection breaks (or whose PUBACK never comes) gets a strike; it is sent alone next time. After 3 strikes in a row it is dropped as `undeliverable` with an error log, so one poison message (say, larger than the broker accepts) cannot hold up the queue by breaking the connection forever. A message whose PUBACK times out on three reconnects in a row is treated the same way.
  - Only values are buffered. Retained messages (`$meta`, health) pass straight through: the pipeline retries `$meta` and the MQTT publisher replays retained state after a reconnect.
  - A message the broker refuses (too large, not authorized) is never stored, because retrying cannot help. If one is already in the outbox, it is dropped and counted so it never blocks the queue.
  - Past `maxRows` (default 1,000,000) the oldest rows are dropped and counted. Rows already being delivered are left alone, since they arrive anyway.
  - A row that no longer decodes (say, written by a different version) is dropped and counted, so it cannot stop forwarding either.
- **Outbox** (`Outbox.ts`): the table, its migrations (`SqliteMigrator`) and the queries. Rows are decoded with Schema on the way out, and deletes return the ids they removed, so the row count stays exact.

It uses `@effect/sql-sqlite-node`, which runs on Node's built-in `node:sqlite`, so there is no native addon to build on a Pi.

With a buffer, the gateway sets the MQTT client's `waitForConnection: false`: a publish during an outage fails at once and is stored, instead of waiting for the broker and holding up the next read.

## When the disk or the file misbehaves

- **Disk full or the file is busy.** Every failed SQLite operation is counted in `plenum_buffer_failures_total{operation}` and logged when the failures start and when they end, not on every value.
  - If an insert fails while the broker is up, the value is published directly, ahead of the stored ones, and counted in `plenum_buffer_bypassed_total`. If the broker is down too, the publish fails as `unavailable` and the value is lost.
  - If a delete fails after delivery, the delivered ids are kept in memory and skipped, so they are not sent again, and the delete is retried every 30 s. These ids are not persisted: after a restart during the outage, those rows are sent once more.
  - After a failed insert the buffer waits 1 s before trying the next one, so a full disk does not cost a write attempt per value.
- **Corrupt file.** A file SQLite reports as corrupt, or whose schema the migrations cannot handle, is renamed to `<path>.corrupt-<timestamp>` (with its `-wal` and `-shm` files) and a fresh one is opened. If corruption shows up while draining, the remaining rows are counted as dropped (`lost`) and the file is replaced the same way.
- **Cannot open at all** (a read-only directory, say). The gateway runs without a buffer, logs an error and sets `plenum_buffer_disabled` to 1; it tries again every 30 s.
- **File deleted or replaced while running.** Every 30 s the buffer compares the file's inode with the one it opened. A deleted file is restored from the open connection with SQLite's backup, rows included. A replaced file is opened instead, and the rows of the old one are counted as `lost`.
- **Two gateways on one file.** The file is opened with `locking_mode = EXCLUSIVE` and the lock is taken at startup, so the second gateway fails to start with `BufferLocked` instead of both draining the same rows.

## SQLite settings

- `busy_timeout` is 200 ms. `node:sqlite` is synchronous, so a busy wait blocks the event loop, and with an exclusive lock waiting longer does not help. Busy counts as a store failure.
- WAL with `synchronous = NORMAL`: a commit does not wait for an fsync, only checkpoints do. A gateway crash loses nothing, but a power cut can lose the values committed since the last checkpoint (at most about 1,000 pages of WAL). That is the trade for not stalling an SD card with an fsync per buffered value. Values are still stored one transaction each; batching a polling cycle into one transaction is not done, because the `Publisher` interface is one message at a time.
- New files use `auto_vacuum = INCREMENTAL`, and the buffer runs `PRAGMA incremental_vacuum` after a drain empties the outbox, so the file shrinks again after a long outage. Files created by an earlier version keep their mode, because converting needs a full `VACUUM` (a copy of the whole file on a disk that may be nearly full); there the vacuum is a no-op. Delete such a file while it is empty to get the new mode.

## Metrics

`plenum_buffer_rows` (rows waiting), `plenum_buffer_written_total`, `plenum_buffer_drained_total`, `plenum_buffer_dropped_total{reason}` (`overflow`, `rejected`, `unreadable`, `undeliverable`, `lost`), `plenum_buffer_failures_total{operation}` (`insert`, `delete`, `read`, `open`), `plenum_buffer_bypassed_total` and `plenum_buffer_disabled`.

Part of [Plenum](../../README.md).
