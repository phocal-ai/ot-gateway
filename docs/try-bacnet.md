# Try BACnet with two machines

The demo runs everything on one machine. To try BACnet/IP the way it works in a building, across a real network, run a simulated device on one machine (a Raspberry Pi, say) and the gateway on another (your laptop): the gateway finds the device with a broadcast, reads its values and writes a setpoint back. Half an hour, no building needed.

## The simulated device

`ot-gateway simulate bacnet` is one BACnet/IP device, instance 1001, named "Demo room", with three objects:

| Object           | Name                 | What it does                                                                     |
| ---------------- | -------------------- | -------------------------------------------------------------------------------- |
| `analog-input 1` | Room temperature     | °C, read-only. Rises 3 K a minute while the heating runs, falls slowly otherwise |
| `analog-value 1` | Temperature setpoint | °C, writable, 21 to start with                                                   |
| `binary-input 1` | Heating              | Read-only. On while the room is more than 0.3 K below the setpoint               |

Write a higher setpoint and within a second the heating switches on and the temperature starts climbing towards it. The device answers Who-Is, ReadProperty, ReadPropertyMultiple, SubscribeCOV and WriteProperty, and prints every write it takes.

## 1. Start the device

On the machine that plays the device (the Pi), with Docker:

```bash
docker run --rm -it --network host --name ot-gateway-simulate ghcr.io/phocal-ai/ot-gateway simulate bacnet
```

Or with the `ot-gateway` command from [the Pi install](raspberry-pi-install.md) (it uses host networking already), or with Node 22.18 or later:

```bash
ot-gateway simulate bacnet
```

```bash
npx ot-gateway simulate bacnet
```

It prints its objects, its addresses on the LAN and the command to find it. `--network host` matters: Docker's port publishing (`-p 47808:47808/udp`) does not pass the broadcast Who-Is through to a container. Stop it with Ctrl+C (`docker stop ot-gateway-simulate` from another terminal).

## 2. Find it

On the other machine (the laptop), in a new folder:

```bash
mkdir demo-room && cd demo-room
```

```bash
npx ot-gateway discover --points-list points.csv
```

It broadcasts Who-Is, lists what answers (`device 1001 at 192.168.1.20:47808: "Demo room", 3 point(s)`) and writes its three points to `points.csv`. If nothing answers, ask the device by its address, which the device printed when it started: `npx ot-gateway discover --address 192.168.1.20 --points-list points.csv`. [When it does not work](#when-it-does-not-work) has the usual causes.

## 3. A broker and a config

The gateway publishes to an MQTT broker. For a try on the laptop, Mosquitto in Docker, without passwords:

```bash
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
```

Then the config, from the points list:

```bash
npx ot-gateway init . --yes --site home --broker mqtt://localhost:1883 --points points.csv
```

Nothing is writable until the config says so, on purpose. In `ot-gateway.json`, give the setpoint `writable` and the range a command may set:

```json
{
  "id": "temperature-setpoint",
  "name": "Temperature setpoint",
  "unit": "unit:DEG_C",
  "objectType": "analog-value",
  "instance": 1,
  "writable": true,
  "limits": { "min": 15, "max": 28 }
}
```

```bash
npx ot-gateway check
```

## 4. Run it

```bash
npx ot-gateway run
```

On macOS and Windows, run the gateway this way rather than in Docker: Docker Desktop runs containers in a virtual machine that the LAN's broadcasts do not reach. (What goes to an address still works from there: `discover --address`, and reading and writing a device whose `address` is in the config, as `discover` writes it. Only finding devices by broadcast does not.) The status page is at http://127.0.0.1:8080. In a second terminal, what arrives at the broker:

```bash
npx ot-gateway watch
```

`home/main/demo-room/room-temperature` arrives every second while it changes, since the gateway subscribes to the device's changes (COV).

## 5. Write the setpoint

```bash
npx ot-gateway publish 'home/main/demo-room/temperature-setpoint/$set' '{"value": 24}'
```

The device prints `write: Temperature setpoint set to 24 °C (priority 8)` (and `heating on at …`, if the heating was off), `watch` shows the heating at `true` and the temperature rising, and the result of the command arrives on `home/main/demo-room/temperature-setpoint/$set/result`. A value outside `limits` is refused by the gateway and never reaches the device.

## When it does not work

| Symptom                                                         | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover` finds nothing, `--address` does                      | The broadcast does not arrive. A guest Wi-Fi or one with client isolation drops it, and so does a router between two subnets. A VPN on the laptop can take the broadcast out of the wrong interface: `255.255.255.255` leaves through the default route's. Use `--address`; for the config, `bacnet.broadcastAddress` set to the subnet's broadcast (`192.168.1.255`) or the device's fixed `address` (which `discover` writes anyway). |
| `discover` finds nothing, `--address` neither                   | Nothing reaches the device. Check that it runs and that the address is the one it printed; with Docker, that it has `--network host`. A firewall on the device's machine can drop UDP 47808.                                                                                                                                                                                                                                            |
| The temperature arrives every 5 seconds, not every second       | The device's change notifications do not reach the gateway, so it reads every `pollIntervalMs` (5 s) instead. On macOS, allow incoming connections for `node` when the firewall asks (System Settings, Network, Firewall).                                                                                                                                                                                                              |
| `the BACnet/IP port 0.0.0.0:47808 is in use by another program` | On the laptop: a running gateway, the demo or a BACnet tool (a BACnet explorer) holds UDP 47808. `lsof -nP -iUDP:47808` names it; stop it. `discover --address` works anyway, from a free port.                                                                                                                                                                                                                                         |
| `simulate`: `UDP port 47808 is in use`                          | On the device's machine, a gateway with BACnet devices, the demo or another simulator holds it. Stop it, or run the device on another port: `simulate bacnet --port 47810`. A broadcast Who-Is goes to 47808 only, so discover it with `--address 192.168.1.20:47810`.                                                                                                                                                                  |
| `more than one address answered` for device 1001                | Two simulators run with the same instance: give each its own with `--instance 1002`.                                                                                                                                                                                                                                                                                                                                                    |
| `npx ot-gateway simulate` is an unknown command                 | An ot-gateway from before `simulate`: `npx ot-gateway@latest`, or pull the image again.                                                                                                                                                                                                                                                                                                                                                 |
