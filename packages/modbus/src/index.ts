export * from "./Frame.ts"

/*
 * Next (v0.1): ModbusClient
 * - a scoped connection built on `effect/socket/Socket` with `NodeSocket`
 * - transaction ids, request timeouts, reconnect with backoff
 * - group adjacent registers into as few reads as possible
 * - `makeModbusDriver(device: ModbusDevice): Effect<Driver, never, Scope>`
 * - a Modbus TCP simulator server for tests (`effect/socket/SocketServer`)
 */
