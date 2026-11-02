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
| `Driver.ts`    | the pipeline driver: Who-Is, batched ReadPropertyMultiple, ReadProperty fallback                                              | 15.5, 15.7            |

Character strings are written as UTF-8 (character set 0). They are read leniently: UTF-8 with invalid bytes replaced, UCS-2, UCS-4 and ISO 8859-1, and the older DBCS and JIS sets byte by byte. A garbled description must not cost the present value read in the same request. Integers are read up to 8 bytes (above 2^53 they lose precision), and reals as the shortest decimal for the same single-precision number (72.4, not 72.40000152587891). Constructed values nest at most 32 deep.

## Simulator

`makeSimulatedDevice` builds a device object plus any number of objects, each with the standard required properties; outputs also get a priority array and relinquish default. Device instance 4,194,303 in a request reads the device itself, as on a real device. `answer(device, apdu)` returns the device's response:

- **Who-Is** in range: I-Am.
- **ReadProperty / ReadPropertyMultiple:** the values. `all` and `required` are expanded, and the array properties (`object-list`, `priority-array`, `state-text`) can be read by index.
- **An error class and code** for an unknown object or property, an index into a non-array, or an index past the end.
- **Reject:** `invalid-tag` for a malformed request, `unrecognized-service` for any other confirmed service.
- **Abort** (`segmentation-not-supported`) when the answer is larger than the requester or the device accepts, because the simulator never segments.

`setPresentValue` changes a value the way a sensor would. `serveSimulatedDevice(socket, device)` answers datagrams on a socket until its scope closes. It sends I-Am back to the asker instead of broadcasting it, so several simulators can share one host on different ports.

## Client

`makeBacnetClient(socket, options)` owns one UDP socket for every BACnet device of the gateway. Bind it to port 47808 with broadcast enabled, because devices broadcast I-Am to that port.

- **`readProperty`, `readPropertyMultiple`, `confirmed`:** each request gets an invoke ID. After a timeout (`requestTimeout`, default 3 s) it is resent with the same ID, up to `retries` times (default 2). Only an answer from the address the request went to counts, and for a device behind a router (`network` set) only one that names it as the source. An answer about another object or property than was asked is refused as invalid. An invoke ID whose request was given up on rests for at least 10 s (twice the timeout if that is longer), so a late answer cannot be taken for a new request.
- **`discover`** broadcasts Who-Is to every BACnet network (or sends it to one address) and collects the I-Am answers. **`locate`** finds one device by instance and resends Who-Is like a request.
- **Errors:** `BacnetTimeout`, `BacnetDeviceError` (`kind` `error`, `reject` or `abort`, with the class and code), `BacnetCodecError` for an answer that cannot be read, and `BacnetSocketError`, also when a datagram cannot be sent within the timeout.
- **Segmentation:** the client asks for unsegmented answers. An answer too large for one datagram comes back as an abort with reason `segmentation-not-supported`, and the caller reads fewer properties per request. A device that segments anyway gets an Abort back.
- **Socket failures:** a socket that fails while running is reopened every 5 s. A port that is already in use fails `makeBacnetClient` itself. A datagram that cannot be handled is logged and dropped; it never stops the receive loop.

Requests are counted in `plenum_driver_requests` by `outcome`, once per request however often it was resent: `ok`, `timeout`, `exception` for an answer from the device, `invalid_response`, `connection`. Opening the socket is counted in `plenum_driver_connects` under the device name `$bacnet`, because one socket serves every BACnet device.

## Driver

`makeBacnetDriverFromClient(device, client)` turns a `bacnet-ip` device from the config into a pipeline `Driver`; `makeBacnetNetwork(settings)` opens the one client every BACnet device of the gateway shares, from the config's `bacnet` block.

- **Finding the device:** Who-Is for its `deviceInstance`, sent to its `address` if one is set, broadcast otherwise. The answer is remembered until a request times out, so a device that moved is found again.
- **Reading:** ReadPropertyMultiple in batches sized from the largest APDU the device accepts. A device that aborts or rejects an answer as too large gets half the batch from then on. A device that does not know ReadPropertyMultiple is read with ReadProperty, one point at a time.
- **Values:** numbers stay numbers; binary objects' `active`/`inactive` become `true`/`false`. A point whose object or property does not exist, or whose value is not a number or boolean, is skipped and logged when it starts and stops failing. The cycle fails only when no point could be read.
- **Errors:** a timeout is reported as `timeout`, a socket problem as `connection`, an unreadable answer as `invalid-response`, a point that does not resolve to an object type and property as `configuration`.

## Next

1. SubscribeCOV, so values arrive when they change instead of every poll.

Part of [Plenum](../../README.md).
