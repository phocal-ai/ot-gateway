# Plenum — Vision

As of 2026-11-02. The living version of this document, with diagrams, is kept alongside the project; this file is the copy that ships with the code.

## Elevator pitch

Plenum is an open-source, type-safe edge gateway for buildings. It runs on small Linux devices like a Raspberry Pi, reads building protocols such as Modbus TCP and BACnet/IP, and publishes clean, normalized data to MQTT. It also carries commands back safely.

It is built on Effect for TypeScript, and it is Effect-native throughout. Polling, retries, timeouts, resource cleanup and failures are explicit, typed and testable. Plenum is both a library you compose in code and a ready-to-run gateway you configure with one file.

## Problem

Getting data out of a building is still harder than it should be. Field devices speak Modbus and BACnet, while modern platforms expect MQTT and structured data. The glue in between is usually fragile.

- **Flow tools hide failure.** Node-RED-style gateways are fast to start but hard to test, version and reason about. When a device goes quiet, it is often unclear why.
- **Vendor gateways are closed.** They are expensive, hard to extend, and lock the point mapping inside a proprietary UI.
- **Hand-written scripts don't survive.** One-off scripts work until the first network drop, socket leak or SD card failure.
- **Field reality is messy.** Timeouts, CRC errors, rebooting devices, brokers going offline and inconsistent register maps are normal. Most tools treat them as exceptions.
- **BACnet tooling in the JavaScript ecosystem is thin.** Mature, maintained BACnet/IP support for modern runtimes is hard to find.

## Vision statement

**Plenum makes building data boring, in the best sense: predictable, observable and correct, from the field bus to the broker.**

An integrator should be able to drop a Pi into a plant room, point it at a config file, and trust it to run unattended for months. When something goes wrong, the gateway should say exactly what, where and since when. A developer should be able to add a protocol driver without understanding the whole codebase, and test it against a simulated device on a laptop.

## Users and use cases

| User                             | What they need from Plenum                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Building automation integrator   | Meter, HVAC and plant data in MQTT quickly, configured from a file, with clear diagnostics on site |
| Developer                        | A typed library to build a custom gateway or add a protocol driver                                 |
| Facility or energy platform team | Reliable, normalized telemetry for dashboards, energy reporting or a data lake                     |

Typical use cases:

1. Poll energy meters over Modbus TCP and publish readings every few seconds.
2. Discover BACnet/IP devices, subscribe to change-of-value on key points and stream them to a broker.
3. Accept setpoint changes from MQTT and write them to the field device, inside strict limits.
4. Buffer data during a broker or uplink outage and replay it when the connection returns.

## Design principles

1. **Failure is a first-class value.** Every expected field failure is a typed error, handled on purpose, never swallowed.
2. **Unattended by default.** Retries with backoff, reconnects, supervised fibers, store-and-forward. A reboot is never the fix.
3. **Config is checked.** The point map is validated with Effect Schema at startup. A bad register address fails loudly at boot, not silently at runtime.
4. **Drivers are swappable.** Each protocol sits behind a common interface. Real devices and simulators are interchangeable.
5. **Observable out of the box.** Health, per-point freshness, error counts and traces are built in, including over MQTT.
6. **Safe writes.** Writing is opt-in, allowlisted, range-checked and logged. Reading is the default.
7. **Effect-native, small footprint.** Built on the Effect 4 ecosystem and nothing else where possible; protocol stacks are our own. Runs comfortably on a Raspberry Pi 4/5 and is gentle on SD cards.
8. **Library first, product second.** The core is a composable library; the gateway is a thin, opinionated assembly of it.

## Scope

**Goals**

- Modbus TCP first, then BACnet/IP, both implemented in-house on Effect
- MQTT 5 northbound with an in-house client and `site/building/device/point` topics
- Polling, change-of-value, deadband and scaling per point
- Command write-back from MQTT with safety controls
- Store-and-forward in SQLite during outages
- JSON config validated with Effect Schema, loadable from a file or a database
- Built-in health, metrics and tracing
- A simulator for each driver
- A local status page in v1.0
- Deployment as a single Node process, as a container image or a systemd service

**Non-goals (for now)**

- Serial protocols such as Modbus RTU or BACnet MS/TP (possible later through USB adapters)
- A visual flow editor
- A full configuration web app before v1.0 (it follows later, as a separate Next.js package)
- Dashboards, historians or long-term storage
- Being a BACnet controller or a building management system
- Running on microcontrollers

## Conceptual architecture

Field protocols plug in as drivers. One typed core handles scheduling, normalization and write safety, and MQTT is the only way out.

- **Drivers:** Modbus driver, BACnet driver, simulators
- **Core:** point map (Schema-checked config), scheduler (polling, COV, retry schedules), normalizer (scale, deadband, units), command guard (allowlist, range limits)
- **Northbound:** store and forward (local SQLite buffer), MQTT 5 client (publish, last will, commands)
- **Observability** across all layers: health topics, point freshness, error counts, traces

Telemetry flows down from devices to the broker. Commands travel back up and must pass the command guard before they reach a device.

## Positioning

Plenum aims at the gap between visual flow tools and closed vendor gateways: code-first, typed and testable, yet usable from a config file.

| Tool                    | Strength                               | Where Plenum differs                                                 |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Node-RED                | Fast visual prototyping, big ecosystem | Typed, version-controlled config and code; testable without hardware |
| EMQX Neuron             | Many industrial protocols              | Open, small, library-first; focused on building automation           |
| ThingsBoard IoT Gateway | Broad connector set                    | Not tied to one platform; generic MQTT output                        |
| Telegraf                | Excellent metrics collection           | Two-way, with safe command write-back and point semantics            |
| Vendor gateways         | Supported, certified                   | Open source, extensible, no lock-in                                  |

## Roadmap

Modbus TCP to MQTT ships end to end first, because it is the simplest protocol and proves the core. BACnet follows once the core is reliable. Write-back comes last on purpose, after read paths have run unattended in the field.

| Version          | Focus                                         |
| ---------------- | --------------------------------------------- |
| v0.1 Foundation  | Core + Schema, Modbus TCP, MQTT publish       |
| v0.2 Reliability | Buffering, health topics, simulators + CI     |
| v0.3 BACnet/IP   | Discovery, ReadProperty, COV subscribe        |
| v0.4 Write-back  | MQTT commands, range limits, BACnet priority  |
| v1.0 Production  | Status page, packaging + docs, first building |

## Success criteria

- A Pi running Plenum stays up for 30 days with no manual intervention, through broker and network outages.
- No data loss during an outage that fits in the local buffer.
- A new user gets Modbus readings into MQTT in under 15 minutes from the README.
- Every driver has a simulator, and CI runs end-to-end tests without hardware.
- A new protocol driver can be added without changing the core.
- At least one real building deployment outside the maintainers' own projects.

## Decisions

| Topic            | Decision                                                                   | Notes                                                              |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Runtime          | Node.js (LTS)                                                              | Bun is not a target                                                |
| Effect version   | Latest Effect 4.x                                                          | Stable since late Sep 2026, bug fixes until at least Sep 2029      |
| Dependencies     | Effect-native: `effect` plus `@effect/*` packages                          | Use what Effect offers first; protocol stacks are written in-house |
| MQTT             | MQTT 5                                                                     | In-house client on Effect sockets                                  |
| Topic convention | `site/building/device/point`                                               | Metadata on retained `.../point/$meta`                             |
| Config format    | JSON, validated with Effect Schema                                         | Storable in a file or a database                                   |
| Buffer storage   | SQLite via `@effect/sql-sqlite-node`                                       | Uses Node's built-in `node:sqlite`, so no native build on ARM      |
| Monorepo         | pnpm workspaces + Turborepo                                                |                                                                    |
| Web UI           | Local status page in v1.0; Next.js configuration app after v1.0            | Separate package                                                   |
| License          | MIT                                                                        |                                                                    |
| Semantic model   | Ontology-neutral core, optional Brick class and Haystack tags per point    | See below                                                          |
| Commands         | Live only on `.../point/$set`, one result each, never retained or replayed | Limits required on writable numeric points; BACnet priority 8      |

## Semantic model

The core stays ontology-neutral, and each point can carry an optional Brick class and Haystack tags. The field is converging on RDF graphs with validation, but the formal standard (ASHRAE 223P) is not published yet.

| Model              | What it is                                                                               | Status (Nov 2026)                                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ASHRAE 223P        | RDF/SHACL standard for detailed system topology, connections and points                  | Second public review Apr to Jun 2026; publication expected by end of 2026 |
| Brick 1.4          | RDF/OWL class hierarchy for equipment, points and spaces, harmonized with RealEstateCore | Stable                                                                    |
| Project Haystack 5 | Tag-based model; v5 adds Xeto typed specs, validation and RDF export                     | Haystack 4 widely deployed; v5 specs still being built out                |

The three are moving toward each other: Haystack 5 exports to RDF and its Xeto tool translates Haystack to Brick, and Brick aligns with 223P. The likely end state is 223P for detailed engineering models, Brick as the lighter query layer, and Haystack tags as the vocabulary people use in the field.

What Plenum does:

1. The core point model stays neutral: id, name, unit, data type, writable, plus device context.
2. Each point can carry an optional `semantics` block with a Brick class (primary) and Haystack tags.
3. Units use QUDT identifiers, which Brick also uses.
4. Metadata is published on the retained `$meta` topic.
5. Later, an exporter generates Brick or 223P Turtle from the config as plain text, with no RDF library in the core.
