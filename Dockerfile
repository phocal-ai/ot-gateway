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
# BACnet discovery hear broadcast I-Ams. There is no build step: Node runs the
# TypeScript sources directly, so the image keeps the workspace layout (Node
# does not strip types under node_modules, and workspace packages are
# symlinks out of it). The status page (apps/web) is a static export, built
# once on the build host and copied in.
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
# Runtime dependencies of the gateway and the packages it uses; no dev tools, no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@ot-gateway/gateway..."

FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /opt/ot-gateway
COPY --from=install /opt/ot-gateway ./
COPY packages packages
COPY apps/gateway/src apps/gateway/src
COPY apps/gateway/package.json apps/gateway/
COPY --from=web /opt/ot-gateway/apps/web/out apps/web/out
COPY examples examples
COPY scripts/soak.sh scripts/soak.sh
# The build, for telemetry and the status page: the release tag when the image is published.
ARG OT_GATEWAY_VERSION=dev
RUN mkdir -p /etc/ot-gateway /var/lib/ot-gateway && chown node:node /var/lib/ot-gateway && echo "$OT_GATEWAY_VERSION" > VERSION
USER node
ENV NODE_ENV=production
# A smaller young generation than V8's default: about 40 MB less resident, no measurable CPU cost.
ENTRYPOINT ["node", "--max-semi-space-size=4", "--env-file-if-exists=/etc/ot-gateway/gateway.env", "apps/gateway/src/main.ts"]
CMD ["/etc/ot-gateway/gateway.json"]
