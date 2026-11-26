/**
 * Every code a command reports, in one table: what it means, what to do and the one command to run next. `explain`
 * prints from it, and the "Codes" table of docs/troubleshooting.md is checked against it (test/Codes.test.ts), so
 * this is the one place a code is described.
 *
 * To add a code: add a row to `codes` under its area. test/Codes.test.ts fails while a `code: "…"` in this
 * package's source has no row; `ot-gateway explain --markdown` prints the table to paste into the docs.
 *
 * Text here is plain (no Markdown, no `|`): it is printed in a terminal and put in a Markdown table as it is.
 */
import { type Hint, type Protocol, whatToCheck } from "@ot-gateway/api"
import { Result, Schema } from "effect"
import { closestMatch } from "./Suggest.ts"

/** Where the cause lies, most often: the order `explain` and the docs list the codes in. */
export type CodeArea = "config" | "broker" | "gateway" | "device" | "command" | "watch" | "machine" | "cli"

export interface CodeEntry {
  readonly code: string
  readonly area: CodeArea
  /** The commands, topics or pages that report it. */
  readonly reportedBy: ReadonlyArray<string>
  /** What it means, one or two sentences. */
  readonly meaning: string
  /** What to do, most likely first. */
  readonly fix: string
  /** One command to run next, when there is one. */
  readonly next?: string
}

export const areaTitles: Readonly<Record<CodeArea, string>> = {
  config: "The config",
  broker: "The broker",
  gateway: "The running gateway",
  device: "Devices",
  command: "Commands (write and $set/result)",
  watch: "watch",
  machine: "The machine",
  cli: "The command line"
}

/** The areas in the order `explain` and the docs list them. */
const areas: ReadonlyArray<CodeArea> = ["config", "broker", "gateway", "device", "command", "watch", "machine", "cli"]

/** Commands that read the config file before anything else. */
const configCommands = ["check", "run", "doctor", "read", "write", "broker", "watch", "publish", "discover", "import"]
/** Commands that ask the running gateway at its status page. */
const gatewayCommands = ["status", "events", "history", "messages", "logs", "doctor"]
/** Commands that connect to the config's broker. */
const brokerCommands = ["broker", "watch", "publish", "write", "doctor"]
/** Where a device's failure class shows up. */
const deviceReporters = ["status", "events", "doctor", "read", "the health topic"]
/** Where a command's result shows up. */
const commandReporters = ["write", "$set/result"]

