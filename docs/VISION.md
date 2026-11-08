# OT Gateway — Vision

As of 2026-11-08. The living version of this document, with diagrams, is kept alongside the project; this file is the copy that ships with the code.

## Elevator pitch

OT Gateway is an open-source edge gateway for operational technology: the controllers, meters and field buses of buildings and industrial sites. It reads their protocols, such as Modbus TCP and BACnet/IP, and forwards the data as standardized MQTT, without losing values when the connection drops. It runs as one container wherever Docker runs, for example on a Raspberry Pi or a small industrial PC, so a site does not need an industrial controller to deliver its data.

It is AI-native: an AI assistant sets it up with you, from finding the devices to the first values, and helps debug it, because every command speaks plain text and JSON and the gateway reports its own health. Debugging and telemetry are built in, from the local status page to OpenTelemetry, and the experience of setting it up and running it, for people and agents alike, is meant to be the best in its class.

It is built on Effect for TypeScript, and it is Effect-native throughout. Polling, retries, timeouts, resource cleanup and failures are explicit, typed and testable. OT Gateway is both a library you compose in code and a ready-to-run gateway you configure with one file.

## Problem

Getting data out of a building or a plant is still harder than it should be. Field devices speak Modbus and BACnet, while modern platforms expect MQTT and structured data. The glue in between is usually fragile, expensive, or both.

- **Flow tools hide failure.** Visual flow tools are fast to start but hard to test, version and reason about. When a device goes quiet, it is often unclear why.
- **Vendor gateways are closed.** They are expensive, hard to extend, and lock the point mapping inside a proprietary UI.
- **Industrial controllers are the safe default, and an expensive one.** Collecting a site's data with a programmable controller costs thousands per site in hardware, licences and programming, and needs a specialist for every change. That does not scale to many sites with a few hundred points each.
- **Lost data on bad links.** Sites hang off cellular routers and shared networks. A gateway that drops values while the uplink is down leaves holes in every report.
- **Nothing is AI-ready.** Engineering tools, closed configuration formats and silent failures leave an AI assistant nothing to read or run, so setup and fault-finding stay manual.
- **Security is a requirement, not an extra.** Operators segment their OT networks (NIS2 in the EU asks for it): a gateway must fit its own VLAN, send out over TLS and not open the field network to the office.
- **Hand-written scripts don't survive.** One-off scripts work until the first network drop, socket leak or SD card failure.
- **Field reality is messy.** Timeouts, CRC errors, rebooting devices, brokers going offline and inconsistent register maps are normal. Most tools treat them as exceptions.
- **BACnet tooling in the JavaScript ecosystem is thin.** Mature, maintained BACnet/IP support for modern runtimes is hard to find.

## Vision statement

**OT Gateway makes OT data boring, in the best sense: predictable, observable and correct, from the field bus to the broker, at every site, for a fraction of the usual cost.**

An operator with many sites should be able to put the same small gateway into every plant room or control cabinet, next to the controllers already there, and trust it to run unattended for months in its own network segment. A technician, with an AI assistant, should get a site from nothing to its first values in minutes. When something goes wrong, the gateway should say exactly what, where and since when, to the person and to their agent. A developer should be able to add a protocol driver without understanding the whole codebase, and test it against a simulated device on a laptop.

## Users and use cases

| User                                                           | What they need from OT Gateway                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Operator of many sites (buildings, plant rooms, process lines) | Every site's data in one standard shape, the same small install everywhere, at a fraction of a controller's cost |
| Integrator or technician                                       | A site set up quickly, with an AI assistant, from a points list; clear diagnostics on site                       |
| Data or platform team                                          | Reliable, normalized telemetry with names and units, without gaps, for dashboards, reporting or a data lake      |
| IT and security                                                | One container in its own VLAN, outbound MQTT over TLS, read-only unless writes are allowed, open code to audit   |
| Developer                                                      | A typed library to build a custom gateway or add a protocol driver                                               |

Typical use cases:

1. Poll energy meters over Modbus TCP and publish readings every few seconds.
2. Discover BACnet/IP devices, subscribe to change-of-value on key points and stream them to a broker.
3. Accept setpoint changes from MQTT and write them to the field device, inside strict limits.
4. Buffer data during a broker or uplink outage and replay it when the connection returns.
5. Roll the same gateway out to many sites with a few hundred points each, behind a cellular router, each in its own VLAN.
6. Find out why a device stopped answering, from the status page or by asking an AI assistant that reads the gateway's status and logs.

## Design principles

