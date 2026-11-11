# The OT Gateway as a container image, for amd64 and arm64 (Raspberry Pi
# 4 and 5 with a 64-bit OS).
#
#   docker build -t ot-gateway .
#   docker run -d --name ot-gateway --network host --restart unless-stopped \
#     -v /etc/ot-gateway:/etc/ot-gateway:ro -v /var/lib/ot-gateway:/var/lib/ot-gateway \
#     ot-gateway
#
# The config is /etc/ot-gateway/gateway.json; point `buffer.path` under
# /var/lib/ot-gateway so the outbox survives the container. Host networking lets
# BACnet discovery hear broadcast I-Ams. The entrypoint is the bundle the npm
# package ships too (scripts/bundle.sh): one file, so it starts about three times
# faster than the sources on a Raspberry Pi and takes less memory. The image
# keeps the TypeScript sources and the workspace layout as well, for the bench
# and the soak, which Node runs directly (it does not strip types under
# node_modules, and workspace packages are symlinks out of it). The bundle and
# the status page (apps/web, a static export) are built once on the build host
# and copied in.
#
# To see it work without a config, broker or devices:
#
#   docker run --rm -it -p 127.0.0.1:8080:8080 ghcr.io/phocal-ai/ot-gateway demo
ARG NODE_VERSION=24

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /opt/ot-gateway
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ot-gateway/web..."
COPY tsconfig.base.json ./
COPY packages/api packages/api
COPY apps/web apps/web
RUN pnpm --filter @ot-gateway/web build

# The bundle is JavaScript, the same on every platform: build it once, natively, not under QEMU.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS bundle
WORKDIR /opt/ot-gateway
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/simulator/package.json packages/simulator/
COPY packages/modbus/package.json packages/modbus/
COPY packages/mqtt/package.json packages/mqtt/
COPY packages/bacnet/package.json packages/bacnet/
COPY packages/buffer/package.json packages/buffer/
COPY packages/history/package.json packages/history/
# With dev dependencies, for esbuild; this stage is thrown away.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ot-gateway/gateway..."
COPY packages packages
COPY apps/gateway/src apps/gateway/src
COPY scripts/bundle.sh scripts/bundle.sh
RUN scripts/bundle.sh /opt/ot-gateway/main.mjs

FROM node:${NODE_VERSION}-bookworm-slim AS install
WORKDIR /opt/ot-gateway
RUN corepack enable
# No .npmrc: a developer's registry token would ship in the image (the final stage copies this one whole).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/simulator/package.json packages/simulator/
COPY packages/modbus/package.json packages/modbus/
COPY packages/mqtt/package.json packages/mqtt/
COPY packages/bacnet/package.json packages/bacnet/
COPY packages/buffer/package.json packages/buffer/
COPY packages/history/package.json packages/history/
# Runtime dependencies of the gateway and the packages it uses; no dev tools, no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@ot-gateway/gateway..."

FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /opt/ot-gateway
COPY --from=install /opt/ot-gateway ./
COPY packages packages
COPY apps/gateway/src apps/gateway/src
COPY apps/gateway/package.json apps/gateway/
COPY --from=bundle /opt/ot-gateway/main.mjs apps/gateway/src/main.mjs
COPY --from=web /opt/ot-gateway/apps/web/out apps/web/out
COPY examples examples
# The device profiles a points list names (`ot-gateway profiles list`).
COPY profiles profiles
# What `ot-gateway init` writes next to ot-gateway.json when it runs in the container.
COPY packaging/compose.yaml packaging/compose.yaml
COPY scripts/soak.sh scripts/soak.sh
# The build, for telemetry and the status page: the release tag when the image is published.
ARG OT_GATEWAY_VERSION=dev
LABEL org.opencontainers.image.title="OT Gateway" \
      org.opencontainers.image.source="https://github.com/phocal-ai/ot-gateway" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$OT_GATEWAY_VERSION"
RUN mkdir -p /etc/ot-gateway /var/lib/ot-gateway /opt/ot-gateway/compile-cache \
  && chown node:node /var/lib/ot-gateway /opt/ot-gateway/compile-cache && echo "$OT_GATEWAY_VERSION" > VERSION
USER node
# V8's compiled code for the bundle, made here on the target platform by one config check: Node starts the CLI
# in 0.65 s instead of 0.87 s on a Pi 4 (a command takes about 1.3 s with Docker's own). Node keys it by user id,
# so it serves the image's user (1000), and the `ot-gateway` command run as the first user of a Pi (also 1000).
ENV NODE_COMPILE_CACHE=/opt/ot-gateway/compile-cache
RUN node --max-semi-space-size=4 /opt/ot-gateway/apps/gateway/src/main.mjs --check examples/gateway.json >/dev/null
ENV NODE_ENV=production
# `demo` serves its status page on every interface of the container, so `-p 127.0.0.1:8080:8080` reaches it.
ENV OT_GATEWAY_DEMO_LISTEN=0.0.0.0
# The env file of the layout before the folder, read by the CLI when it is there and passed over in silence when
# not (Node's --env-file-if-exists said so on every command). Compose passes ot-gateway.env as env_file.
ENV OT_GATEWAY_ENV_FILE=/etc/ot-gateway/gateway.env
# Relative paths in the config (`./ot-gateway-buffer.sqlite`, as init writes them) resolve here, in the data volume,
# and not in the config's folder (compose.yaml mounts the gateway's folder at /etc/ot-gateway). The Docker wrapper
# (packaging/ot-gateway) clears it, so a command run in a folder keeps them in that folder.
ENV OT_GATEWAY_DATA_DIR=/var/lib/ot-gateway
# A smaller young generation than V8's default: about 40 MB less resident, no measurable CPU cost.
# An absolute path, so a container may run from another working directory (compose.yaml uses the data volume).
ENTRYPOINT ["node", "--max-semi-space-size=4", "/opt/ot-gateway/apps/gateway/src/main.mjs"]
# The layout before compose.yaml mounted the folder (and named /etc/ot-gateway/ot-gateway.json): the file alone.
CMD ["/etc/ot-gateway/gateway.json"]
