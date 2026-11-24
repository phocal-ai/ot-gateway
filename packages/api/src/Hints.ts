/**
 * What to check when a device fails, by why it fails: the failure class the gateway reports (`DeviceStatus.reason`),
 * narrowed by the driver's words (`lastError`) and the protocol. One table, first match wins, so a new case is one
 * row. Shared by the status page's device sheet and `ot-gateway status`; pure, so it is tested on its own.
 */
import type { DeviceStatus } from "./Status.ts"

export type Protocol = DeviceStatus["protocol"]

/** What the failure means, in one sentence, and the things to check, most likely first. */
export interface Hint {
  readonly meaning: string
  readonly checks: ReadonlyArray<string>
}

interface Rule {
  readonly reason: string
  /** Only for this protocol; any protocol when absent. */
  readonly protocol?: Protocol
  /** Only when the driver's words match; any words when absent. */
  readonly error?: RegExp
  readonly hint: Hint
}

const firewall = "Is a firewall or a VLAN between the gateway and the device blocking the port?"

/** The BACnet/IP checks a device that stops answering gets, as a Modbus device gets its unit id and port. */
const bacnetInstance = "Is the device instance in the config the device's own (its Device object, not a point)?"
const bacnetPort =
  "Is BACnet/IP enabled on the device, on UDP 47808 or the port after the colon in its address in the config (as in 192.168.1.20:47809)?"
const bacnetSubnets =
  "Across subnets, broadcasts (Who-Is) do not cross routers: give the device a fixed address in the config, or set up a BBMD (bacnet.bbmdAddress)."
const bacnetRouted =
  "Behind a BACnet router (an MS/TP trunk, another network number): is the router up, and does it route the device's network number?"
const bacnetFirewall = "Is a firewall or a VLAN between the gateway and the device blocking UDP 47808?"

/** The hints, most specific first: the first rule whose reason, protocol and words match is the one shown. */
export const hintRules: ReadonlyArray<Rule> = [
  {
    reason: "connection",
    protocol: "bacnet-ip",
    error: /not been found|not found/i,
    hint: {
      meaning: "The gateway has not found the device: no I-Am answered its Who-Is.",
      checks: [bacnetInstance, bacnetSubnets, bacnetPort, bacnetRouted]
    }
  },
  {
    reason: "connection",
    protocol: "bacnet-ip",
    hint: {
      meaning: "The gateway cannot reach the device over BACnet/IP.",
      checks: [
        "Is the device switched on and its network cable plugged in (link light)?",
        bacnetPort,
        bacnetSubnets,
        bacnetFirewall
      ]
    }
  },
  {
    reason: "connection",
    error: /refused/i,
    hint: {
      meaning: "The address answers, but nothing accepts a connection on that port.",
      checks: [
        "Is the device switched on and its Modbus TCP server (or its network module) enabled?",
        "Are the host and port in the config right? Modbus TCP is usually port 502.",
        firewall
      ]
    }
  },
  {
    reason: "connection",
    error: /not found/i,
    hint: {
      meaning: "The device's host name does not resolve to an address.",
      checks: [
        "Is the host name in the config spelled right?",
        "Does this network's DNS know it? An IP address in the config avoids the question."
      ]
    }
  },
  {
    reason: "connection",
    error: /unreachable|no route|no answer from|timed out/i,
    hint: {
      meaning: "Nothing answers at that address: the device or the way to it is down.",
      checks: [
        "Is the device switched on and its network cable plugged in (link light)?",
        "Is the address in the config right, and is it in a network the gateway can reach (subnet, route)?",
        firewall
      ]
    }
  },
  {
    reason: "connection",
    hint: {
      meaning: "The gateway cannot connect to the device.",
      checks: ["Is the device switched on?", "Are the address and port in the config right?", firewall]
    }
  },
  {
    reason: "timeout",
    protocol: "bacnet-ip",
    error: /who-is/i,
    hint: {
      meaning: "No device with this instance number answered the gateway's broadcast (Who-Is).",
      checks: [bacnetInstance, bacnetSubnets, bacnetPort, bacnetRouted]
    }
  },
  {
    reason: "timeout",
    protocol: "bacnet-ip",
    hint: {
      meaning: "The device does not answer the gateway's BACnet requests in time.",
      // Config first for a device that never answered; whatToCheck moves power and cable up for one that did.
      checks: [
        bacnetInstance,
        "Is the device switched on and its network cable plugged in (link light)?",
        bacnetPort,
        bacnetSubnets,
        bacnetRouted,
        "Is the device busy (many clients, a slow MS/TP trunk)? A longer poll interval helps."
      ]
    }
  },
  {
    reason: "timeout",
    hint: {
      meaning: "The device is reachable, but it does not answer the gateway's requests in time.",
      checks: [
        "Is the unit id in the config the device's? Many answer only to theirs (often 1, sometimes 255 over TCP).",
        "Behind a Modbus gateway, is the serial device behind it powered and wired, with this unit id?",
        "Is the device busy, or does another master poll it? A longer poll interval helps."
      ]
    }
  },
  {
    reason: "protocol",
    protocol: "bacnet-ip",
    hint: {
      meaning: "The device answers, but refuses what the gateway asks for.",
      checks: [
        "Do the object types and instances in the config exist on this device (its EDE file or object list)?",
        "Does the object have the property asked for?"
      ]
    }
  },
  {
    reason: "protocol",
    hint: {
      meaning: "The device answers, but refuses the reads (a Modbus exception).",
      checks: [
        "Do the register addresses match the device's register map? Maps often count from 1 (40001) where the config counts from 0.",
        "Is the table right (holding or input registers, coils or discrete inputs)?",
        "Does the data type fit the map? A 32-bit value spans two registers."
      ]
    }
  },
  {
    reason: "invalid-response",
    hint: {
      meaning: "The device answers, but with something the gateway cannot use.",
      checks: [
        "Does the register map match: addresses, data type and length?",
        "Is the word order right for 32-bit values (byteOrder)?",
        "Does another device answer at this address or unit id?"
      ]
    }
  },
  {
    reason: "cycle-timeout",
    hint: {
      meaning: "A read hangs: the gateway gave up on the polling cycle.",
      checks: [
        "Is the device very slow to answer? A longer poll interval gives it more time.",
        "Does it have many points? Fewer per device, or a longer interval, helps."
      ]
    }
  },
  {
    reason: "configuration",
    hint: {
      meaning: "The config does not work for this device.",
      checks: ["The error above says what; ot-gateway check validates the config file."]
    }
  },
  {
    reason: "not-implemented",
    hint: {
      meaning: "The gateway does not support something this device's config asks for.",
      checks: ["The error above says what; leave that point out or read it another way."]
    }
  }
]

