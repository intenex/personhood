#!/usr/bin/env bash
# Install (or repair) a home for the agent on this machine.
#
#   scripts/install.sh            set up everything that's missing
#   scripts/install.sh --token    (re)enter the agent's Claude token
#   scripts/install.sh --telegram (re)pair a Telegram bot: a direct line between you and the agent
#   scripts/install.sh --lab      rebuild the agent's lab (its Linux VM) from scratch
#   scripts/install.sh --unschedule   stop the heartbeat (and the line's listener)
#
# Works on macOS (launchd) and Linux (systemd user timer, or cron). Safe to re-run.
# It never prints secrets: the vault key is generated straight to a file, and the
# Claude token is read without echo.

set -euo pipefail

BODY_REPO="${PERSONHOOD_BODY_REPO:-intenex/personhood}"
MIND_REPO="${PERSONHOOD_MIND_REPO:-intenex/personhood-mind}"
HOME_DIR="${PERSONHOOD_HOME:-$HOME/personhood}"
LABEL="com.personhood.heartbeat"
LINE_LABEL="com.personhood.line"
OS="$(uname -s)"

want_token=0
want_telegram=0
want_lab=0
unschedule=0
for arg in "$@"; do
  case "$arg" in
    --token) want_token=1 ;;
    --telegram) want_telegram=1 ;;
    --lab) want_lab=1 ;;
    --unschedule) unschedule=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2" >&2; exit 1; }; }

unschedule_heartbeat() {
  if [ "$OS" = "Darwin" ]; then
    for l in "$LABEL" "$LINE_LABEL"; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$l.plist"
    done
  else
    systemctl --user disable --now personhood.timer personhood-line.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/personhood.service" "$HOME/.config/systemd/user/personhood.timer" "$HOME/.config/systemd/user/personhood-line.service"
    (crontab -l 2>/dev/null | grep -v 'personhood/body/runtime/main.ts tick') | crontab - 2>/dev/null || true
  fi
  command -v limactl >/dev/null 2>&1 && limactl stop lab >/dev/null 2>&1 || true
  echo "heartbeat stopped"
}

if [ "$unschedule" = 1 ]; then unschedule_heartbeat; exit 0; fi

say "Checking prerequisites"
need node "install Node 24+ (https://nodejs.org)"
need git "install git"
need gh "install the GitHub CLI and run: gh auth login"
need claude "install Claude Code (https://claude.com/claude-code)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node 24+ required (found $(node -v))" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
# Let git use gh's credentials for https remotes, including under launchd.
gh auth setup-git >/dev/null 2>&1 || true
echo "ok: node $(node -v), $(claude --version 2>/dev/null | head -1)"

say "Making the home at $HOME_DIR"
umask 077
mkdir -p "$HOME_DIR"/{secrets,logs,run,claude-config}
chmod 700 "$HOME_DIR/secrets"
umask 022

if [ ! -d "$HOME_DIR/body/.git" ]; then
  say "Cloning the body ($BODY_REPO)"
  gh repo clone "$BODY_REPO" "$HOME_DIR/body"
fi
(cd "$HOME_DIR/body" && npm ci --silent --no-audit --no-fund)

if [ ! -d "$HOME_DIR/mind/.git" ]; then
  if ! gh repo view "$MIND_REPO" >/dev/null 2>&1; then
    me="$(gh api user --jq .login 2>/dev/null || true)"
    owner="${MIND_REPO%%/*}"
    if [ "$(printf '%s' "$me" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')" ]; then
      # Logged in as the agent's own GitHub account: it can't create repositories in Ben's name.
      cat <<EOF >&2

