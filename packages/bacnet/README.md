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

Character strings are read and written as UTF-8 only (character set 0), which is what current devices send.

## Simulator

`makeSimulatedDevice` builds a device object plus any number of objects, each with the standard required properties. `answer(device, apdu)` returns the device's response:

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