export const codes: ReadonlyArray<CodeEntry> = [
  // The config
  {
    code: "no-config",
    area: "config",
    reportedBy: configCommands,
    meaning: "No config file at the path given (ot-gateway.json in this folder when none is named).",
    fix: "Run the command in the gateway's folder, or name its config. To write one, run ot-gateway init; to see the gateway work first, ot-gateway demo.",
    next: "ot-gateway init"
  },
  {
    code: "invalid-config",
    area: "config",
    reportedBy: configCommands,
    meaning:
      "The config file is not valid JSON, or breaks a rule of the config schema; with --json, issues lists each mistake with its path.",
    fix: "Fix each key the message names (docs/configuration.md has every key and its rule), then check again before restarting.",
    next: "ot-gateway check --json"
  },
  {
    code: "no-status-page",
    area: "config",
    reportedBy: gatewayCommands,
    meaning: "The config has no status block, so its gateway serves no status page or API to ask.",
    fix: 'Add "status": {} to the config and restart the gateway, or pass --url for a status page elsewhere.',
    next: "ot-gateway check"
  },
  {
    code: "missing-answers",
    area: "config",
    reportedBy: ["init"],
    meaning: "init had no terminal to ask and was not given its answers as flags, so it wrote nothing.",
    fix: "Pass the flags it names in missing (--site, --broker, --points), or --yes for the defaults.",
    next: "ot-gateway init . --yes --site my-site --broker mqtt://127.0.0.1:1883"
  },

  // The broker
  {
    code: "password-unset",
    area: "broker",
    reportedBy: brokerCommands,
    meaning: "The variable mqtt.passwordEnv names is not set or is empty, so nothing was sent to the broker.",
    fix: "Put the password in ot-gateway.env next to the config (NAME=...), or in /etc/ot-gateway/gateway.env under systemd.",
    next: "ot-gateway broker"
  },
  {
    code: "broker-unreachable",
    area: "broker",
    reportedBy: brokerCommands,
    meaning:
      "Nothing answered at mqtt.url: the broker is down, the host name is wrong, or it listens on another port or interface.",
    fix: "Check mqtt.url and that the broker runs and listens there (localhost may be 127.0.0.1 or ::1). ot-gateway demo runs a test broker on this machine.",
    next: "ot-gateway broker"
  },
  {
    code: "broker-timeout",
    area: "broker",
    reportedBy: brokerCommands,
    meaning: "Something at mqtt.url took the connection but did not answer as an MQTT broker in time.",
    fix: "A firewall, the wrong port, or TLS on one side only: mqtts:// for TLS, usually port 8883.",
    next: "ot-gateway broker"
  },
  {
    code: "broker-login-refused",
    area: "broker",
    reportedBy: brokerCommands,
    meaning: "The broker turned the login away: a wrong user name or password, or the user is not authorized.",
    fix: "Check mqtt.username and the password in the variable mqtt.passwordEnv names (in ot-gateway.env).",
    next: "ot-gateway broker"
  },
  {
    code: "broker-refused",
    area: "broker",
    reportedBy: brokerCommands,
    meaning: "The broker refused the connection for a reason other than the login; the message gives its reason.",
    fix: "Act on the reason the broker gave: busy, banned, a client id or protocol version it does not take.",
    next: "ot-gateway broker"
  },
  {
    code: "no-round-trip",
    area: "broker",
    reportedBy: ["broker", "write", "doctor"],
    meaning:
      "The broker took a message but did not deliver it back: its access rules let this user publish under site/building/# but not subscribe there, or the reverse.",
    fix: "Allow the gateway's user both to publish and to subscribe under site/building/#: the gateway reads its own topics, and write reads the command's result.",
    next: "ot-gateway broker"
  },
  {
    code: "broker-lost",
    area: "broker",
    reportedBy: ["watch"],
    meaning: "The broker or the network went away during watch and did not come back.",
    fix: "Check that the broker still runs and the network to it is up.",
    next: "ot-gateway broker"
  },
  {
    code: "broker-limits",
    area: "broker",
    reportedBy: ["doctor"],
    meaning:
      "The broker works, but one of its limits (maximum QoS, packet size, retained messages) leaves something out.",
    fix: "ot-gateway broker lists each limit and what it leaves out; raise it in the broker's settings if it matters here.",
    next: "ot-gateway broker"
  },

  // The running gateway
  {
    code: "gateway-unreachable",
    area: "gateway",
    reportedBy: gatewayCommands,
    meaning:
      "No gateway answered at the status page's address: it is not running, or its page listens on another address or port.",
    fix: "Start it (docker compose up -d in its folder, or ot-gateway run), name its config, or pass --url for a page elsewhere.",
    next: "docker compose up -d"
  },
  {
    code: "gateway-unreadable",
    area: "gateway",
    reportedBy: gatewayCommands,
    meaning: "A gateway answered in a form this CLI cannot read: it runs another release.",
    fix: "Upgrade the gateway, or run the CLI at the gateway's version; the message names both.",
    next: "ot-gateway --version"
  },
  {
    code: "wrong-gateway",
    area: "gateway",
    reportedBy: gatewayCommands,
    meaning:
      "Another gateway than the config's answers on its status port (two on one machine, or an old SSH tunnel), so its report would be about the wrong building.",
    fix: "Give one of the two gateways another status.port. To ask whichever gateway answers there, pass --url and no config.",
    next: "ot-gateway status"
  },
  {
    code: "gateway-unhealthy",
    area: "gateway",
    reportedBy: ["doctor"],
    meaning: "The gateway runs, and something fails: a device, or the broker connection.",
    fix: "The device and broker findings say what fails; ot-gateway events says what changed and when.",
    next: "ot-gateway status"
  },
  {
    code: "device-not-loaded",
    area: "gateway",
    reportedBy: ["doctor"],
    meaning:
      "The device is in the config, but the running gateway does not read it: the config changed after it started.",
    fix: "Restart the gateway so it loads the config.",
    next: "docker compose restart"
  },
  {
    code: "device-not-in-config",
    area: "gateway",
    reportedBy: ["doctor"],
    meaning: "The running gateway reads a device the config no longer has: the config changed after it started.",
    fix: "Restart the gateway so it loads the config.",
    next: "docker compose restart"
  },
  {
    code: "device-late",
    area: "gateway",
    reportedBy: ["doctor", "the status page"],
    meaning:
      "The device is not failing, but no read arrived for three poll intervals: a polling cycle is stuck. It becomes cycle-timeout at its deadline.",
    fix: "The gateway's warnings say which request hangs. Check the machine too: host.eventLoopLagMs and host.cpuPercent in ot-gateway status --json.",
    next: "ot-gateway logs --level warn --since 10m"
  },
  {
    code: "doctor-problems",
    area: "gateway",
    reportedBy: ["doctor"],
    meaning: "At least one of doctor's checks failed; each failing line has its own code.",
    fix: "Fix the first failure first: the later checks depend on the earlier ones. ot-gateway explain with a code says more about it.",
    next: "ot-gateway doctor --json"
  },

  // Devices
  {
    code: "connection",
    area: "device",
    reportedBy: deviceReporters,
    meaning: "The gateway cannot connect to the device, or the connection broke.",
    fix: "Check the device's address and port in the config, a firewall or VLAN in between, and whether the device takes only one client (many Modbus devices allow one or two).",
    next: "ot-gateway status"
  },
  {
    code: "timeout",
    area: "device",
    reportedBy: [...deviceReporters, ...commandReporters],
    meaning: "The device did not answer in time. For a command, the device may have applied it anyway.",
    fix: "Modbus: the unit id (each device behind a Modbus gateway has its own), or a serial bus too slow for the poll interval. BACnet: the device instance and UDP 47808. For a command, read the point back before sending it again.",
    next: "ot-gateway read"
  },
  {
    code: "protocol",
    area: "device",
    reportedBy: [...deviceReporters, ...commandReporters],
    meaning: "The device answered with a refusal: a Modbus exception or a BACnet error, which the message names.",
    fix: "Usually the address or table: register maps often count from 1 (40001) where the config counts from 0. For a command, the device refused the write.",
    next: "ot-gateway probe <host> <register>"
  },
  {
    code: "invalid-response",
    area: "device",
    reportedBy: deviceReporters,
    meaning: "The device answers, but with something the gateway cannot use.",
    fix: "Check the register map (address, type and length), the byte order of 32-bit values, and whether another device answers at this address or unit id.",
    next: "ot-gateway probe <host> <register>"
  },
  {
    code: "configuration",
    area: "device",
    reportedBy: deviceReporters,
    meaning:
      "The config does not work for this device: an object it does not have, another device answering at its address, or the gateway's own BACnet/IP port cannot be opened.",
    fix: "The error says what; ot-gateway check validates the config file, and ot-gateway discover lists the BACnet devices that answer.",
    next: "ot-gateway check"
  },
  {
    code: "not-implemented",
    area: "device",
    reportedBy: deviceReporters,
    meaning: "The gateway does not support something this device's config asks for.",
    fix: "The error says what: leave that point out, or read it another way.",
    next: "ot-gateway logs --level warn"
  },
  {
    code: "cycle-timeout",
    area: "device",
    reportedBy: ["status", "events", "the health topic"],
    meaning: "A polling cycle did not finish within its deadline: a read hangs.",
    fix: "A very slow device needs a longer poll interval; a device with many points, fewer points or a longer interval.",
    next: "ot-gateway logs --level warn --since 10m"
  },
  {
    code: "crashed",
    area: "device",
    reportedBy: ["status", "events", "the health topic"],
    meaning: "The device's pipeline stopped on an unexpected error, a bug in ot-gateway; it restarts with backoff.",
    fix: "The gateway's errors have the cause. Please report it with ot-gateway support.",
    next: "ot-gateway logs --level error"
  },
  {
    code: "no-devices",
    area: "device",
    reportedBy: ["read"],
    meaning: "The config has no devices to read.",
    fix: "ot-gateway discover finds BACnet devices; ot-gateway import adds the devices of a points list.",
    next: "ot-gateway discover"
  },
  {
    code: "no-device",
    area: "device",
    reportedBy: ["read"],
    meaning: "No device with that id in the config.",
    fix: "Use a device id from the config; the hint lists them.",
    next: "ot-gateway check"
  },
  {
    code: "no-point",
    area: "device",
    reportedBy: ["read"],
    meaning: "The device has no point with that id in the config.",
    fix: "Use a point id of that device; the hint lists them.",
    next: "ot-gateway check"
  },
  {
    code: "bacnet-port",
    area: "device",
    reportedBy: ["read"],
    meaning: "read found no free UDP port to ask BACnet/IP devices from.",
    fix: "Another program may hold every port it tried: a running gateway, the demo or a BACnet tool.",
    next: "ot-gateway status"
  },
  {
    code: "none-found",
    area: "device",
    reportedBy: ["discover modbus"],
    meaning:
      "discover modbus found no Modbus unit on the range: nothing took a connection on the port, or what did answered as no unit.",
    fix: "Check the range and the port (502 unless the datasheet says otherwise), that this machine reaches that network, and that no firewall drops it; the hint names what answered.",
    next: "ot-gateway discover modbus <range> --port 502"
  },
  {
    code: "points-list-exists",
    area: "device",
    reportedBy: ["discover modbus"],
    meaning: "The --points-list file exists already, so nothing was written over it.",
    fix: "Add --append to add the units found to it (rows it has are skipped), or name another file.",
    next: "ot-gateway discover modbus <range> --points-list points.csv --append"
  },
  {
    code: "points-list-invalid",
    area: "device",
    reportedBy: ["discover modbus"],
    meaning: "The --points-list file to append to is not a points list the CLI can read, so nothing was written.",
    fix: "Fix the file the message names, or write the units to a new file.",
    next: "ot-gateway import points.csv --dry-run"
  },
  {
    code: "points-list-ede",
    area: "device",
    reportedBy: ["discover modbus"],
    meaning: "The --points-list file to append to is a BACnet EDE file, not a points list, so nothing was written.",
    fix: "Turn it into a points list first with ot-gateway points from-ede, then append to that.",
    next: "ot-gateway points from-ede building.ede.csv"
  },
  {
    code: "bacnet-port-in-use",
    area: "device",
    reportedBy: ["doctor"],
    meaning: "Another program on this machine holds the BACnet/IP port (UDP 47808 unless bacnet.port says otherwise).",
    fix: "Stop it (a second gateway, the demo or a BACnet tool), or set bacnet.port to a free port; devices that answer a broadcast on 47808 then need a fixed address.",
    next: "ss -ulpn"
  },
  {
    code: "bacnet-port-unavailable",
    area: "device",
    reportedBy: ["doctor"],
    meaning: "The BACnet/IP port cannot be opened for a reason other than another program holding it.",
    fix: "Is bacnet.bindAddress an address of this machine? At boot the network may not be up yet.",
    next: "ot-gateway check"
  },

  // Commands
  {
    code: "unknown-point",
    area: "command",
    reportedBy: commandReporters,
    meaning: "No such device or point in the config (of this CLI, or of the running gateway).",
    fix: "Use a device/point from the config; the hint lists the writable ones. When this config has it, the running gateway runs another: restart it.",
    next: "ot-gateway status"
  },
  {
    code: "not-writable",
    area: "command",
    reportedBy: commandReporters,
    meaning: "The point lacks writable: true, so the guard refused the command before it reached the device.",
    fix: "Set writable: true on it (with limits for a number) in the config or on the status page, and restart the gateway.",
    next: "ot-gateway check"
  },
  {
    code: "wrong-type",
    area: "command",
    reportedBy: commandReporters,
    meaning:
      "The value does not fit the point: true or false for a binary point, a number otherwise, a whole number from 1 for a multi-state one, null only for BACnet.",
    fix: "Send a value of the point's type.",
    next: "ot-gateway write <device/point> <value>"
  },
  {
    code: "out-of-range",
    area: "command",
    reportedBy: commandReporters,
    meaning: "The value is outside the point's limits, so the guard refused it.",
    fix: "Send a value within limits.min and limits.max, or change the limits in the config.",
    next: "ot-gateway write <device/point> <value>"
  },
  {
    code: "retained",
    area: "command",
    reportedBy: ["$set/result"],
    meaning: "The command was published with the retain flag; commands must be live.",
    fix: "Clear the retained message (publish an empty retained one) and send the command without retain.",
    next: "ot-gateway publish <topic> --retain"
  },
  {
    code: "expired",
    area: "command",
    reportedBy: commandReporters,
    meaning: "The command waited more than 10 s (or its MQTT message expiry) behind other commands to the same device.",
    fix: "Usually the device is slow or not answering; check it, then try again.",
    next: "ot-gateway status"
  },
  {
    code: "invalid-payload",
    area: "command",
    reportedBy: ["$set/result"],
    meaning: 'The payload is not exactly {"value": ...}, with nothing else beside it.',
    fix: 'Send {"value": ...} alone; ot-gateway write builds it for you.',
    next: "ot-gateway contract command"
  },
  {
    code: "device-unavailable",
    area: "command",
    reportedBy: commandReporters,
    meaning: "The device is not running on the gateway (failing to connect, or restarting), so nothing was written.",
    fix: "Find out why the device fails first.",
    next: "ot-gateway status"
  },
  {
    code: "command-refused",
    area: "command",
    reportedBy: ["write"],
    meaning: "The broker's access rules did not let the command through; nothing was sent to the device.",
    fix: "Allow this user to publish on site/building/+/+/$set.",
    next: "ot-gateway broker"
  },
  {
    code: "command-unconfirmed",
    area: "command",
    reportedBy: ["write"],
    meaning: "The connection broke before the broker confirmed the command, so it may have arrived.",
    fix: "Read the point back before sending it again.",
    next: "ot-gateway read <device/point>"
  },
  {
    code: "no-result",
    area: "command",
    reportedBy: ["write"],
    meaning:
      "No gateway answered the command within --timeout (25 s): it is not running, runs another config, or uses another broker.",
    fix: "Check that the gateway runs with this config and broker. The command may still have been applied: read the point back before trying again.",
    next: "ot-gateway status"
  },
  {
    code: "invalid-result",
    area: "command",
    reportedBy: ["write"],
    meaning:
      "The answer on the result topic is not a command result: an older gateway, or another program publishing there.",
    fix: "ot-gateway watch --check shows what is off the MQTT contract.",
    next: "ot-gateway watch --check"
  },

  // watch
  {
    code: "values-missing",
    area: "watch",
    reportedBy: ["watch"],
    meaning: "watch --until-values ended before every point of the config sent a value; missing lists them.",
    fix: "ot-gateway status says why a device fails; the gateway must be running. A point that publishes on change only sends its first value at start.",
    next: "ot-gateway status"
  },
  {
    code: "off-contract",
    area: "watch",
    reportedBy: ["watch"],
    meaning: "watch --check saw messages that do not follow the MQTT contract; each is printed with what is wrong.",
    fix: "ot-gateway contract lists the fields. A gateway newer than this CLI may send fields a later contract added: compare the versions.",
    next: "ot-gateway contract"
  },
  {
    code: "nothing-checked",
    area: "watch",
    reportedBy: ["watch"],
    meaning: "watch --check saw no message under the config's site and building, so nothing was checked.",
    fix: "Is the gateway running? --check looks only at topics under the config's site and building.",
    next: "ot-gateway status"
  },
  {
    code: "nothing-to-wait-for",
    area: "watch",
    reportedBy: ["watch"],
    meaning: "The --topic filter covers none of the config's points, so --until-values has nothing to wait for.",
    fix: "Leave out --topic, or name a filter under the config's site and building.",
    next: "ot-gateway watch --until-values"
  },

  // The machine
  {
    code: "disk-low",
    area: "machine",
    reportedBy: ["doctor"],
    meaning: "Little free space where the buffer and the history write.",
    fix: "Free space (old logs, docker system prune), or move the data with OT_GATEWAY_DATA_DIR. When the disk is full, the buffer stops keeping values and the history stops writing.",
    next: "df -h"
  },
  {
    code: "clock-behind",
    area: "machine",
    reportedBy: ["doctor"],
    meaning: "This machine's clock is before the config's last change, so every ts the gateway publishes is wrong too.",
    fix: "A Raspberry Pi has no real-time clock and needs NTP after each boot: make an NTP server reachable from this network.",
    next: "timedatectl status"
  },

  // The command line
  {
    code: "usage",
    area: "cli",
    reportedBy: ["every command"],
    meaning: "An unknown command or flag, or a missing or malformed argument. Exit code 2.",
    fix: "The command's --help lists its arguments and flags, with examples.",
    next: "ot-gateway --help"
  },
  {
    code: "deadline",
    area: "cli",
    reportedBy: ["mcp"],
    meaning: "A tool call took longer than its deadline (15 minutes, its wait for a turn included) and was stopped.",
    fix: "Ask for less at once: fewer points or devices, a shorter --seconds for watch. What it printed before it stopped comes first in the result.",
    next: "ot-gateway status"
  },
  {
    code: "bug",
    area: "cli",
    reportedBy: ["mcp"],
    meaning: "A command failed in a way it does not expect, a bug in ot-gateway; the error carries the whole cause.",
    fix: "Please report it, with the error and the file ot-gateway support writes.",
    next: "ot-gateway support"
  },
  {
    code: "unknown-code",
    area: "cli",
    reportedBy: ["explain"],
    meaning: "explain does not know this code.",
    fix: "Copy the code as the command printed it; ot-gateway explain with no code lists every one.",
    next: "ot-gateway explain"
  }
]

