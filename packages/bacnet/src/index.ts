export * from "./Bvlc.ts"

/*
 * Roadmap (v0.3), each layer as pure codecs plus one scoped transport:
 * - NPDU encode/decode (network layer)
 * - APDU: Confirmed/Unconfirmed requests, segmentation basics
 * - Services: Who-Is / I-Am, ReadProperty, ReadPropertyMultiple,
 *   SubscribeCOV + COV notifications, WriteProperty with priority (v0.4)
 * - Transport on `effect/socket/DatagramSocket` with `NodeDatagramSocket`
 * - Foreign device registration (BBMD) for routed networks
 * - A BACnet/IP simulator device for tests
 */