/** When no rule matches: the gateway's log has the rest. */
export const fallbackHint: Hint = {
  meaning: "The gateway cannot read the device.",
  checks: ["The gateway's log has the details: docker compose logs gateway --since 10m"]
}

/** What the gateway knows about a failure besides its words: whether the device worked, whether others failed too. */
export interface FailureContext {
  /** The device read fine earlier in this run: its config worked, so something changed at the device or on the way. */
  readonly answeredBefore?: boolean
  /** Other devices stopped answering at the same moment: likely one cause they share. */
  readonly sharedCause?: boolean
  /** With `sharedCause`: the one host they all sit on, which is then the likelier cause than a switch on the way. */
  readonly sharedHost?: string
}

/**
 * What to check for an alarm point that flaps: a fixed rhythm is rarely the plant tripping again and again. Shown
 * under an `alarm-flapping` event and a flapping alarm in `ot-gateway status`.
 */
export const flappingAlarmHint: Hint = {
  meaning: "The alarm switches on and off too often to be read as single trips.",
  checks: [
    "A fixed on/off rhythm like this usually points to the input's wiring or contact, or a device cycling, more than a real trip.",
    "Check the contact and its terminals, and whether the device restarts or switches on a schedule at that rhythm."
  ]
}

/** The failure classes where the device or the way to it is gone, rather than a reply the gateway cannot use. */
const unreachableReasons = new Set(["connection", "timeout", "cycle-timeout"])

/** A check about the config: it comes after the others for a device whose config has worked. */
const aboutConfig = (check: string) => /\bconfig\b/.test(check)

const sharedCheck =
  "Others failed with it: check what they share before its config, their power, the switch and cabling, and the gateway's own network link."
const sameHostCheck = (host: string) =>
  `Others on ${host} failed with it: check the host itself, its power and its network link before its config.`
const answeredCheck =
  "It answered earlier in this run, so its config worked: did it lose power, or a switch or cable on the way? A device whose network module hangs answers again after a restart."

/**
 * What to check for a device failing for `reason`, with the driver's words `error`; without a `protocol`, only the
 * rules for any. For a device that answered earlier in this run, or one of several that failed together, a device
 * or network that is gone is the likelier cause than its config, which worked: the checks then lead with power,
 * the switch, the cable and a restart, and the config's come last. Config checks lead only for a device that never
 * answered.
 */
export const whatToCheck = (
  protocol: Protocol | undefined,
  reason: string,
  error: string | undefined,
  context: FailureContext = {}
): Hint => {
  const hint =
    hintRules.find(
      (rule) =>
        rule.reason === reason &&
        (rule.protocol === undefined || rule.protocol === protocol) &&
        (rule.error === undefined || (error !== undefined && rule.error.test(error)))
    )?.hint ?? fallbackHint
  if (!unreachableReasons.has(reason) || (context.answeredBefore !== true && context.sharedCause !== true)) return hint
  const first =
    context.sharedCause !== true
      ? answeredCheck
      : context.sharedHost === undefined
        ? sharedCheck
        : sameHostCheck(context.sharedHost)
  const rest = hint === fallbackHint ? [] : hint.checks
  return {
    meaning: hint.meaning,
    checks: [
      first,
      ...(context.sharedCause === true && context.answeredBefore === true ? [answeredCheck] : []),
      ...rest.filter((check) => !aboutConfig(check)),
      ...rest.filter(aboutConfig),
      ...(hint === fallbackHint ? hint.checks : [])
    ]
  }
}