/** `explain` was asked about a code it does not know. */
export class UnknownCode extends Schema.TaggedError<UnknownCode>()("UnknownCode", {
  message: Schema.String,
  code: Schema.Literal("unknown-code"),
  hint: Schema.String
}) {}

const byCode = new Map(codes.map((entry) => [entry.code, entry]))

/** The entry for `code`, as typed; also `rejected out-of-range` or `failed timeout`, as a command result reads. */
export const findCode = (code: string): CodeEntry | undefined => {
  const word = code.trim().toLowerCase()
  return byCode.get(word) ?? byCode.get(word.replace(/^(rejected|failed)\s+/, ""))
}

/** The entry for `code`, or `UnknownCode` naming the closest known one. */
export const explainCode = (code: string) => {
  const entry = findCode(code)
  if (entry !== undefined) return Result.succeed(entry)
  const closest = closestMatch(code.trim(), byCode.keys())
  return Result.fail(
    new UnknownCode({
      code: "unknown-code",
      message: `no code ${JSON.stringify(code)}${closest === undefined ? "" : `; did you mean ${closest}?`}`,
      hint: "ot-gateway explain lists every code"
    })
  )
}

/** The failure classes a device is `failing` with (the health topic's `reason`), which the status page has checks for. */
export const failureClasses: ReadonlySet<string> = new Set([
  "connection",
  "timeout",
  "protocol",
  "invalid-response",
  "configuration",
  "not-implemented",
  "cycle-timeout",
  "crashed"
])

