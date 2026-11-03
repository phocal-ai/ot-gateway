# @plenum/mqtt

Effect-native MQTT 5 client, implemented in-house: publishing, and subscriptions for commands.

- **Codecs** (`Codec.ts`, `Packet.ts`): pure encoding and decoding per OASIS MQTT 5.0 chapter 3.
  - CONNECT/CONNACK with properties, PUBLISH at QoS 0 and 1, PUBACK, PINGREQ/PINGRESP, DISCONNECT.
  - Stream framing: `makeFrameReader` reassembles control packets from socket chunks in linear time and reports a packet above the size limit from its fixed header, before buffering its body. `takePacket` splits one packet off a contiguous buffer.
  - Broker-side decoders too, so the test broker and the client share one codec.
- **Client** (`Client.ts`): `makeMqttClient(socket, options)` keeps one connection open for the life of its scope. `onConnect` runs after every connect.
  - Clean start, no session state: nothing unacknowledged is resent behind the caller's back.
  - Reconnects with jittered exponential backoff (1 s to 15 s by default, jittered), reset once a connection has held for 30 s, so a broker that accepts and then drops the client at once (a session taken over by a twin with the same client ID) is not redialed every second.
  - Keep alive: PINGREQ every half keep alive; a broker silent for 1.5 keep alives is dropped and redialed. Silence is timed on the monotonic clock, so NTP stepping the wall clock of a Pi without an RTC changes nothing. A Server Keep Alive of 0 turns off only the broker's check: the client keeps pinging at its own interval.
  - Two publishes in a row without a PUBACK in time close the connection too, so a half-open connection that still answers pings is redialed.
  - Announces a Maximum Packet Size of 1 MiB (`maximumPacketSize`) in CONNECT. A larger packet from the broker, or a CONNACK with Receive Maximum or Maximum Packet Size 0, is a protocol error: DISCONNECT with 0x95 or 0x82, then redial.
  - `publish(topic, payload, { qos, retain })` defaults to QoS 1 and completes on PUBACK. It waits up to `publishTimeout` (10 s) for a connection, and up to `publishTimeout` again for a free inflight slot (the broker's Receive Maximum) and the PUBACK, then fails; with `waitForConnection: false` it fails at once while disconnected (after the first dial, so a gateway that has just started does not fail its first messages). It never queues across an outage: [`@plenum/buffer`](../buffer) does that.
  - Failures are `rejected` only when retrying cannot help: an invalid topic, a message above the broker's limit, or PUBACK 0x87 (not authorized), 0x90 (topic name invalid), 0x95 (packet too large) or 0x99 (payload format invalid). Other PUBACK codes (0x80, 0x83, 0x97 quota exceeded, …) are `unavailable`, like a lost connection. `inFlight` marks a failure after the message went out (connection lost or no PUBACK), so the buffer can tell a message that keeps breaking the connection from an outage.
  - Respects the broker's CONNACK limits: Receive Maximum, Maximum QoS, Retain Available, Maximum Packet Size and Server Keep Alive.
  - Closing the scope sends DISCONNECT, so the broker discards the last will.
- **Publisher** (`Publisher.ts`): `MqttPublisher(config.mqtt, { health })` is the core `Publisher` layer.
  - Parses `mqtt://` and `mqtts://` (TLS) URLs, reads the password from the variable named by `passwordEnv`, and defaults the client ID to `plenum-<hostname>`.
  - With `health`, it publishes the gateway's retained online message on every connect, registers `offline` as the last will, and publishes `offline` itself on a clean shutdown.
  - Remembers the latest retained message per topic and publishes those from earlier connections again after a reconnect, 16 at a time, each on its own, so one the broker refuses does not keep the others off it. Values are not retained, so they are never replayed.
- **Test broker** (`TestBroker.ts`): `serveMqtt(server, control)` accepts connections, acknowledges and records publishes, and keeps retained payloads. `BrokerControl` refuses connections, withholds PUBACKs or PINGRESPs, refuses messages, or drops the client with DISCONNECT 0x95 on a packet above an unannounced size limit, for fault tests. `pnpm bench` runs it locally.

Metrics: `plenum_mqtt_connects_total{outcome}` (`ok`, `failed`, `rejected`) and `plenum_mqtt_connected`.

- **Subscriptions**: `subscriptions` are subscribed on every connect (the session is clean, so a message sent while the client was away is never delivered later), with Retain As Published when asked. Received messages are acknowledged on receipt and handed to `onMessage` with their retain flag, response topic and correlation data. The test broker routes publishes to subscribers, sends retained messages on subscribe, and `publishToSubscribers` lets a test send one.

Not yet: QoS 2, UNSUBSCRIBE and WebSocket transport.

Part of [Plenum](../../README.md).
