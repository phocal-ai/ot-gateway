# Contributing to Plenum

Thanks for your interest! Plenum is early, so issues, design feedback and pull requests are all welcome.

## Setup

```bash
pnpm install
pnpm check
```

You need Node.js 22.18 or newer (24 LTS recommended) and pnpm 10.

## Ground rules

- Read [docs/VISION.md](docs/VISION.md) and [CLAUDE.md](CLAUDE.md). CLAUDE.md lists the coding rules for humans and AI assistants alike.
- Plenum is Effect-native. Please don't add runtime dependencies outside the Effect ecosystem without opening an issue first.
- Protocol code comes with tests built from spec examples or captured traffic, and a simulator where it makes sense.
- Keep pull requests focused. Explain the field scenario a change addresses if there is one.

## Commit messages

Use short, imperative subjects, such as `modbus: group adjacent registers into one read`. Prefix with the package name when a change is scoped to one package.

## Reporting device quirks

Real devices deviate from specs. If you hit one, open an issue with the device make and model, the firmware version, and a packet capture if you can. Those reports are gold.
