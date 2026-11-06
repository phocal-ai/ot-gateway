#!/bin/sh
# Installs the `ot-gateway` binary from a GitHub release (scripts/build-binary.sh
# builds it): the gateway, its status page and its CLI in one file, Node inside.
#
#   curl -fsSL https://raw.githubusercontent.com/phocal-ai/ot-gateway/main/packaging/get.sh | sh
#
# For Linux on arm64 (Raspberry Pi 4 and 5 with a 64-bit OS) or x64, and macOS on
# Apple silicon. Without root it goes to ~/.local/bin, as root to /usr/local/bin.
# It needs no sudo, git or Node, and changes nothing but that one file.
#
#   OT_GATEWAY_VERSION=v0.8.0    a release tag (default: the latest release)
#   OT_GATEWAY_INSTALL_DIR=DIR   where the binary goes
#   OT_GATEWAY_DOWNLOAD_URL=URL  where the release files are (a mirror, or a test)
#
# The download is checked against the release's SHA256SUMS before it is installed.
set -eu

repository=https://github.com/phocal-ai/ot-gateway

fail() {
  echo "ot-gateway: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no binary for $(uname -s); see $repository#running-it-for-real for the container image" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  armv7l | armv6l) fail "a 32-bit ARM OS is not supported; install the 64-bit Raspberry Pi OS" ;;
  *) fail "no binary for the CPU $(uname -m)" ;;
esac
target="$os-$arch"
[ "$target" = darwin-x64 ] && fail "no binary for Intel Macs; use the container image"

if [ -n "${OT_GATEWAY_DOWNLOAD_URL:-}" ]; then
  base=$OT_GATEWAY_DOWNLOAD_URL
elif [ -n "${OT_GATEWAY_VERSION:-}" ]; then
  base="$repository/releases/download/$OT_GATEWAY_VERSION"
else
  base="$repository/releases/latest/download"
fi

if [ -n "${OT_GATEWAY_INSTALL_DIR:-}" ]; then
  dir=$OT_GATEWAY_INSTALL_DIR
elif [ "$(id -u)" = 0 ]; then
  dir=/usr/local/bin
else
  dir="$HOME/.local/bin"
fi

command -v curl >/dev/null || fail "needs curl"
command -v tar >/dev/null || fail "needs tar"
if command -v sha256sum >/dev/null; then
  sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null; then
  sha256() { shasum -a 256 "$@"; }
else
  fail "needs sha256sum or shasum to check the download"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

archive="ot-gateway-$target.tar.gz"
echo "Downloading $archive from $base"
curl -fsSL --retry 3 -o "$work/$archive" "$base/$archive" || fail "could not download $base/$archive"
curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
grep " $archive\$" "$work/SHA256SUMS" >"$work/expected" || fail "SHA256SUMS has no line for $archive"
(cd "$work" && sha256 -c expected >/dev/null 2>&1) || fail "$archive does not match its checksum; nothing was installed"
tar -xzf "$work/$archive" -C "$work"

mkdir -p "$dir"
# Through a temporary name in the same folder, so a running gateway keeps its old file and nobody sees half of one.
install_tmp="$dir/.ot-gateway.$$"
cp "$work/ot-gateway" "$install_tmp"
chmod 755 "$install_tmp"
mv -f "$install_tmp" "$dir/ot-gateway"

if ! version=$("$dir/ot-gateway" --version 2>"$work/error"); then
  cat "$work/error" >&2
  if grep -q libatomic "$work/error"; then
    fail "installed to $dir/ot-gateway, but it needs libatomic1: sudo apt-get install libatomic1"
  fi
  fail "installed to $dir/ot-gateway, but it does not start"
fi
echo "Installed $version to $dir/ot-gateway"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH; add it, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
echo "Next: ot-gateway demo, to see it work without devices (the status page is on http://127.0.0.1:8080)"
