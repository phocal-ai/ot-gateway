/**
 * Editing a device on the Settings tab, without a browser: a device of the file as the form holds it, written back
 * without touching what the form does not know, the file with a device added, replaced or removed, and the
 * gateway's issues put under their field.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  deviceDraft,
  deviceIndex,
  deviceIssues,
  deviceJson,
  isDeviceChanged,
  newDevice,
  newPoint,
  pointJson,
  slugify,
  unitShown,
  unitValue,
  withDevice,
  canWrite,
  discoveredDevice,
  isBoolean,
  pickedByDefault,
  takesLimits,
  touching,
  visibleIssues,
  withoutDevice
} from "../src/lib/device-editor.ts"

const meter = {
  protocol: "modbus-tcp",
  id: "meter",
  host: "10.0.0.3",
  unitId: 1,
  pollIntervalMs: 5000,
  requestGapMs: 50,
  points: [
    {
      id: "power",
      name: "Active power",
      unit: "unit:KiloW",
      table: "holding",
      address: 100,
      dataType: "float32",
      scaling: { factor: 0.1 },
      publish: { mode: "change", deadband: 0.5, maxSilenceMs: 60000 }
    },
    { id: "breaker", name: "Breaker", table: "discrete", address: 0, dataType: "bool" }
  ]
}

const file = `${JSON.stringify(
  {
    site: "s",
    building: "b",
    mqtt: { url: "mqtt://localhost:1883" },
    devices: [meter, { protocol: "simulator", id: "sim", points: [] }]
  },
  null,
  2
)}\n`

const draftOf = (device: unknown) => {
  const draft = deviceDraft(device)
  if (draft === undefined) throw new Error("not an editable device")
  return draft
}

describe("deviceDraft", () => {
  it("holds a Modbus device's fields as typed, seconds for milliseconds", () => {
    const draft = draftOf(meter)
    expect(draft).toMatchObject({ protocol: "modbus-tcp", id: "meter", host: "10.0.0.3", port: "", unitId: "1" })
    expect(draft.intervalSeconds).toBe("5")
    expect(draft.points[0]).toMatchObject({
      name: "Active power",
      register: "100",
      scale: "0.1",
      publish: "change",
      deadband: "0.5",
      byteOrder: "ABCD"
    })
  })

  it("leaves a simulated device to the file", () => {
    expect(deviceDraft({ protocol: "simulator", id: "sim", points: [] })).toBeUndefined()
    expect(deviceDraft("meter")).toBeUndefined()
  })

  it("reads a point's short deadband as on change", () => {
    const draft = draftOf({ ...meter, points: [{ id: "t", name: "T", table: "input", address: 1, deadband: 2 }] })
    expect(draft.points[0]).toMatchObject({ publish: "change", deadband: "2" })
  })
})

describe("deviceJson", () => {
  it("writes an unchanged device back as the file had it, keys the form does not know included", () => {
    const draft = draftOf(meter)
    expect(deviceJson(draft)).toEqual(meter)
    expect(isDeviceChanged(draft)).toBe(false)
  })

  it("writes a changed point's fields and keeps its device's other settings", () => {
    const draft = draftOf(meter)
    const [power, breaker] = draft.points
    if (power === undefined || breaker === undefined) throw new Error("two points")
    const changed = { ...draft, intervalSeconds: "10", points: [{ ...power, register: "102", scale: "" }, breaker] }
    const json = deviceJson(changed)
    expect(json["pollIntervalMs"]).toBe(10000)
    expect(json["requestGapMs"]).toBe(50)
    expect(json["points"]).toEqual([
      {
        id: "power",
        name: "Active power",
        unit: "unit:KiloW",
        table: "holding",
        address: 102,
        dataType: "float32",
        publish: { mode: "change", deadband: 0.5, maxSilenceMs: 60000 }
      },
      meter.points[1]
    ])
    expect(isDeviceChanged(changed)).toBe(true)
  })

  it("writes a new Modbus device with numbers as numbers, kW as its QUDT name, and no defaults", () => {
    const draft = newDevice("modbus-tcp")
    const [point] = draft.points
    if (point === undefined) throw new Error("one point")
    const json = deviceJson({
      ...draft,
      id: "meter-1",
      host: " 127.0.0.1 ",
      port: "5020",
      points: [
        { ...point, name: "Active power", id: slugify("Active power"), register: "100", unit: "kW" },
        { ...newPoint("modbus-tcp"), name: "Breaker", id: "breaker", table: "discrete", register: "0", scale: "2" }
      ]
    })
    expect(json).toEqual({
      protocol: "modbus-tcp",
      id: "meter-1",
      host: "127.0.0.1",
      port: 5020,
      points: [
        {
          id: "active-power",
          name: "Active power",
          unit: "unit:KiloW",
          table: "holding",
          address: 100,
          dataType: "float32"
        },
        { id: "breaker", name: "Breaker", table: "discrete", address: 0, dataType: "bool" }
      ]
    })
  })

  it("writes what is not a number as typed, so the gateway's check names the field", () => {
    const draft = newDevice("bacnet-ip")
    const json = deviceJson({ ...draft, id: "ahu", deviceInstance: "twenty" })
    expect(json["deviceInstance"]).toBe("twenty")
  })

  it("writes a BACnet point and an aggregate in milliseconds", () => {
    const point = {
      ...newPoint("bacnet-ip"),
      id: "t1",
      name: "T1",
      instance: "1",
      publish: "aggregate" as const,
      publishSeconds: "300"
    }
    expect(pointJson("bacnet-ip", point)).toEqual({
      id: "t1",
      name: "T1",
      objectType: "analog-input",
      instance: 1,
      publish: { mode: "aggregate", intervalMs: 300000 }
    })
  })
})

describe("the file", () => {
  it("adds a device at the end and replaces one in place, everything else as it was", () => {
    const added = withDevice(file, undefined, { ...newDevice("bacnet-ip"), id: "ahu", deviceInstance: "2001" })
    expect(added).toBeDefined()
    expect(JSON.parse(added ?? "")["devices"].map((device: { id: string }) => device.id)).toEqual([
      "meter",
      "sim",
      "ahu"
    ])
    const draft = draftOf(meter)
    expect(withDevice(file, 0, draft)).toBe(file)
    expect(withDevice("{ broken", 0, draft)).toBeUndefined()
  })

  it("removes a device and finds one by id", () => {
    expect(deviceIndex(file, "sim")).toBe(1)
    expect(deviceIndex(file, "nope")).toBeUndefined()
    const removed = withoutDevice(file, 0)
    expect(JSON.parse(removed ?? "")["devices"]).toEqual([{ protocol: "simulator", id: "sim", points: [] }])
  })
})

describe("deviceIssues", () => {
  it("puts the gateway's issues under the device's and each point's field", () => {
    const draft = draftOf(meter)
    const [power] = draft.points
    if (power === undefined) throw new Error("a point")
    const issues = deviceIssues(
      [
        { path: ["devices", 0, "host"], message: "must not be empty" },
        { path: ["devices", 0, "pollIntervalMs"], message: "too short" },
        { path: ["devices", 0, "points", 0, "address"], message: "at most 65534" },
        { path: ["devices", 0, "points", 0, "scaling", "factor"], message: "not 0" },
        { path: ["devices", 0, "requestGapMs"], message: "too long" },
        { path: ["devices", 1, "id"], message: "duplicate" },
        { path: [], message: "broken" }
      ],
      0,
      draft
    )
    expect(issues.device).toEqual({ host: ["must not be empty"], intervalSeconds: ["too short"] })
    expect(issues.points[power.key]).toEqual({ register: ["at most 65534"], scale: ["not 0"] })
    expect(issues.other).toEqual(["requestGapMs: too long"])
    expect(issues.elsewhere).toEqual(["devices.1.id: duplicate", "broken"])
  })
})

describe("unitValue", () => {
  it("writes the common spellings as QUDT names and anything else as typed", () => {
    expect(unitValue("kW")).toBe("unit:KiloW")
    expect(unitValue("°c")).toBe("unit:DEG_C")
    expect(unitValue("unit:HZ")).toBe("unit:HZ")
    expect(unitValue(" ")).toBe("")
  })
})

describe("unitShown", () => {
  it("shows a known QUDT name as its symbol, which unitValue writes back", () => {
    expect(unitShown("unit:KiloW")).toBe("kW")
    expect(unitValue(unitShown("unit:KiloW"))).toBe("unit:KiloW")
    expect(unitShown("unit:HZ")).toBe("unit:HZ")
    expect(draftOf(meter).points[0]?.unit).toBe("kW")
  })
})

/** A check's issues about a new device's id and host and its first point's id and address. */
const issuesOf = (draft: ReturnType<typeof newDevice>) =>
  deviceIssues(
    [
      { path: ["devices", 0, "id"], message: "Expected a slug" },
      { path: ["devices", 0, "host"], message: "a host, without a port" },
      { path: ["devices", 0, "points", 0, "id"], message: "Expected a slug" },
      { path: ["devices", 0, "points", 0, "address"], message: "Expected number" }
    ],
    0,
    draft
  )

