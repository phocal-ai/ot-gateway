# The MQTT contract

> **Status: draft (design note).** This page proposes contract version 1.0 for review. It is not in the docs site's navigation yet; once it is accepted it becomes the reference page, and the design sections move to the pull request that adds it.

What a consumer sees on the broker is the product (VISION.md, principle 3). This page says what that is: every topic the gateway publishes or listens on, the shape of every payload, and the rules for changing them. Each payload has a JSON Schema, so a consumer or an agent knows what arrives without reading the code.

## Topics

Every variable level is a slug from the config (lowercase letters, digits, `-` and `_`, at most 64 characters), so it is always a valid topic level.

| Topic                                            | Message          | Direction          | Retained | QoS |
| ------------------------------------------------ | ---------------- | ------------------ | -------- | --- |
| `{site}/{building}/{device}/{point}`             | `value`          | gateway publishes  | no       | 1   |
| `{site}/{building}/{device}/{point}/$meta`       | `meta`           | gateway publishes  | yes      | 1   |
| `{site}/{building}/$gateway/{gateway}/health`    | `health`         | gateway publishes  | yes      | 1   |
| `{site}/{building}/{device}/{point}/$set`        | `command`        | gateway subscribes | never    | 1   |
| `{site}/{building}/{device}/{point}/$set/result` | `command-result` | gateway publishes  | no       | 1   |

QoS 1 is capped to what the broker allows. `{site}/{building}/$gateway/{gateway}/check/…` is the CLI's broker round trip (`ot-gateway broker`) and is not part of the contract; neither is any other topic under `$gateway`.

## Messages

The schemas are in [`docs/mqtt-contract/v1/`](mqtt-contract/v1/), one file per message. In short:

- **`value`**: `{"value": 21.5, "unit": "unit:DEG_C", "ts": 1764075600000}`. `value` is a finite number in engineering units, or `true`/`false`; a multi-state point sends its state as a whole number from 1. `ts` is when the device was read, so a value buffered through an outage arrives late with its own time. A point in publish mode `aggregate` sends one message per clock-aligned window instead: `value` (the time-weighted average), `min`, `max`, `avg`, `last`, `count`, `from`, `to`, `ts` (= `to`) and `partial: true` when the gateway started inside the window.
- **`meta`**: `name`, `unit`, `writable`, `publish` (the point's mode and its settings), and when they apply `cov: true`, `semantics` (Brick class, Haystack tags), `alarmWhen` and `gateway` (the id of the gateway that owns it). An empty retained message clears it when the point leaves the config.
- **`health`**: `{"status": "online", "contract": "1.0", "since", "ts", "devices": {id: {status, lastSuccess, reason, failingSince}}, "host": {…}}`, refreshed every `health.intervalMs` and about a second after a device's status changes; `{"status": "offline", "reason": "shutdown" | "connection-lost"}` on a clean stop or as the MQTT last will. Error text stays on the gateway (`/api/status`): it names addresses on the building's network.
- **`command`**: exactly `{"value": …}` (a number, `true`/`false`, or `null` to release a BACnet priority slot), sent live, never retained. Anything else is rejected.
- **`command-result`**: `{"status": "written", "value", "ts"}`, `{"status": "rejected", "reason", "message", "ts"}` (the gateway refused it; no device saw it) or `{"status": "failed", "reason", "message", "ts"}` (the write did not succeed; `timeout` means it may still have been applied). It carries the command's MQTT 5 correlation data and is never buffered.

All times are Unix milliseconds, whole numbers, from the gateway's wall clock.

On an MQTT 3.1.1 broker (`mqtt.version`), commands lose the two MQTT 5 features: correlation data and message expiry. A result can then be matched to its command only by its topic and its time, and a command waits at most the gateway's own 10 seconds.

## Design

### One source: Effect Schemas in core

The contract is `packages/core/src/Contract.ts`: an Effect Schema per message, the topic table, `contractMessageOf(topic)` and `decodeContractMessage`. The JSON Schemas are generated from it (`Schema.toJsonSchemaDocument`, draft 2020-12) and checked in under `docs/mqtt-contract/v<major>/` by `pnpm --filter @ot-gateway/core contract:write`, so they can be linked and read without running anything. The project site serves the same files (`apps/site/scripts/content.ts` copies them), and each schema's `$id` is its address there, e.g. `https://ot-gateway.vercel.app/mqtt-contract/v1/value.schema.json`.

The status page names topics with the same table: `topicKind` in `@ot-gateway/api` is `contractMessageOf` from `@ot-gateway/core/Contract`, so the page and the contract cannot disagree on what a topic carries.

The payload builders (`ValueMessage` and `metaPayload` in `Pipeline.ts`, `closeWindow` in `Publish.ts`, `onlinePayload` in `Health.ts`, the result in `Command.ts`) stay as they are. The contract does not replace them; it checks them.

### Open for consumers, strict for the gateway

One schema, read two ways:

- **The published JSON Schemas are open** (`additionalProperties: true`) for everything the gateway sends. A field added in 1.1 must not break a consumer that validates against 1.0.
- **The gateway's own tests are strict** (`onExcessProperty: "error"`). A field the gateway starts sending without adding it to the contract fails CI instead of reaching consumers unannounced.
- **The command schema is closed** in both: it is input, and the command guard already refuses anything but `{"value": …}`.

### Checked in CI against what the gateway really publishes

Two checks, both in `pnpm test`, so in CI and in Turborepo's cache:

1. `packages/core/test/Contract.test.ts`: the TypeScript types the builders use fit the schemas (`expectTypeOf`), the builders' output decodes strictly (metadata and values from a real `runDevice`, aggregate windows, health online and offline), invalid payloads are refused, and the checked-in JSON Schemas equal the generated ones. `packages/core/turbo.json` lists `docs/mqtt-contract/**` as an input, so editing a file by hand cannot replay a stale pass.
2. The simulation's invariant 9 (`apps/gateway/test/sim/Invariants.ts`): every message the broker received during a whole simulated run, through broker, device, network, disk and clock faults, with valid and invalid commands, decodes strictly by its topic. Commands are skipped, since the simulation sends invalid ones on purpose.

The second check found one thing on its first run: the simulation's clock gave fractional milliseconds (jittered sleeps move the test clock between two), so `ts` was not always a whole number. The gateway reads time through `Clock.currentTimeMillis`, which is `Date.now()` in production and always whole, so the fix is in the simulation's clock, which now floors as `Date.now()` does. The contract keeps the promise that times are integers.

### Printed by the CLI

```bash
ot-gateway contract                  # the topic table and each message in short, for people
ot-gateway contract health           # one message's fields: type, optional or not, what each is
ot-gateway contract --json           # {ok, version, url, topics, schemas}: everything, for agents
ot-gateway contract value --json     # one message's JSON Schema, the same document as v1/value.schema.json
ot-gateway watch --check             # check what arrives against the contract, live, one line per message off it
```

`contract` needs no config and no broker, and reads everything it prints from the schemas in core. `watch --check` is the same strict decode the tests use, pointed at a real broker, for every topic under the config's site and building (other applications' topics are left alone, and so is an empty message that clears a retained topic): the quickest way to tell whether a site's consumer or a second publisher is the one sending something odd. A message with several forms (a sample or an aggregate value, health online or offline) is reported against the form it comes closest to. With `--seconds` it exits with 1 (`off-contract`) when one was off; a gateway newer than the CLI can trip it with a field a later minor version added, which the health message's `contract` shows.

