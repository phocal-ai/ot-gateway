# @plenum/mqtt

Effect-native MQTT 5 publishing client, implemented in-house.

- **Codecs** (`Codec.ts`, `Packet.ts`): pure encoding and decoding per OASIS MQTT 5.0 chapter 3.
  - CONNECT/CONNACK with properties, PUBLISH at QoS 0 and 1, PUBACK, PINGREQ/PINGRESP, DISCONNECT.
  - Stream framing: `takePacket` splits a TCP byte stream into control packets.
  - Broker-side decoders too, so the test broker and the client share one codec.
- **Client** (`Client.ts`): `makeMqttClient(socket, options)` keeps one connection open for the life of its scope. `onConnect` runs after every connect.
  - Clean start, no session state: nothing unacknowledged is resent behind the caller's back.
  - Reconnects with jittered exponential backoff (1 s to 60 s by default), reset after a good connection.
  - Keep alive: PINGREQ every half keep alive; a broker silent for 1.5 keep alives is dropped and redialed.
  - `publish(topic, payload, { qos, retain })` defaults to QoS 1 and completes on PUBACK. It waits up to `publishTimeout` (10 s) for a connection and then for the PUBACK, then fails. It never queues across an outage.
  - Respects the broker's CONNACK limits: Receive Maximum, Maximum QoS, Retain Available, Maximum Packet Size and Server Keep Alive.
  - Closing the scope sends DISCONNECT, so the broker discards the last will.
- **Publisher** (`Publisher.ts`): `MqttPublisher(config.mqtt, { health })` is the core `Publisher` layer.
  - Parses `mqtt://` and `mqtts://` (TLS) URLs, reads the password from the variable named by `passwordEnv`, and defaults the client ID to `plenum-<hostname>`.
  - With `health`, it publishes the gateway's retained online message on every connect, registers `offline` as the last will, and publishes `offline` itself on a clean shutdown.
  - Remembers the latest retained message per topic and publishes them again after a reconnect. Values are not retained, so they are never replayed.
- **Test broker** (`TestBroker.ts`): `serveMqtt(server, control)` accepts connections, acknowledges and records publishes, and keeps retained payloads. `BrokerControl` refuses connections, withholds PUBACKs or PINGRESPs, or refuses messages, for fault tests. `pnpm bench` runs it locally.

Metrics: `plenum_mqtt_connects_total{outcome}` (`ok`, `failed`, `rejected`) and `plenum_mqtt_connected`.

Not yet: store-and-forward (v0.2), SUBSCRIBE for commands (v0.4), QoS 2 and WebSocket transport.

Part of [Plenum](../../README.md).
