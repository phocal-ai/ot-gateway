# The BACnet Stack demo server (bacserv), the open-source reference
# implementation, built from a pinned release: a BACnet/IP device that is not
# ours, for scripts/interop.sh.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch bacnet-stack-1.6.1 https://github.com/bacnet-stack/bacnet-stack.git /src
WORKDIR /src
RUN make BACNET_PORT=linux server

FROM debian:bookworm-slim
COPY --from=build /src/bin/bacserv /usr/local/bin/bacserv
EXPOSE 47808/udp
ENTRYPOINT ["bacserv"]
CMD ["2002"]