describe("visibleIssues", () => {
  it("shows a new device's issues only under the fields typed in, and says that some wait", () => {
    const draft = { ...newDevice("modbus-tcp"), host: "10.0.0.3:502" }
    const [point] = draft.points
    if (point === undefined) throw new Error("one point")
    const shown = visibleIssues(issuesOf(draft), draft, touching(new Set(), "device", "host", false), false)
    expect(shown.device).toEqual({ host: ["a host, without a port"] })
    expect(shown.points[point.key]).toEqual({})
    expect(shown.quiet).toBe(true)
  })

  it("counts a typed name as touching the id that follows it, and shows everything once asked", () => {
    const draft = newDevice("modbus-tcp")
    const [point] = draft.points
    if (point === undefined) throw new Error("one point")
    const touched = touching(new Set(), point.key, "name", true)
    expect(visibleIssues(issuesOf(draft), draft, touched, false).points[point.key]).toEqual({
      id: ["Expected a slug"]
    })
    const all = visibleIssues(issuesOf(draft), draft, new Set(), true)
    expect(all.quiet).toBe(false)
    expect(all.points[point.key]).toEqual({ id: ["Expected a slug"], register: ["Expected number"] })
  })

  it("shows every issue of a device and point the file has already", () => {
    const draft = draftOf(meter)
    const shown = visibleIssues(issuesOf(draft), draft, new Set(), false)
    expect(shown.device["host"]).toEqual(["a host, without a port"])
    expect(shown.quiet).toBe(false)
  })
})