## Versioning

The contract has its own version, `major.minor` (`contractVersion`, now `1.0`), separate from the gateway's release: most releases change no topic or payload.

- **Minor** (1.0 → 1.1): only additions a consumer can ignore. A new optional field, a new value of a `reason`, a new topic under `$gateway` or a new `$`-suffix.
- **Major** (1.x → 2.0): anything else. Removing or renaming a field or topic level, changing a type, unit or meaning, making a field required, or a new required topic level.
- A consumer treats an unknown `reason` as "failing" or "rejected for another reason", and ignores fields it does not know. So the published schemas take any string as a `reason` and list the known ones as `examples`, while the gateway's own strict tests keep the closed list. Statuses (`online`, `ok`, `written`, …) stay closed: a new one is a major version.
- The JSON Schemas for each major live in their own folder (`v1/`, later `v2/`), each carrying `x-ot-gateway-contract` with the exact version.
- A gateway says which version it speaks in its online health message (`"contract": "1.0"`): one retained field per gateway, readable on MQTT 3.1.1 too. A consumer checks the major and ignores the minor. An MQTT 5 user property on every message was the alternative; it costs bytes on every value and does not exist on 3.1.1.
- A major version is announced one minor release ahead, in the release notes and in this page. Whether a gateway can publish both majors for a transition is left until there is a 2.0.

## Decisions

Settled in review of this draft:

1. **The version is on the wire** in the online health message, `"contract": "1.0"` (see "Versioning").
2. **Each schema has a stable `$id`**: its URL on the project site, under `/mqtt-contract/v<major>/`.
3. **Slugs keep their pattern** in the generated JSON Schemas. Effect exports a pattern only when the regular expression has the `u` flag, so `Slug`'s has it now; the health message's device map is keyed by plain strings, since a refined key would leave the device schema out.
4. **`host.throttled` stays free strings.** A new Raspberry Pi condition changes no contract version.
5. **An aggregate point in the simulation** is a follow-up of its own: it changes the simulation's numbers. Aggregates are covered by the unit tests until then.
6. **One topic classifier**: the status page uses the contract's.
7. **MQTT 3.1.1** limits are stated under "Messages".
