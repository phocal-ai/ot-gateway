# Install on a Raspberry Pi, from nothing

From a blank SD card to a gateway publishing to MQTT, in about 45 minutes. You need:

- a laptop (macOS, Linux or Windows) and a card reader;
- a Raspberry Pi 4 or 5 with its power supply, and an SD card of 32 GB or more;
- an Ethernet cable to the same network as the laptop;
- an MQTT broker and the devices to read, both reachable from the Pi. To try it without either, see the smoke test in [raspberry-pi-testing.md](raspberry-pi-testing.md): it runs a test broker and simulated devices on the Pi.

Nothing here needs a screen or keyboard on the Pi: you set everything up while writing the card, and log in over the network.

[operations.md](operations.md) is the reference for running the gateway once it is installed; [raspberry-pi-testing.md](raspberry-pi-testing.md) is how to test a Pi before it goes into a building.

## 1. Make an SSH key on your laptop

The Pi will let in only this key, not a password. Make one just for the Pi:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/ot_gateway -C "ot-gateway"
```

It asks for a passphrase first. One protects the key if the laptop is lost, and on macOS the Keychain remembers it, so you type it once; for a Pi on your desk you can leave it empty. On Windows, run `mkdir $HOME\.ssh` and the same `ssh-keygen` in PowerShell, with `$HOME\.ssh\ot_gateway` as the path.

Copy the public half, the one line in `~/.ssh/ot_gateway.pub`, to the clipboard. You paste it into the Imager in a moment.

```bash
pbcopy < ~/.ssh/ot_gateway.pub      # macOS
cat ~/.ssh/ot_gateway.pub           # Linux and Windows: select and copy the line
```

## 2. Write the SD card

Install [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (version 2.0 or later), put the card in the reader and open it. Writing erases the card.

1. **Device:** your Pi model.
2. **Operating system:** Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**. It has to be 64-bit: the gateway image is arm64 only and does not start on the 32-bit OS. Lite has no desktop, which a gateway does not need.
3. **Storage:** the SD card. Check the size, so you do not erase another disk.
4. **Customisation:**
   - **Hostname:** `ot-gateway` (or one name per gateway, such as `ot-gateway-b1`).
   - **Localisation:** your time zone. The keyboard layout does not matter.
   - **User:** `pi`, with a password of your own. You need the password only for `sudo` on the Pi, never to log in.
   - **Wi-Fi:** in a building, leave it empty and use Ethernet: a gateway there should not depend on Wi-Fi. For a Pi on your desk, Wi-Fi is fine; its address may change, and a dropped connection looks like a network fault in the tests.
   - **Remote access:** turn SSH on, choose **public-key authentication only**, and paste the line from step 1. It starts with `ssh-ed25519` and ends with `ot-gateway`.
   - Leave everything else at its default.
5. **Write**, wait until it has written and verified the card (about five minutes), and eject it.

## 3. First boot

Put the card in the Pi, connect Ethernet (unless you set up Wi-Fi), then power. The first boot expands the file system and restarts once; give it three minutes.

## 4. Log in

Tell SSH which key and user belong to the Pi, so that `ssh ot-gateway` is all you type from now on. Add this to `~/.ssh/config` on the laptop (create the file if there is none):

```
Host ot-gateway
  HostName ot-gateway.local
  User pi
  IdentityFile ~/.ssh/ot_gateway
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
```

`IdentitiesOnly` makes SSH offer only this key; with several keys on the laptop, it would otherwise try them all and the Pi would turn it away after a few. `UseKeychain` is for macOS only; leave that line out on Linux and Windows. Then log in:

```bash
ssh ot-gateway
```

Answer `yes` to the question about the host's fingerprint (it is asked once), and type the key's passphrase if asked.

**If `ot-gateway.local` is not found**, your network does not pass on the names the Pi announces (common with mesh Wi-Fi and some routers). Find the Pi's address in your router's list of devices. On macOS or Linux you can also look for a Raspberry Pi network card, after pinging the network so the laptop has met every device (replace `192.168.0` with your network's):

```bash
for i in $(seq 1 254); do ping -c1 -W1 192.168.0.$i >/dev/null 2>&1 & done; wait
arp -a | grep -iE 'b8:27:eb|dc:a6:32|e4:5f:0?1|d8:3a:dd|2c:cf:67|28:cd:c1'
```

and put that address in `HostName` instead. Reserve the address for the Pi in the router, so it does not change.

**If it says `Permission denied (publickey)`**, the key was not pasted completely in the Imager: write the card again.

**If it warns that the remote host identification has changed**, you wrote a new card for a Pi you logged into before. Forget the old one with `ssh-keygen -R ot-gateway.local` and log in again.

Check that the 64-bit system is running, and note how the Pi is doing before the gateway runs on it: `throttled=0x0` means no under-voltage or overheating right now, and an empty kernel log means no under-voltage since boot.

```bash
uname -m      # must print aarch64
vcgencmd get_throttled; vcgencmd measure_temp
journalctl -k -g voltage      # "Undervoltage detected!" if the power supply is too weak
```

On Raspberry Pi OS 13 (kernel 6.18 and later) the kernel clears the firmware's since-boot flags every two seconds, so `vcgencmd get_throttled` shows only the last moments; the kernel log is the record.

### Optional: let an AI assistant do the rest

An assistant such as Claude Code can run the remaining steps over SSH, but it cannot type your `sudo` password. To let it, allow your user on the Pi to use `sudo` without a password, once, from the laptop:

```bash
ssh -t ot-gateway 'echo "$USER ALL=(ALL) NOPASSWD: ALL" > /tmp/090-ot-gateway && sudo visudo -cf /tmp/090-ot-gateway && sudo install -m 440 -o root -g root /tmp/090-ot-gateway /etc/sudoers.d/ && rm /tmp/090-ot-gateway'
```

It checks the rule before putting it in place and prints `parsed OK`. From then on, whoever holds the key in `~/.ssh/ot_gateway` is root on the Pi; once Docker is installed (next step) that is true anyway, since the `docker` group can do anything root can. On a gateway that goes into a building, take it back when the install is done:

```bash
ssh -t ot-gateway 'sudo rm /etc/sudoers.d/090-ot-gateway'
```

## 5. Update and install Docker

Run these on the Pi, logged in with `ssh ot-gateway`. `sudo` asks for the password you set in the Imager. The update takes a minute or two, Docker two or three.

```bash
sudo apt update && sudo apt full-upgrade -y
```

```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"
```

Raspberry Pi OS starts the kernel with memory limits for containers turned off, so Docker would ignore the gateway's memory cap (a leak would then fill the Pi rather than restart the gateway). Turn them on, which takes a restart:

```bash
grep -q cgroup_enable=memory /boot/firmware/cmdline.txt || sudo sed -i.bak '1 s/$/ cgroup_enable=memory/' /boot/firmware/cmdline.txt
sudo reboot
```

Wait a minute, log in again (`ssh ot-gateway`), and check that `docker` now works without `sudo` and that `memory` is among the controllers:

```bash
docker --version && docker compose version
cat /sys/fs/cgroup/cgroup.controllers      # the list must include memory
```

## 6. The config and secrets

Write the config as `ot-gateway.json`: with `/setup` and an AI assistant in a clone of this repository (README, "Set it up with AI"), or by hand from [configuration.md](configuration.md) and `examples/gateway.json`. Three things matter on a Pi:

- `mqtt.url` and every device's address must be reachable from the Pi. `localhost` means the Pi itself, not your laptop.
- `buffer.path` is `/var/lib/ot-gateway/buffer.sqlite`, so the outbox outlives the container.
- `"status": {}` is there, or the status page in part 8 stays off.

Copy it to the Pi:

```bash
scp ot-gateway.json ot-gateway:
```

On the Pi, fetch the Compose file of the release you install, put the config in place, and check it with the gateway itself:

```bash
curl -fsSLO https://raw.githubusercontent.com/phocal-ai/ot-gateway/v0.6.0/packaging/compose.yaml
sudo install -d -m 755 /etc/ot-gateway && sudo install -d -o 1000 -g 1000 /var/lib/ot-gateway
sudo install -m 644 ~/ot-gateway.json /etc/ot-gateway/gateway.json
[ -e /etc/ot-gateway/gateway.env ] || sudo install -m 600 -o 1000 -g 1000 /dev/null /etc/ot-gateway/gateway.env
docker run --rm -v /etc/ot-gateway:/etc/ot-gateway:ro ghcr.io/phocal-ai/ot-gateway:v0.6.0 --check /etc/ot-gateway/gateway.json
```

The check prints `config ok` and what it will poll; anything else names the field to fix. The fourth line creates an empty file for secrets, readable only by the gateway (uid 1000 in the container, which is `pi` on the Pi, so `ls` shows `pi` as the owner), and leaves an existing one alone. If the config names a broker password or other secrets (`/setup` puts them in `ot-gateway.env`), add those lines:

```bash
sudo nano /etc/ot-gateway/gateway.env
```

## 7. Start it

```bash
docker compose -f compose.yaml up -d
```

This `compose.yaml` in your home folder is the one [operations.md](operations.md) calls `packaging/compose.yaml`: run its upgrade and log commands from your home folder, with `compose.yaml`.

The first start downloads the image, about a minute on Wi-Fi. The Compose file pins the release, restarts the gateway after a crash and at boot, caps its memory at 768 MB and keeps Docker's logs from filling the SD card. If Compose says `Your kernel does not support memory limit capabilities`, the memory step in part 5 is missing: do it, then recreate the container with `docker compose -f compose.yaml up -d --force-recreate`.

After half a minute, the log should say it connected to the broker and found the devices, without warnings:

```bash
docker logs ot-gateway --tail 30
```

After a restart of the Pi you may see one expected warning, `wall clock stepped`: the Pi has no battery-backed clock, and the time jumps when it is set from the network a few seconds after boot. The gateway's deadlines do not jump with it.

## 8. Check it

The status page listens only on the Pi itself. Reach it through SSH from the laptop:

```bash
ssh -L 8080:127.0.0.1:8080 ot-gateway
```

and open <http://127.0.0.1:8080>. Every device should be `ok`, and the **Host** card should show the version you installed, a temperature and no conditions. The same, as JSON, from the Pi:

```bash
curl -s http://127.0.0.1:8080/api/status
```

On a test Pi with a few devices, expect about 130 MB of memory, a few percent of CPU and an event-loop lag (p99) of a few milliseconds once the first minute is over.

On Raspberry Pi OS 13 (kernel 6.18 and later) the Pi lets the gateway see under-voltage (even a dip of a second), but not a capped frequency, throttling or the soft temperature limit, and nothing from before the gateway started. The Host card says `power: under-voltage only`. The gateway still warns when the SoC gets hot (80 °C), and on the Pi `vcgencmd get_throttled` shows the rest.

From here on, [operations.md](operations.md) covers upgrades, logs and the outbox, and [raspberry-pi-testing.md](raspberry-pi-testing.md) the tests before a Pi goes into a building.