describe("alarms and writes", () => {
  it("writes alarmWhen for a boolean point only", () => {
    const breaker = { ...newPoint("modbus-tcp"), name: "Main breaker tripped", id: "breaker", table: "discrete" }
    expect(pointJson("modbus-tcp", { ...breaker, register: "0", alarmWhen: "on" })).toMatchObject({
      table: "discrete",
      dataType: "bool",
      alarmWhen: "on"
    })
    const power = { ...newPoint("modbus-tcp"), id: "power", register: "100", alarmWhen: "on" as const }
    expect(pointJson("modbus-tcp", power)).not.toHaveProperty("alarmWhen")
    expect(draftOf({ ...meter, points: [{ ...meter.points[1], alarmWhen: "off" }] }).points[0]?.alarmWhen).toBe("off")
  })

  it("writes a writable point with its limits, and none of it once it is read-only again", () => {
    const setpoint = { ...newPoint("modbus-tcp"), id: "setpoint", register: "10", writable: true }
    expect(pointJson("modbus-tcp", { ...setpoint, limitMin: "15", limitMax: "25,5" })).toMatchObject({
      writable: true,
      limits: { min: 15, max: 25.5 }
    })
    // Without limits the gateway's check names the field: the limits are written as typed.
    expect(pointJson("modbus-tcp", setpoint)).toMatchObject({ writable: true, limits: { min: "", max: "" } })
    const relay = { ...newPoint("modbus-tcp"), id: "relay", table: "coil", register: "1", writable: true }
    expect(pointJson("modbus-tcp", relay)).not.toHaveProperty("limits")
    const original = {
      id: "sp",
      name: "Sp",
      table: "holding",
      address: 1,
      dataType: "float32",
      writable: true,
      limits: { min: 1, max: 2 }
    }
    const draft = draftOf({ ...meter, points: [original] }).points[0]
    if (draft === undefined) throw new Error("one point")
    expect(draft).toMatchObject({ writable: true, limitMin: "1", limitMax: "2" })
    const readOnly = pointJson("modbus-tcp", { ...draft, writable: false })
    expect(readOnly).not.toHaveProperty("writable")
    expect(readOnly).not.toHaveProperty("limits")
  })

  it("knows which points can be written and which need limits", () => {
    const point = newPoint("modbus-tcp")
    expect(canWrite("modbus-tcp", { ...point, table: "input" })).toBe(false)
    expect(canWrite("modbus-tcp", { ...point, table: "coil" })).toBe(true)
    expect(takesLimits("modbus-tcp", { ...point, table: "coil" })).toBe(false)
    expect(takesLimits("modbus-tcp", point)).toBe(true)
    const object = newPoint("bacnet-ip")
    expect(canWrite("bacnet-ip", { ...object, objectType: "analog-input" })).toBe(false)
    expect(canWrite("bacnet-ip", { ...object, objectType: "analog-value" })).toBe(true)
    expect(isBoolean("bacnet-ip", { ...object, objectType: "binary-output" })).toBe(true)
    expect(takesLimits("bacnet-ip", { ...object, objectType: "binary-output" })).toBe(false)
  })
})

