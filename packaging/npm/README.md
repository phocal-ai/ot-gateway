# ot-gateway

An open-source edge gateway for buildings: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back. This package is its command line, with the whole gateway inside.

```bash
npx ot-gateway demo                    # a simulated building, a test broker and the status page on http://127.0.0.1:8080
npx ot-gateway init my-building        # a few questions → my-building/ with ot-gateway.json, compose.yaml, ot-gateway.env
npx ot-gateway import points.csv       # add the devices of a points list
npx ot-gateway discover ot-gateway.json  # find BACnet devices on the network
npx ot-gateway check ot-gateway.json   # validate a config without connecting
npx ot-gateway watch ot-gateway.json   # print what arrives at the broker
npx ot-gateway status                  # the running gateway's devices, one line each
```

Needs Node.js 22.18 or newer. To run a gateway unattended, use the container image with Docker Compose: see [Running a gateway](https://github.com/phocal-ai/ot-gateway/blob/main/docs/operations.md).

Documentation, source and issues: https://github.com/phocal-ai/ot-gateway (MIT).