const protocols: ReadonlyArray<readonly [Protocol, string]> = [
  ["modbus-tcp", "Modbus TCP"],
  ["bacnet-ip", "BACnet/IP"]
]

/** What to check per protocol for a device's failure class, as the status page has it; none for another code. */
export const deviceChecks = (entry: CodeEntry): ReadonlyArray<readonly [Protocol, Hint]> =>
  !failureClasses.has(entry.code)
    ? []
    : protocols.map(([protocol]) => [protocol, whatToCheck(protocol, entry.code, undefined)] as const)

/** `ot-gateway <rest>` as the user runs the CLI (`npx ot-gateway`, `pnpm ot-gateway`). */
const asInvoked = (command: string, cli: string) =>
  command.startsWith("ot-gateway") ? `${cli}${command.slice("ot-gateway".length)}` : command

/** A line's label in `formatCode`, and the indent of the lines under it. */
const label = (text: string) => `  ${text.padEnd(13)}`
const indent = " ".repeat(15)

/** One code as `explain <code>` prints it. */
export const formatCode = (entry: CodeEntry, cli = "ot-gateway") => {
  const checks = deviceChecks(entry)
  return [
    `${entry.code}: ${entry.meaning}`,
    "",
    `${label("what to do")}${entry.fix}`,
    ...checks.flatMap(([protocol, hint]) => [
      `${label(protocols.find(([each]) => each === protocol)?.[1] ?? protocol)}${hint.meaning}`,
      ...hint.checks.map((check) => `${indent}- ${check}`)
    ]),
    ...(entry.next === undefined ? [] : [`${label("next")}${asInvoked(entry.next, cli)}`]),
    `${label("reported by")}${entry.reportedBy.join(", ")}`
  ].join("\n")
}

