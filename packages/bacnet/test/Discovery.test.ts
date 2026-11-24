/**
 * describeDevice against a simulated device over real UDP on loopback: the
 * device's name, its pollable objects with names and QUDT units, and what
 * is left out.
 */
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseConfig } from "@ot-gateway/core"
import {
  describeDevice,
  makeBacnetClient,
  makeSimulatedDevice,
  serveSimulatedDevice,
  simulatedDeviceFor
} from "../src/index.ts"

const loopback = { address: "127.0.0.1", port: 0 }

describe("describeDevice", () => {
  it.live("names the device and its pollable objects, with QUDT units where they are known", () =>
    Effect.gen(function* () {
      const device = makeSimulatedDevice({
        instance: 2001,
        name: "Ventilation 2",
        objects: [
          {
            objectType: "analog-input",
            instance: 1,
            name: "Supply Air Temp",
            presentValue: { type: "real", value: 18.5 },
            units: 62
          },
          // 166 (no QUDT mapping here): the unit is left out, not guessed.
          {
            objectType: "analog-value",
            instance: 7,
            name: "Odd",
            presentValue: { type: "real", value: 1 },
            units: 166
          },
          { objectType: "binary-output", instance: 2, name: "Fan", presentValue: { type: "enumerated", value: 1 } },
          // Not a point: left out of the draft.
          { objectType: "schedule", instance: 1, name: "Week", presentValue: { type: "null" } }
        ]
      })
      const deviceSocket = yield* NodeDatagramSocket.make({ bind: loopback })
      const address = yield* serveSimulatedDevice(deviceSocket, device)
      const clientSocket = yield* NodeDatagramSocket.make({ bind: loopback })
      const client = yield* makeBacnetClient(clientSocket, {
        broadcastAddress: address,
        requestTimeout: "1 second",
        retries: 1
      })

      const described = yield* describeDevice(client, { address }, 2001)
      expect(described).toEqual({
        name: "Ventilation 2",
        listed: 5,
        objects: [
          { objectType: "analog-input", instance: 1, name: "Supply Air Temp", unit: "unit:DEG_C" },
          { objectType: "analog-value", instance: 7, name: "Odd" },
          { objectType: "binary-output", instance: 2, name: "Fan" }
        ]
      })
    }).pipe(Effect.scoped)
  )

  it.live("finds the config's units on a device simulated from it, and none where BACnet has no equivalent", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(
        JSON.stringify({
          site: "s",
          building: "b",
          mqtt: { url: "mqtt://broker" },
          devices: [
            {
              protocol: "bacnet-ip",
              id: "heat-pump",
              deviceInstance: 2001,
              points: [
                {
                  id: "flow-temperature",
                  name: "Heat pump flow temperature",
                  unit: "unit:DEG_C",
                  objectType: "analog-input",
                  instance: 1
                },
                // No BACnetEngineeringUnits for it here: the object has no units property.
                { id: "flow", name: "Flow", unit: "unit:M3-PER-HR", objectType: "analog-input", instance: 2 },
                { id: "running", name: "Running", objectType: "binary-input", instance: 1 }
              ]
            }
          ]
        })
      )
      const [heatPump] = config.devices
      if (heatPump?.protocol !== "bacnet-ip") return expect.unreachable("the config has one BACnet device")
      const device = simulatedDeviceFor(heatPump)
      const deviceSocket = yield* NodeDatagramSocket.make({ bind: loopback })
      const address = yield* serveSimulatedDevice(deviceSocket, device)
      const clientSocket = yield* NodeDatagramSocket.make({ bind: loopback })
      const client = yield* makeBacnetClient(clientSocket, {
        broadcastAddress: address,
        requestTimeout: "1 second",
        retries: 1
      })

      const described = yield* describeDevice(client, { address }, 2001)
      expect(described.objects).toEqual([
        { objectType: "analog-input", instance: 1, name: "Heat pump flow temperature", unit: "unit:DEG_C" },
        { objectType: "analog-input", instance: 2, name: "Flow" },
        { objectType: "binary-input", instance: 1, name: "Running" }
      ])
    }).pipe(Effect.scoped)
  )
})