1. **Failure is a first-class value.** Every expected field failure is a typed error, handled on purpose, never swallowed.
2. **Unattended by default.** Retries with backoff, reconnects, supervised fibers, store-and-forward. A reboot is never the fix.
3. **Config is checked.** The point map is validated with Effect Schema at startup. A bad register address fails loudly at boot, not silently at runtime.
4. **Drivers are swappable.** Each protocol sits behind a common interface. Real devices and simulators are interchangeable.
5. **Observable out of the box.** Health, per-point freshness, error counts and traces are built in, including over MQTT.
6. **Safe writes.** Writing is opt-in, allowlisted, range-checked and logged. Reading is the default.
7. **Effect-native, small footprint.** Built on the Effect 4 ecosystem and nothing else where possible; protocol stacks are our own. Runs comfortably on a Raspberry Pi 4/5 and is gentle on SD cards.
8. **Library first, product second.** The core is a composable library; the gateway is a thin, opinionated assembly of it.
9. **One CLI for people and agents.** One `ot-gateway` command, from npm, sets up, checks and diagnoses the gateway. Every command has plain-text output for people, `--json` for agents and flags in place of questions, so an AI assistant uses the same commands a person would.
10. **AI translates, the CLI decides.** An AI assistant turns whatever the user has into the standard points list. Checking it, turning it into a config and running it are deterministic, so the AI's work passes the same checks as a list made by hand.
11. **Cheap per site.** A site's data should not need an industrial controller: small hardware, open source, and a setup that takes minutes, not a programming project.
12. **Secure in a segmented network.** It runs in its own network segment, connects out to the broker over TLS, keeps its status page on the machine itself, and only writes where a point allows it.
13. **Familiar tools over our own.** Setting up is `npx`, running is Docker Compose: the tools integrators, IT and coding agents already know. The gateway does not reimplement a service manager or an installer.

## Scope

**Goals**

- Modbus TCP first, then BACnet/IP, both implemented in-house on Effect
- MQTT 5 northbound with an in-house client and `site/building/device/point` topics
- Polling and BACnet change-of-value in; per point, scaling, and a publish mode out: each read, the latest per interval, clock-aligned aggregates (min, max, time-weighted average) or on change with a deadband
- Command write-back from MQTT with safety controls
- Store-and-forward in SQLite during outages
- JSON config validated with Effect Schema, loadable from a file or a database
- Built-in health, metrics and tracing
- A simulator for each driver
- A local status page in v1.0
- A public project and docs site, rendered from `docs/` so there is one source of truth
- The `ot-gateway` CLI on npm, the gateway bundled inside, so `npx ot-gateway` works without a checkout; Docker Compose as the way to run it unattended, systemd for hosts without Docker
- A standard points list as the input format for setting up without AI, with BACnet EDE import and device profiles for common Modbus devices

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
- **Core:** point map (Schema-checked config), scheduler (polling, COV, retry schedules), normalizer (scale, units), publish modes (sample, aggregate, change), command guard (allowlist, range limits)
- **Northbound:** store and forward (local SQLite buffer), MQTT 5 client (publish, last will, commands)
- **Observability** across all layers: health topics, point freshness, error counts, traces

Telemetry flows down from devices to the broker. Commands travel back up and must pass the command guard before they reach a device.

## Setup: one CLI, one points list

Most projects start with a points list: what to read, from which device, how often. Setting up a gateway should take that list and nothing else, with or without AI.

```
ot-gateway points template   (fill it in) ───────────┐
BACnet network      ── ot-gateway discover ──────────┤
BACnet EDE file     ── ot-gateway import ────────────┼─▶ standard points list ─▶ ot-gateway init ─▶ ot-gateway.json ─▶ docker compose up -d
any other list, PDF ── AI assistant ─────────────────┘   (a CSV you can read,     (checks every row,   compose.yaml
                                                           fix and run again)       writes nothing       ot-gateway.env
                                                                                    until valid)
```

On the machine on the building network:

```bash
npx ot-gateway init site-1   # a folder, as create-next-app makes one: questions or a points list, finds BACnet devices, checks everything
cd site-1
docker compose up -d            # runs it, restarts it, keeps its logs
npx ot-gateway status           # one line per device
```

