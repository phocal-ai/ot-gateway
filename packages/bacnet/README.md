# @plenum/bacnet

Effect-native BACnet/IP, implemented in-house against ASHRAE 135. The codecs are pure functions from bytes to a `Result`. Only the client and the simulator server do I/O, on `effect/socket/DatagramSocket`.

## Modules

| Module         | Covers                                                                                                                        | Spec                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `Bvlc.ts`      | BACnet/IP virtual link header                                                                                                 | Annex J               |
| `Npdu.ts`      | network layer header, with routing (`destination`, `source`) and network messages                                             | 6.2                   |
| `Apdu.ts`      | all eight APDU types. Segmented requests are refused; segmented acks are decoded but not reassembled                          | 20.1                  |
| `Encoding.ts`  | application and context tags, every application data type, constructed values                                                 | 20.2                  |
| `Services.ts`  | Who-Is / I-Am, ReadProperty, ReadPropertyMultiple, Error PDU bodies                                                           | 15.5, 15.7, 16.10, 18 |
| `Frame.ts`     | a whole datagram: BVLC + NPDU + APDU, including NPDUs a BBMD forwarded                                                        | Annex J.2             |
| `Enums.ts`     | object types, property identifiers, error classes and codes, by their hyphenated spec names (`analog-input`, `present-value`) | 21                    |
| `Simulator.ts` | a simulated device as pure request → response logic                                                                           |                       |
| `Client.ts`    | the UDP client: confirmed requests with retries, Who-Is discovery                                                             | 5.4.4, 16.10          |
| `Server.ts`    | puts a simulated device on a UDP socket                                                                                       |                       |

Character strings are read and written as UTF-8 only (character set 0), which is what current devices send.

## Simulator

`makeSimulatedDevice` builds a device object plus any number of objects, each with the standard required properties. `answer(device, apdu)` returns the device's response:

- **Who-Is** in range: I-Am.
- **ReadProperty / ReadPropertyMultiple:** the values. `all` and `required` are expanded, and the array properties (`object-list`, `priority-array`, `state-text`) can be read by index.
- **An error class and code** for an unknown object or property, an index into a non-array, or an index past the end.
- **Reject:** `invalid-tag` for a malformed request, `unrecognized-service` for any other confirmed service.
- **Abort** (`segmentation-not-supported`) when the answer is larger than the requester or the device accepts, because the simulator never segments.

`setPresentValue` changes a value the way a sensor would. `serveSimulatedDevice(socket, device)` answers datagrams on a socket until its scope closes. It sends I-Am back to the asker instead of broadcasting it, so several simulators can share one host on different ports.

## Client

`makeBacnetClient(socket, options)` owns one UDP socket for every BACnet device of the gateway. Bind it to port 47808 with broadcast enabled, because devices broadcast I-Am to that port.

- **`readProperty`, `readPropertyMultiple`, `confirmed`:** each request gets an invoke ID. After a timeout (`requestTimeout`, default 3 s) it is resent with the same ID, up to `retries` times (default 2). Only an answer from the address the request went to counts.
- **`discover`** broadcasts Who-Is (or sends it to one address) and collects the I-Am answers. **`locate`** finds one device by instance and resends Who-Is like a request.
- **Errors:** `BacnetTimeout`, `BacnetDeviceError` (`kind` `error`, `reject` or `abort`, with the class and code), `BacnetCodecError` for an answer that cannot be read, and `BacnetSocketError`.
- **Segmentation:** the client asks for unsegmented answers. An answer too large for one datagram comes back as an abort with reason `segmentation-not-supported`, and the caller reads fewer properties per request.
- **Socket failures:** a socket that fails while running is reopened every 5 s. A port that is already in use fails `makeBacnetClient` itself.

Requests are counted in `plenum_driver_requests` by `outcome` (`ok`, `timeout` per attempt, `exception` for an answer from the device, `invalid_response`, `connection`), like the Modbus client's.

## Next

1. A ReadProperty(Multiple) driver for the pipeline, with BACnet devices on the bench.
2. SubscribeCOV.

Part of [Plenum](../../README.md).