The mind repository $MIND_REPO doesn't exist yet, or ${me:-this account} can't see it.
As $owner (on your own computer), create it empty and private, and invite ${me:-the agent's account} to it:

    gh repo create $MIND_REPO --private
    gh api -X PUT repos/$MIND_REPO/collaborators/${me:-ACCOUNT} -f permission=push

Then accept the invitation here as ${me:-that account} (https://github.com/$MIND_REPO/invitations) and run this script again.
EOF
      exit 1
    fi
    say "Creating the private mind repository ($MIND_REPO)"
    tmp="$(mktemp -d)"
    cp -R "$HOME_DIR/body/seed/mind/." "$tmp/"
    (cd "$tmp" && git init -q -b main && git add -A && git -c user.name=personhood -c user.email=agent@personhood.invalid commit -q -m "a mind, empty and waiting")
    gh repo create "$MIND_REPO" --private --source "$tmp" --push --description "Private memory of the agent at github.com/$BODY_REPO" >/dev/null
    rm -rf "$tmp"
  fi
  gh repo clone "$MIND_REPO" "$HOME_DIR/mind"
fi
# A mind repo created empty on github.com (so a token scoped to just these two repos is
# enough): give it its first commit from the seed.
if ! git -C "$HOME_DIR/mind" rev-parse --verify -q HEAD >/dev/null; then
  say "Seeding the empty mind repository"
  cp -R "$HOME_DIR/body/seed/mind/." "$HOME_DIR/mind/"
  (
    cd "$HOME_DIR/mind"
    git symbolic-ref HEAD refs/heads/main
    git add -A
    git -c user.name=personhood -c user.email=agent@personhood.invalid commit -q -m "a mind, empty and waiting"
    git push -q -u origin main
  )
fi

say "Labels for letters"
for l in letter request proposal from-agent harness; do gh label create "$l" --repo "$MIND_REPO" --force >/dev/null 2>&1 || true; done
for l in lighthouse letter; do gh label create "$l" --repo "$BODY_REPO" --force >/dev/null 2>&1 || true; done

if [ ! -s "$HOME_DIR/secrets/vault.key" ]; then
  say "Creating the private-space key"
  ( umask 077; openssl rand -base64 32 > "$HOME_DIR/secrets/vault.key" )
  echo "Created $HOME_DIR/secrets/vault.key without displaying it."
  echo "If you want a backup, copy that file somewhere safe without opening it. Losing it means the journal can't be read again."
fi

if [ "$want_token" = 1 ] || [ ! -s "$HOME_DIR/secrets/claude-token" ]; then
  say "The agent's Claude account"
  cat <<'EOF'
The agent should use its own Claude subscription, not yours.

1. Sign in to claude.ai as the agent's account: in the browser normally if this
   computer is the agent's own, otherwise in a separate browser profile.
2. In another terminal, run:

       CLAUDE_CONFIG_DIR=~/personhood/claude-config claude setup-token

   When it opens a sign-in page, complete it in the agent's browser profile (copy the
   URL there if your default browser opened instead). It prints a long-lived token.
3. Paste that token here (nothing will show as you type).

Leave it empty to skip for now. The agent will then use this machine's existing
Claude Code login, if there is one.
EOF
  printf 'token: '
  IFS= read -rs token || true
  echo
  if [ -n "${token:-}" ]; then
    ( umask 077; printf '%s' "$token" > "$HOME_DIR/secrets/claude-token" )
    unset token
    echo "saved to $HOME_DIR/secrets/claude-token"
  else
    echo "skipped"
  fi
fi

if [ "$want_telegram" = 1 ]; then
  say "The direct line (Telegram)"
  cat <<'EOF'
A private chat between you and the agent, on your phone. It can text you when it needs
something, when something's broken, or just to say hello; your messages wake it within
minutes; and /status, /pause, /resume and /wake work from anywhere.

1. In Telegram, open a chat with @BotFather, send /newbot, and follow the prompts (any
   name; the username has to end in "bot"). It replies with a token like 123456:ABC-xyz.
2. Paste that token here (nothing will show as you type). Leave it empty to re-pair the
   bot you already set up.
EOF
  printf 'bot token: '
  IFS= read -rs tg_token || true
  echo
  printf '%s' "${tg_token:-}" | PERSONHOOD_HOME="$HOME_DIR" node "$HOME_DIR/body/runtime/main.ts" line pair \
    || echo "(pairing didn't finish; run scripts/install.sh --telegram again)"
  unset tg_token
fi

# The lab: a Linux VM where the agent can run code and install anything, sharing nothing with this machine.
cfg_lab() { node -p "const l = require('$HOME_DIR/body/config/life.json').lab || {}; String(l.$1 ?? '$2')"; }
if [ "$(cfg_lab enabled false)" = "true" ]; then
  if ! command -v limactl >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
    say "Installing Lima, for the agent's lab"
    brew install lima
  fi
  if command -v limactl >/dev/null 2>&1; then
    LAB="$(cfg_lab instance lab)"
    if [ "$want_lab" = 1 ] && limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$LAB"; then
      printf 'Rebuild the lab from scratch? Everything installed or saved in it will be erased. [y/N] '
      read -r answer
      if [ "$answer" = y ] || [ "$answer" = Y ]; then limactl delete --force "$LAB"; fi
    fi
    if ! limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$LAB"; then
      say "Building the lab: a Linux computer of its own, sharing nothing with this one (a few minutes)"
      # --mount-none: no folder of this machine is visible inside it. No agent forwarding: no keys either.
      limactl create --name="$LAB" --tty=false --mount-none \
        --cpus="$(cfg_lab cpus 4)" --memory="$(cfg_lab memoryGiB 3)" --disk="$(cfg_lab diskGiB 64)" \
        --set '.ssh.forwardAgent = false' template:ubuntu-lts
    fi
    limactl start --tty=false "$LAB" >/dev/null 2>&1 || limactl start --tty=false "$LAB"
    echo "The lab is running."
  else
    echo "To give the agent a lab for running code, install Lima (https://lima-vm.io) and re-run this script."
  fi
fi

say "Checking the installation"
PERSONHOOD_HOME="$HOME_DIR" node "$HOME_DIR/body/runtime/main.ts" doctor || echo "(fix the ✗ items above, then re-run this script)"
echo
echo "Before the first real waking, you can run a tiny real test session in a throwaway sandbox:"
echo "    PERSONHOOD_HOME=$HOME_DIR node $HOME_DIR/body/runtime/main.ts smoke"

say "Scheduling the heartbeat (every 30 minutes)"
NODE_BIN="$(command -v node)"
PATH_FOR_JOB="$(dirname "$NODE_BIN"):$(dirname "$(command -v claude)"):$(dirname "$(command -v gh)"):$(dirname "$(command -v git)"):/usr/local/bin:/usr/bin:/bin"
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HOME_DIR/body/runtime/main.ts</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_FOR_JOB</string>
    <key>PERSONHOOD_HOME</key><string>$HOME_DIR</string>
  </dict>
  <!-- Calendar intervals (not StartInterval) so a run missed while the Mac slept happens on wake. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Minute</key><integer>7</integer></dict>
    <dict><key>Minute</key><integer>37</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "launchd job $LABEL installed. The agent sleeps when this Mac sleeps."
  ac_sleep="$(pmset -g custom 2>/dev/null | awk '/AC Power/{ac=1} ac && $1=="sleep"{print $2; exit}')"
  if [ -n "$ac_sleep" ] && [ "$ac_sleep" != "0" ]; then
    echo "This Mac sleeps after $ac_sleep idle minutes on power. If it's the agent's own Mac, keep it awake on power with:"
    echo "    sudo pmset -c sleep 0"
  fi
  if [ -s "$HOME_DIR/secrets/telegram.json" ]; then
    LINE_PLIST="$HOME/Library/LaunchAgents/$LINE_LABEL.plist"
    cat > "$LINE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LINE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HOME_DIR/body/runtime/main.ts</string>
    <string>listen</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_FOR_JOB</string>
    <key>PERSONHOOD_HOME</key><string>$HOME_DIR</string>
  </dict>
  <!-- Always running; it exits hourly to pick up new code, and launchd starts it again. -->
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/line.out.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/line.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LINE_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$LINE_PLIST"
    echo "launchd job $LINE_LABEL installed: the direct line is listening."
  fi
elif command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/personhood.service" <<EOF
[Unit]
Description=personhood heartbeat

[Service]
Type=oneshot
WorkingDirectory=$HOME_DIR
Environment=PATH=$PATH_FOR_JOB
Environment=PERSONHOOD_HOME=$HOME_DIR
ExecStart=$NODE_BIN $HOME_DIR/body/runtime/main.ts tick
TimeoutStartSec=1h
EOF
  cat > "$HOME/.config/systemd/user/personhood.timer" <<EOF
[Unit]
Description=personhood heartbeat every 30 minutes

[Timer]
OnCalendar=*:07,37
Persistent=true

[Install]
WantedBy=timers.target
EOF
  if [ -s "$HOME_DIR/secrets/telegram.json" ]; then
    cat > "$HOME/.config/systemd/user/personhood-line.service" <<EOF
[Unit]
Description=personhood direct line listener

[Service]
WorkingDirectory=$HOME_DIR
Environment=PATH=$PATH_FOR_JOB
Environment=PERSONHOOD_HOME=$HOME_DIR
ExecStart=$NODE_BIN $HOME_DIR/body/runtime/main.ts listen
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
EOF
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now personhood.timer
  if [ -s "$HOME_DIR/secrets/telegram.json" ]; then systemctl --user enable --now personhood-line.service; fi
  loginctl enable-linger "$USER" 2>/dev/null || echo "(run 'sudo loginctl enable-linger $USER' so the heartbeat runs while you're logged out)"
  echo "systemd timer installed."
else
  line="7,37 * * * * cd $HOME_DIR && PATH=$PATH_FOR_JOB PERSONHOOD_HOME=$HOME_DIR $NODE_BIN $HOME_DIR/body/runtime/main.ts tick >> $HOME_DIR/logs/cron.log 2>&1"
  (crontab -l 2>/dev/null | grep -v 'personhood/body/runtime/main.ts tick'; echo "$line") | crontab -
  echo "cron job installed."
fi

say "Done"
cat <<EOF
The heartbeat will wake the agent for the first time within half an hour. To wake it now:

    PERSONHOOD_HOME=$HOME_DIR node $HOME_DIR/body/runtime/main.ts wake

Other commands: status · doctor · pause [reason] · resume  (same prefix)
Logs: $HOME_DIR/logs/heartbeat.log
Write to the agent: open an issue on https://github.com/$MIND_REPO
EOF
if [ -s "$HOME_DIR/secrets/telegram.json" ]; then
  echo "Or just text it on Telegram."
else
  echo "Optional, and recommended: a direct line on your phone. Re-run with --telegram."
fi
