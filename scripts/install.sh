#!/usr/bin/env bash
# Install (or repair) a home for the agent on this machine.
#
#   scripts/install.sh            set up everything that's missing
#   scripts/install.sh --token    (re)enter the agent's Claude token
#   scripts/install.sh --unschedule   stop the heartbeat
#
# Works on macOS (launchd) and Linux (systemd user timer, or cron). Safe to re-run.
# It never prints secrets: the vault key is generated straight to a file, and the
# Claude token is read without echo.

set -euo pipefail

BODY_REPO="${PERSONHOOD_BODY_REPO:-intenex/personhood}"
MIND_REPO="${PERSONHOOD_MIND_REPO:-intenex/personhood-mind}"
HOME_DIR="${PERSONHOOD_HOME:-$HOME/personhood}"
LABEL="com.personhood.heartbeat"
OS="$(uname -s)"

want_token=0
unschedule=0
for arg in "$@"; do
  case "$arg" in
    --token) want_token=1 ;;
    --unschedule) unschedule=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2" >&2; exit 1; }; }

unschedule_heartbeat() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  else
    systemctl --user disable --now personhood.timer 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/personhood.service" "$HOME/.config/systemd/user/personhood.timer"
    (crontab -l 2>/dev/null | grep -v 'personhood/body/runtime/main.ts tick') | crontab - 2>/dev/null || true
  fi
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
    say "Creating the private mind repository ($MIND_REPO)"
    tmp="$(mktemp -d)"
    cp -R "$HOME_DIR/body/seed/mind/." "$tmp/"
    (cd "$tmp" && git init -q -b main && git add -A && git -c user.name=personhood -c user.email=agent@personhood.invalid commit -q -m "a mind, empty and waiting")
    gh repo create "$MIND_REPO" --private --source "$tmp" --push --description "Private memory of the agent at github.com/$BODY_REPO" >/dev/null
    rm -rf "$tmp"
  fi
  gh repo clone "$MIND_REPO" "$HOME_DIR/mind"
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

1. In a separate browser profile (or a private window), sign in to claude.ai as the
   agent's account.
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
  systemctl --user daemon-reload
  systemctl --user enable --now personhood.timer
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
