# How it works

OT Gateway is a small program that runs on any always-on computer in a building: a mini PC, a NAS, a server, an industrial PC or a Raspberry Pi. It asks the building's devices for their values, and sends those values to wherever your software looks for them.

## The everyday problem

Say you look after an office building. It has an energy meter in the main switchboard and two air handlers on the roof. You already know what you want:

| What you want                    | From             | How often       |
| -------------------------------- | ---------------- | --------------- |
| Active power of the main meter   | the energy meter | every 5 seconds |
| Supply air temperature, per unit | each air handler | every 30 s      |
| Whether each fan is running      | each air handler | every 30 s      |

And you know where it should go: a dashboard, an energy report, an analytics platform, a digital twin. Those tools speak MQTT, the common language of IoT platforms. The devices don't: the meter speaks **Modbus TCP** and the air handlers speak **BACnet/IP**, two protocols that are decades old, everywhere in buildings, and unknown to most software.

OT Gateway is the translator in between.

```text
  in the building                    the gateway                       your software
 ┌──────────────────┐            ┌──────────────────┐            ┌──────────────────────┐
 │ energy meter     │  Modbus    │ asks every 5 s,  │   MQTT     │ dashboards           │
 │ air handler 1    │ ─────────▶ │ cleans the value │ ─────────▶ │ energy reports       │
 │ air handler 2    │  BACnet    │ adds name & unit │            │ analytics, alerts    │
 └──────────────────┘            └──────────────────┘            └──────────────────────┘
```

## What happens to one value

Follow the supply air temperature of air handler 1:

1. **Ask.** Every 30 seconds the gateway asks the air handler for object `analog-input 1`.
2. **Clean.** The device answers `21.5`. The gateway applies the scaling you set, if any (a meter that reports tenths of a kW, say), and checks the value is a real number.
3. **Skip the noise.** If it moved less than the deadband you chose (say 0.2 °C) since the last value it sent, nothing is sent. Your platform gets changes, not repetition.
4. **Send.** Otherwise it publishes, on a topic named after where the value comes from:

   ```text
   vienna-hq/main/ahu-1/supply-air-temp   {"value":21.5,"ts":1793631666939,"unit":"unit:DEG_C"}
   ```

5. **Keep it if the line is down.** If the broker can't be reached, the value waits in a small database on the gateway and goes out, in order, once the connection is back.

The topic always has the same four parts, `site/building/device/point`, so anyone reading the data can tell where it came from without a lookup table. Next to every point, the gateway also keeps a description (`.../supply-air-temp/$meta`: name, unit, and what kind of sensor it is), so a platform can label it without being told.

## Four words

- **Point:** one value you want, such as a temperature, a power reading or a fan status.
- **Device:** the thing that holds points: a meter, a controller, an air handler. It has an address on the network.
- **Broker:** the MQTT server your software connects to. The gateway sends there; it doesn't store or show data long-term itself.
- **Topic:** the name a value is sent under. With OT Gateway it is always `site/building/device/point`.

## What you write down

All of the above is one file, the config. It says, in plain JSON, which broker to send to, which devices to ask, which points they hold and how often to ask. `ot-gateway init` writes a first one for you from a few questions, and `ot-gateway check` points at every mistake before anything connects. For BACnet, the gateway finds the devices and their points itself (`ot-gateway discover`). For Modbus, you copy the registers from the device's documentation.

## How you know it works

- **The status page**, at `http://localhost:8080` on the gateway: every device, green or red with the reason, its latest values, and the messages that went to the broker.
- **`ot-gateway status`** says the same in the terminal, and **`ot-gateway watch`** prints every message as it reaches the broker.
- **A health message** on the broker says whether the gateway is online and which devices are failing, so your platform can alert on it.

## What it won't do by accident

Reading is all a gateway does unless you say otherwise. A point accepts commands from MQTT (a new setpoint, say) only when you mark it `writable` and give it limits, and every command is checked, written once and logged. A command is never replayed later from the buffer.

## Next

- [Try it](../README.md#quick-start) in one minute, with no devices.
- [Your first building](first-building.md): from your list of points to values on your broker.