/** Every code, one line each under its area, as `explain` with no code prints them. */
export const formatCodeList = () => {
  const width = Math.max(...codes.map((entry) => entry.code.length))
  return areas
    .flatMap((area) => {
      const rows = codes.filter((entry) => entry.area === area)
      return rows.length === 0
        ? []
        : [areaTitles[area], ...rows.map((entry) => `  ${entry.code.padEnd(width)}  ${entry.meaning}`), ""]
    })
    .join("\n")
    .trimEnd()
}

/** One code as `explain --json` gives it: the entry, with the per-protocol checks of a device's failure class. */
export const codeJson = (entry: CodeEntry, cli = "ot-gateway") => {
  const checks = deviceChecks(entry)
  return {
    ...entry,
    ...(entry.next === undefined ? {} : { next: asInvoked(entry.next, cli) }),
    ...(checks.length === 0 ? {} : { checks: Object.fromEntries(checks) })
  }
}

/** The docs' table of codes (docs/troubleshooting.md, "Codes"), one row per code in the order above. */
export const codesTable = () =>
  [
    "| Code | Reported by | Meaning | What to do |",
    "| --- | --- | --- | --- |",
    ...codes.map(
      (entry) =>
        `| \`${entry.code}\` | ${entry.reportedBy.join(", ")} | ${entry.meaning} | ${entry.fix}${entry.next === undefined ? "" : ` Next: \`${entry.next}\``} |`
    )
  ].join("\n")
