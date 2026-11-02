export * from "./Codec.ts"

/*
 * Next (v0.1): MQTT 5 client
 * - CONNECT / CONNACK with session expiry and a last will on the health topic
 * - PUBLISH QoS 0 and 1 (PUBACK), PINGREQ keep-alive
 * - SUBSCRIBE for command topics (needed in v0.4)
 * - a scoped connection on `effect/socket/Socket` (TCP, later TLS and WebSocket)
 * - `MqttPublisher: Layer<Publisher, MqttError>` implementing the core Publisher
 */
