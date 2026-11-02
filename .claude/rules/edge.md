---
description: What the Raspberry Pi in a plant room does to code that looks fine on a laptop
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

The gateway runs unattended for months on a Raspberry Pi, next to devices that behave nothing like their spec and an uplink that comes and goes. Each item below is a bug that chaos testing found in code that passed review. Check new and changed code against them, and so does `/review-effect`.

## Time

- **No real-time clock.** The wall clock starts wrong and NTP steps it, backwards too. Timers, timeouts, ordering, backoff and "heard from within N" use `monotonicMillis` from `@plenum/core` (or `Clock.monotonicTimeNanos`). Wall time is only for the `ts` of a message.
- **Every wait has a deadline.** Waiting for a slot, a permit, a reply or a whole poll cycle is covered by the timeout, not just the I/O inside it. A hung peer must turn into a typed error and a stale health status.

## Peers that misbehave

- **Devices close, reorder and pad.** A device may close the connection after every answer, append stray bytes, answer late, answer a different request or answer from another address. Match replies to requests, drop what does not match, and reconnect once on a connection the peer closed.
- **"No" is not "try again".** A refusal (exception, reject, abort, a PUBACK reason) is either permanent or transient. Retry only transient ones, and never multiply retries across layers: driver, pipeline and per-point fallback together must not turn one refusal into thousands of requests.
- **Values can be NaN or Infinity.** A non-finite reading is a read failure, never a published value or a deadband reference.
- **Inputs can be huge.** Bound every length read off the wire before allocating, and accumulate bytes linearly.
- **Spoofing is cheap on a building LAN.** Accept answers and notifications only from the address a request went to, and only forwarded traffic from a configured BBMD.

## Isolation

- **One device cannot take down the others.** A defect in a device's pipeline is caught, logged with the device id, counted, and that device restarts with backoff.
- **One bad message cannot block the queue.** A row the broker keeps refusing is dropped after a few attempts, counted and logged.
- **Slow work cannot starve periodic work.** Renewals, keepalives and health run with bounded concurrency, ordered by due time, so a few silent peers cannot delay them past their deadline.

## Storage

- **SD cards fill up, lock and corrupt.** Every SQLite call can fail with disk full, busy or corrupt. Disk full must not lose values while the broker is up, busy must not block the event loop (short busy timeout), and a corrupt file must not crash-loop the gateway (move it aside, or run unbuffered and say so loudly).
- **Shutdown can land anywhere.** Interruption between "sent" and "marked sent" must not resend a batch or lose a row.

## Budget

- **Log transitions, not states.** A warning per point per cycle is millions of lines a day in Loki. Log when something starts failing and when it recovers, at the coarsest level that is true (device before point), and count the rest in a metric.
- **Config typos fail loudly.** Unknown keys, duplicate ids and out-of-range values are decode errors, not silent defaults.

To try a change against these faults, run `scripts/soak.sh` (broker and device outages, a full disk with `SOAK_DISK_FAULT=1`) and the `test/chaos` suites.
