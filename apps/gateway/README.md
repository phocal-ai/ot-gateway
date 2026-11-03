# @plenum/gateway

The ready-to-run Plenum gateway.

- `pnpm gateway` from the repo root runs it with `examples/gateway.json`
- Or: `apps/gateway/src/main.ts path/to/config.json`, or `node --max-semi-space-size=4 apps/gateway/src/main.ts path/to/config.json`

Keep `--max-semi-space-size=4` (the script's shebang and `pnpm gateway` pass it): V8's default young generation makes the gateway reserve about 40 MB more memory, which a Raspberry Pi can use better, and the smaller one costs no measurable CPU at the gateway's allocation rate. Measured with every device polled every 100 ms: about 174 MB resident without it, 132 MB with it.

Part of [Plenum](../../README.md).