- **Two jobs, two familiar tools.** Setting up happens where the person and their AI assistant work, so the CLI ships on npm: `npx` is how people already run Vercel's or Cloudflare's CLIs, and every coding agent can run it. Running the gateway around the clock is Docker Compose's job: restarts, updates (`docker compose pull`) and logs, on a Pi as on an industrial PC. Neither needs a checkout, git or a build.
- **The package.** esbuild bundles the CLI and the gateway into one ES module with no dependencies, next to the built status page; Node 22.18 or newer runs it. SQLite is Node's built-in `node:sqlite`, so there is nothing native to install. The container image carries the same CLI, so a Pi without Node runs `docker run --rm -it --network host -v "$PWD:/work" -w /work ghcr.io/phocal-ai/ot-gateway init`. A single executable with Node inside was tried and dropped: about 45 MB per platform, to spare Node where Docker already does.
- **The folder.** One folder per gateway holds `ot-gateway.json`, `ot-gateway.env` and `compose.yaml`; `init` writes all three, and `docker compose up -d` in it is the whole install. systemd (`packaging/install.sh`) stays documented for hosts without Docker.
- **The points list is the public input format.** Its columns are versioned and documented, and `ot-gateway points schema` prints them, so an agent learns the format from the CLI rather than from the repository. Commas, semicolons or tabs, column names in any order and case. CSV only: reading `.xlsx` would need a non-Effect dependency, so Excel lists are saved as CSV.
- **BACnet often needs no AI.** `discover` writes a draft points list to trim, and EDE files, the CSV export most BACnet engineering tools produce, import directly.
- **Device profiles for Modbus.** Modbus register maps are vendor PDFs in vendor layouts, which is where AI helps most. To avoid parsing the same meter twice, a profile describes one device model's registers, and a row in the points list names the profile and picks points by name. An AI assistant writes a profile from a datasheet once; reviewed profiles go into a shared library, so the common meters need no AI over time. Profiles need a format and a review process before they are accepted from outside.
- **With AI.** The assistant translates the user's list into the standard one and checks it with `npx ot-gateway import --dry-run` until it is clean, then `init` writes the folder and `docker compose up -d` starts it. The prompt to paste is short (read `npx ot-gateway points schema`, translate, check, start) and works in any agent that runs commands; the `/setup` skill is the fuller version for Claude Code, and an MCP server later offers the same commands as tools.
- **Writes stay a decision.** No list, profile or AI makes a point writable: that is set in the config, on purpose.

## Positioning

OT Gateway aims at the gap between visual flow tools on one side and closed vendor gateways and industrial controllers on the other: code-first, typed and testable, yet usable from a config file, and set up and debugged with an AI assistant.

| Kind of tool            | Strength                             | Where OT Gateway differs                                     |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Visual flow tools       | Fast prototyping, big ecosystems     | A typed config in version control, testable without hardware |
| Protocol gateways       | Many industrial protocols            | Open, small, with debugging and telemetry built in           |
| IoT platform connectors | Tight fit with their platform        | Standard MQTT to any broker, tied to no platform             |
| Metrics agents          | Excellent at collecting metrics      | Two-way, with guarded writes and point metadata              |
| Industrial controllers  | Proven hardware, programmed per site | A fraction of the cost per site; set up from a file, with AI |
| Vendor gateways         | Supported, certified                 | Open source, extensible, no lock-in                          |

## Roadmap

Modbus TCP to MQTT shipped end to end first, because it is the simplest protocol and proves the core. BACnet followed once the core was reliable. Write-back came after the read paths had run unattended.

| Version              | Focus                                                                                           | Status  |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| v0.1 Foundation      | Core + Schema, Modbus TCP, MQTT publish                                                         | Shipped |
| v0.2 Reliability     | Buffering, health topics, simulators + CI                                                       | Shipped |
| v0.3 BACnet/IP       | Discovery, ReadProperty, COV subscribe                                                          | Shipped |
| v0.4 Write-back      | MQTT commands, range limits, BACnet priority; brought forward: status page, packaging, `/setup` | Shipped |
| v0.5 Field hardening | Modbus field quirks, shared connections, host telemetry, the Pi test plan                       | Shipped |
| v0.6 OT Gateway      | Renamed from Plenum, Pi power monitoring, install from a blank SD card, security audit fixes    | Shipped |
| v1.0 Production      | Project and docs site, a measured 15-minute first run, a first real building                    | Next    |

### Where we are (2026-11-05)

A Raspberry Pi has run the gateway for 12 hours in real time against simulated devices with injected broker and device faults, with no errors, flat memory and no data loss. Every v1.0 feature in the original plan exists: the status page, the container image and systemd unit, and the `/setup` quickstart. What is missing is proof outside the lab, and a way for people to find and evaluate the project without reading the repo.

### The path to v1.0, in order

