---
name: Bug report
about: Something ot-gateway does wrong. An agent writes this for you with `ot-gateway report draft`
---

<!--
An issue here is public: no site or customer names, no IP addresses, no passwords.
`ot-gateway report draft` writes this text with them replaced by placeholders, and `ot-gateway report send`
opens this form filled in. By hand, keep the headings: people and agents triage by them.
-->

- Command: `ot-gateway …`
- Code: the code the command printed, if it printed one
- Error: the error's message, one line

## What happened

The lines of output that show the failure.

## Expected

## Steps to reproduce

The commands that lead to it, in order. Against the simulator (`ot-gateway demo`, `ot-gateway simulate bacnet`) when it shows there too.

## Ruled out

What you checked and is not the cause: wiring, addresses, the config, an older release.

## Device

- Protocol: modbus-tcp or bacnet-ip
- Vendor and model, firmware:

## Versions and host

- ot-gateway:
- Node:
- OS:
