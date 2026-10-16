#!/usr/bin/env bash
# Runs inside the lab (as root, via `sudo bash -s`): give it a screen. A virtual display (Xvfb :1,
# 1280x800) with a small window manager (openbox), Chromium, and the tools the harness's `screen`
# life tool uses to look and act (ImageMagick's import, xdotool). It runs as a system service
# owned by the lab's login user, so it comes back whenever the VM starts. Safe to re-run.
#
# install.sh --lab runs it; by hand:
#   ssh -F ~/.lima/lab/ssh.config lima-lab 'sudo -n bash -s' < scripts/lab-screen-setup.sh

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LAB_USER="${SUDO_USER:-$(id -un 1000)}"
[ "$LAB_USER" != root ] || { echo "run it through sudo from the lab's login user" >&2; exit 1; }

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xvfb x11-utils x11-xserver-utils xdotool imagemagick openbox xterm \
  fonts-dejavu fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji dbus-x11 >/dev/null
snap list chromium >/dev/null 2>&1 || snap install chromium >/dev/null

cat > /usr/local/bin/lab-screen <<'EOF'
#!/bin/bash
# The lab's screen: a virtual display on :1 and a window manager on it (restarted if it exits).
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp -dpi 96 &
x=$!
for _ in $(seq 100); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
export DISPLAY=:1
xsetroot -solid '#2e3440' || true
( while kill -0 "$x" 2>/dev/null; do openbox; sleep 1; done ) &
wait "$x"
EOF
chmod 755 /usr/local/bin/lab-screen

cat > /usr/local/bin/browser <<'EOF'
#!/bin/bash
# Open Chromium on the lab's screen, detached: browser [url ...]
export DISPLAY="${DISPLAY:-:1}"
nohup chromium --no-first-run --no-default-browser-check --password-store=basic --window-position=0,0 --window-size=1280,800 "$@" >/tmp/browser.log 2>&1 &
echo "Chromium is opening on the screen (log: /tmp/browser.log)"
EOF
chmod 755 /usr/local/bin/browser

# Every login shell (and so every `run` command) draws on that screen by default.
echo 'export DISPLAY="${DISPLAY:-:1}"' > /etc/profile.d/lab-screen.sh

cat > /etc/systemd/system/lab-screen.service <<EOF
[Unit]
Description=The lab's screen (a virtual display for GUI apps)
After=network.target

[Service]
User=$LAB_USER
ExecStart=/usr/local/bin/lab-screen
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now lab-screen.service >/dev/null 2>&1
for _ in $(seq 50); do sudo -u "$LAB_USER" DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
sudo -u "$LAB_USER" DISPLAY=:1 xdpyinfo | grep -q 'dimensions:.*1280x800' && echo screen-ready