1. **Project and docs site.** A static site, hosted on Vercel, that explains what OT Gateway is for, who it is for and how it differs (see Positioning). The docs pages are rendered from `docs/*.md` and the README rather than copied, so `ConfigDocs.test.ts` keeps guarding the configuration reference.
2. **One CLI** (see "Setup: one CLI, one points list"), one step at a time:
   1. the `ot-gateway` npm package, published from CI on each release;
   2. the folder layout for Docker Compose (#98), and `init` writing `compose.yaml` and `ot-gateway.env` next to the config;
   3. `points schema` and `points template`, `--json` output and flags for every question, and `discover` writing a points list;
   4. EDE import;
   5. device profiles, then a reviewed profile library;
   6. `/setup` and the "Set it up with AI" prompt rewritten on top of the CLI, without a clone.
3. **A measured first run.** Time the path from "I found the site" to "Modbus readings in MQTT" on a fresh Pi and on a laptop, and fix what costs the most time: `/setup`, the messages from `--check` and `--discover`, the install steps and the status page. The success criterion is 15 minutes; the measurement says where the minutes go.
4. **Status page UX.** Answer the on-site questions first: is it working, what is broken, since when, and what to do about it. The page stays read-only and on `127.0.0.1` by default.
5. **A first real site** outside the maintainers' own projects, running a release unattended. Its 30 days are the evidence for the 30-day criterion; the lab Pi does not need to run a soak of its own.

After v1.0: an MCP server, so an agent can use the CLI's commands and read a running gateway's status, values and history as tools, the Next.js configuration app, a Brick or 223P exporter generated from the config, and loading the config from a database.

## Success criteria

- A gateway, on a Pi as on an industrial PC, stays up for 30 days with no manual intervention, through broker and network outages.
- No data loss during an outage that fits in the local buffer.
- A new user gets Modbus readings into MQTT in under 15 minutes from the README.
- Every driver has a simulator, and CI runs end-to-end tests without hardware.
- A new protocol driver can be added without changing the core.
- At least one real site outside the maintainers' own projects.
- A site costs a fraction of an industrial controller, hardware and setup time included.

## Decisions

| Topic            | Decision                                                                   | Notes                                                                      |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Runtime          | Node.js (LTS)                                                              | Bun is not a target                                                        |
| Distribution     | The CLI on npm (`npx ot-gateway`), the gateway in the container image      | Docker Compose runs it; no clone needed to set up or run; no single binary |
| Setup input      | A versioned points list (CSV), BACnet EDE files, device profiles           | AI translates into the points list; it never writes the config directly    |
| Effect version   | Latest Effect 4.x                                                          | Stable since late Sep 2026, bug fixes until at least Sep 2029              |
| Dependencies     | Effect-native: `effect` plus `@effect/*` packages                          | Use what Effect offers first; protocol stacks are written in-house         |
| MQTT             | MQTT 5                                                                     | In-house client on Effect sockets                                          |
| Topic convention | `site/building/device/point`                                               | Metadata on retained `.../point/$meta`                                     |
| Config format    | JSON, validated with Effect Schema                                         | Storable in a file or a database                                           |
| Buffer storage   | SQLite via `@effect/sql-sqlite-node`                                       | Uses Node's built-in `node:sqlite`, so no native build on ARM              |
| Monorepo         | pnpm workspaces + Turborepo                                                |                                                                            |
| Web UI           | Local status page in v1.0; Next.js configuration app after v1.0            | Separate package                                                           |
| Project site     | Static site on Vercel, docs rendered from `docs/`                          | Hobby plan now, Pro with the first customer                                |
| License          | MIT                                                                        |                                                                            |
| Semantic model   | Ontology-neutral core, optional Brick class and Haystack tags per point    | See below                                                                  |
| Commands         | Live only on `.../point/$set`, one result each, never retained or replayed | Limits required on writable numeric points; BACnet priority 8              |

## Semantic model

The core stays ontology-neutral, and each point can carry an optional Brick class and Haystack tags. The field is converging on RDF graphs with validation, but the formal standard (ASHRAE 223P) is not published yet.

| Model              | What it is                                                                               | Status (Nov 2026)                                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ASHRAE 223P        | RDF/SHACL standard for detailed system topology, connections and points                  | Second public review Apr to Jun 2026; publication expected by end of 2026 |
| Brick 1.4          | RDF/OWL class hierarchy for equipment, points and spaces, harmonized with RealEstateCore | Stable                                                                    |
| Project Haystack 5 | Tag-based model; v5 adds Xeto typed specs, validation and RDF export                     | Haystack 4 widely deployed; v5 specs still being built out                |

The three are moving toward each other: Haystack 5 exports to RDF and its Xeto tool translates Haystack to Brick, and Brick aligns with 223P. The likely end state is 223P for detailed engineering models, Brick as the lighter query layer, and Haystack tags as the vocabulary people use in the field.

What OT Gateway does:

1. The core point model stays neutral: id, name, unit, data type, writable, plus device context.
2. Each point can carry an optional `semantics` block with a Brick class (primary) and Haystack tags.
3. Units use QUDT identifiers, which Brick also uses.
4. Metadata is published on the retained `$meta` topic.
5. Later, an exporter generates Brick or 223P Turtle from the config as plain text, with no RDF library in the core.