describe("discoveredDevice", () => {
  const found = {
    instance: 2001,
    address: "127.0.0.1:47809",
    name: "Heat pump",
    id: "heat-pump",
    listed: 4,
    durationMs: 120,
    objects: [
      {
        objectType: "analog-input",
        instance: 1,
        name: "Flow",
        id: "flow",
        unit: "unit:DEG_C",
        value: 41.5,
        configured: false
      },
      { objectType: "binary-value", instance: 2, name: "Fault", id: "fault", value: false, configured: false },
      { objectType: "analog-output", instance: 3, name: "Setpoint", id: "setpoint", value: 45, configured: false },
      { objectType: "analog-input", instance: 4, name: "Return", id: "return", configured: true }
    ]
  }

  it("ticks inputs and values to start with, not outputs or objects read already", () => {
    expect(found.objects.filter(pickedByDefault).map((object) => object.id)).toEqual(["flow", "fault"])
  })

  it("makes a new BACnet device of the objects picked, with their names and units, none writable", () => {
    const draft = discoveredDevice(found, new Set(["analog-input:1", "analog-output:3"]))
    expect(draft).toMatchObject({
      protocol: "bacnet-ip",
      id: "heat-pump",
      deviceInstance: "2001",
      address: "127.0.0.1:47809"
    })
    expect(draft.points.map((point) => [point.id, point.name, point.unit, point.objectType, point.instance])).toEqual([
      ["flow", "Flow", "°C", "analog-input", "1"],
      ["setpoint", "Setpoint", "", "analog-output", "3"]
    ])
    expect(deviceJson(draft)).toEqual({
      protocol: "bacnet-ip",
      id: "heat-pump",
      deviceInstance: 2001,
      address: "127.0.0.1:47809",
      points: [
        { id: "flow", name: "Flow", unit: "unit:DEG_C", objectType: "analog-input", instance: 1 },
        { id: "setpoint", name: "Setpoint", objectType: "analog-output", instance: 3 }
      ]
    })
  })
})
