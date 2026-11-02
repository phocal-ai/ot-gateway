# @plenum/bacnet

Effect-native BACnet/IP, implemented in-house against ASHRAE 135. The codecs are pure functions from bytes to a `Result`. The transport (next PR) will be the only part that does I/O.

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

Character strings are written as UTF-8 (character set 0). They are read leniently: UTF-8 with invalid bytes replaced, UCS-2, UCS-4 and ISO 8859-1, and the older DBCS and JIS sets byte by byte. A garbled description must not cost the present value read in the same request. Integers are read up to 8 bytes (above 2^53 they lose precision), and reals as the shortest decimal for the same single-precision number (72.4, not 72.40000152587891). Constructed values nest at most 32 deep.

## Simulator

`makeSimulatedDevice` builds a device object plus any number of objects, each with the standard required properties; outputs also get a priority array and relinquish default. Device instance 4,194,303 in a request reads the device itself, as on a real device. `answer(device, apdu)` returns the device's response:

- **Who-Is** in range: I-Am.
- **ReadProperty / ReadPropertyMultiple:** the values. `all` and `required` are expanded, and the array properties (`object-list`, `priority-array`, `state-text`) can be read by index.
- **An error class and code** for an unknown object or property, an index into a non-array, or an index past the end.
- **Reject:** `invalid-tag` for a malformed request, `unrecognized-service` for any other confirmed service.
- **Abort** (`segmentation-not-supported`) when the answer is larger than the requester or the device accepts, because the simulator never segments.

`setPresentValue` changes a value the way a sensor would. The UDP server that puts the simulator on the network comes with the transport.

## Next

1. UDP transport on `effect/socket/DatagramSocket`, with Who-Is discovery.
2. A ReadProperty(Multiple) driver for the pipeline.
3. SubscribeCOV.

Part of [Plenum](../../README.md).
