#!/usr/bin/env bash
# Move the agent to another Mac, whole: its home (~/personhood: secrets, mind, body, the line,
# the logs), its GitHub login, its Linux lab (the VM, with everything in it) and, if its Mac shell
# is on, that shell's home (/Users/wick). Everything travels in one encrypted disk image, so
# nothing secret is ever lying around in the clear.
#
# On the old Mac (from the account the heartbeat runs under):
#   ~/personhood/body/scripts/move.sh out /Volumes/<drive>/wick-move.sparseimage
# It pauses the agent, stops its heartbeat, line and lab here, makes sure its mind and body are
# pushed, and packs everything into the image (it asks you for a password for it).
#
# On the new Mac (Apple Silicon, from an account named the same, `claude`; it can be a standard
# account if Node, gh and Lima are already installed through Homebrew from an admin account, and
# then setting up the Mac shell asks you to run one command from that admin account):
#   curl -fsSL https://raw.githubusercontent.com/intenex/personhood/main/scripts/move.sh -o ~/move.sh
#   bash ~/move.sh in /Volumes/<drive>/wick-move.sparseimage
# It installs what's missing (Claude Code, and Homebrew, Node, gh and Lima if it can), unpacks
# everything, runs install.sh (and mac-shell.sh if the Mac shell is on), checks it all with
# doctor, and offers to resume the agent.
#
# The old Mac is left paused and stopped, with its files untouched, until you erase it.
# See docs/moving.md.

set -euo pipefail

MODE="${1:-}"
IMAGE="${2:-}"
HOME_DIR="${PERSONHOOD_HOME:-$HOME/personhood}"
LIMA_DIR="${LIMA_HOME:-$HOME/.lima}"
MAC_USER="${PERSONHOOD_MAC_USER:-wick}"
TEST="${PERSONHOOD_MOVE_TEST:-}" # tests only: skip everything with side effects outside $HOME
FORCE="${PERSONHOOD_MOVE_FORCE:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }
ask() { local a; printf '%s [y/N] ' "$1"; read -r a </dev/tty; [ "$a" = y ] || [ "$a" = Y ]; }
mainjs() { node "$HOME_DIR/body/runtime/main.ts" "$@"; }
# Is the Mac shell turned on in the agent's config?
mac_shell_on() { [ "$(node -p "(require('$HOME_DIR/body/config/life.json').mac || {}).enabled === true" 2>/dev/null)" = true ]; }

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
[ "$MODE" = out ] || [ "$MODE" = in ] || usage
[ -n "$IMAGE" ] || usage
[ "$(uname -s)" = Darwin ] || die "this is for macOS"
[ "$(id -u)" != 0 ] || die "run it as the agent's account (claude), not with sudo; it asks for sudo when it needs it"
cd /

# hdiutil asks for the image's password itself; tests pass it on stdin instead.
hdi() {
  if [ -n "${PERSONHOOD_MOVE_PASSWORD:-}" ]; then printf '%s\0' "$PERSONHOOD_MOVE_PASSWORD" | hdiutil "$@" -stdinpass
  else hdiutil "$@"; fi
}

MNT=""
detach() { [ -n "$MNT" ] && hdiutil detach -quiet "$MNT" 2>/dev/null || true; }
trap detach EXIT

attach() {
  # Ownership off: the files belong to whoever opens the image. The new Mac's `claude` account
  # often has a different number than the old one's (an account made before it takes 501), and
  # then owner-only files in the image, like the GitHub token, would be unreadable.
  MNT="$(mktemp -d "${TMPDIR:-/tmp}/wick-move.XXXXXX")"
  hdi attach -quiet -nobrowse -owners off -mountpoint "$MNT" "$IMAGE" || die "couldn't open $IMAGE (wrong password?)"
}

# ---------------------------------------------------------------- out
move_out() {
  [ -s "$HOME_DIR/secrets/vault.key" ] || die "no agent home at $HOME_DIR"
  [ ! -e "$IMAGE" ] || die "$IMAGE already exists; pick a new name or remove it"
  local dir; dir="$(dirname "$IMAGE")"
  [ -d "$dir" ] && [ -w "$dir" ] || die "can't write to $dir"
  case "$IMAGE" in *.sparseimage) ;; *) die "name the image something.sparseimage" ;; esac
  local need_gb=$(( $( (du -sk "$LIMA_DIR" "$HOME_DIR" 2>/dev/null || true) | awk '{s+=$1} END {print int(s/1048576)+1}') + 5 ))
  local free_gb; free_gb=$(df -k "$dir" | awk 'NR==2 {print int($4/1048576)}')
  [ "$free_gb" -ge "$need_gb" ] || die "$dir has ${free_gb} GB free; the image needs about ${need_gb} GB"

  cat <<EOF
This packs the agent up to move it to another Mac:
  1. pause it (a waking in progress finishes first), and stop its heartbeat, its line and its lab here;
  2. make sure its mind and body are pushed to GitHub;
  3. copy its home, GitHub login, lab and Mac-shell home into an encrypted image at
     $IMAGE (about ${need_gb} GB at most; you choose its password).
Nothing here is deleted. It stays paused and stopped until you erase this Mac.
EOF
  [ -n "$TEST" ] || ask "Go ahead?" || exit 1

  if [ -z "$TEST" ]; then
    say "Pausing the agent"
    mainjs pause "moving to a new Mac"
    until mainjs status | grep -q '^PAUSED' && [ ! -e "$HOME_DIR/run/life.lock" ]; do
      echo "  (it's awake; waiting for this waking to end, checking every 30 seconds)"
      sleep 30
    done
    say "Stopping its heartbeat, line and lab on this Mac"
    "$HOME_DIR/body/scripts/install.sh" --unschedule
    while pgrep -f "personhood/body/runtime/main.ts" >/dev/null; do sleep 2; done
    if command -v limactl >/dev/null; then
      limactl stop lab >/dev/null 2>&1 || true
      until [ "$(limactl list --format '{{.Status}}' lab 2>/dev/null || echo Stopped)" != Running ]; do sleep 2; done
    fi

    say "Pushing its mind and body"
    for r in mind body; do
      git -C "$HOME_DIR/$r" push -q origin HEAD 2>/dev/null || echo "  ($r: nothing to push, or the push failed; its files travel in the image anyway)"
    done
  fi

  say "Creating the encrypted image (choose a password; you'll need it on the new Mac)"
  hdi create -quiet -type SPARSE -fs APFS -size "$((need_gb + 20))g" -volname "Wick move" -encryption AES-256 "$IMAGE"
  attach

  say "Packing its home and GitHub login"
  local ssh_items=()
  for f in id_ed25519 id_ed25519.pub known_hosts config; do [ -e "$HOME/.ssh/$f" ] && ssh_items+=(".ssh/$f"); done
  tar -C "$HOME" -cf "$MNT/home.tar" \
    --exclude 'personhood/run' --exclude 'personhood/body/node_modules' --exclude '.DS_Store' \
    "$(basename "$HOME_DIR")" ${ssh_items[@]+"${ssh_items[@]}"}
  if [ -z "$TEST" ]; then
    ( umask 077; gh auth token > "$MNT/gh-token" ) || die "couldn't read the GitHub login (gh auth token)"
  fi

  if [ -d "$LIMA_DIR/lab" ]; then
    say "Packing its lab (the whole VM: a few minutes)"
    tar -C "$(dirname "$LIMA_DIR")" -cf "$MNT/lima.tar" \
      --exclude '*.sock' --exclude '*.pid' --exclude 'ha.stderr.log' --exclude 'ha.stdout.log' --exclude 'boot-session.tmp' \
      "$(basename "$LIMA_DIR")"
  fi

  if [ -z "$TEST" ] && mac_shell_on && id -u "$MAC_USER" >/dev/null 2>&1; then
    say "Packing its Mac shell's home (/Users/$MAC_USER)"
    # Not ~/Library: that's macOS's own per-account plumbing (parts of it closed even to the account
    # itself), and the new Mac makes a fresh one. Its work is in its folders and dotfiles.
    sudo -n -u "$MAC_USER" /usr/bin/tar -C "/Users/$MAC_USER" -cf - --exclude './Library' --exclude './.Trash' . > "$MNT/wick.tar" \
      || die "couldn't read /Users/$MAC_USER as $MAC_USER"
  fi

  say "Writing checksums"
  (
    cd "$MNT"
    {
      echo "from: $(scutil --get ComputerName 2>/dev/null || hostname) · $(date -u +%FT%TZ) · user $(id -un)"
      echo "wakings: $(node -p "require('$HOME_DIR/mind/state/meta.json').wakings" 2>/dev/null || echo '?')"
    } > about.txt
    shasum -a 256 ./*.tar > SHA256SUMS
  )
  detach
  MNT=""
  cat <<EOF

Done: $IMAGE
The agent is paused, and its heartbeat, line and lab are stopped on this Mac.
Next, on the new Mac: docs/moving.md, step 3 (bash move.sh in <the image>).
If you change your mind instead: ~/personhood/body/scripts/install.sh, then node ~/personhood/body/runtime/main.ts resume
EOF
}

# ---------------------------------------------------------------- in
need_tools() {
  [ "$(uname -m)" = arm64 ] || die "the agent's lab is an Apple Silicon (arm64) virtual machine; this Mac is $(uname -m)"
  if ! command -v brew >/dev/null 2>&1 && [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  grep -qs 'brew shellenv' "$HOME/.zprofile" || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  local missing=()
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || missing+=(node)
  command -v gh >/dev/null 2>&1 || missing+=(gh)
  command -v limactl >/dev/null 2>&1 || missing+=(lima)
  if [ ${#missing[@]} -gt 0 ]; then
    # On a shared Mac, Homebrew belongs to the person who uses it (an admin account); this
    # account just uses what it installed. Only install here if this account can.
    if command -v brew >/dev/null 2>&1 && [ -w "$(brew --prefix)/bin" ]; then
      say "Installing ${missing[*]}"
      brew install "${missing[@]}"
    else
      die "Missing: ${missing[*]}. From your own (administrator) account on this Mac, run:

    brew install node gh lima

(installing Homebrew first if you haven't: https://brew.sh). Then come back to this account and run this again."
    fi
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    say "Installing Claude Code (its native installer)"
    curl -fsSL https://claude.ai/install.sh | bash
    grep -qs '.local/bin' "$HOME/.zprofile" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zprofile"
  fi
}

move_in() {
  [ -f "$IMAGE" ] || die "no image at $IMAGE"
  if [ "$(id -un)" != claude ] && [ -z "$TEST" ]; then
    die "run this from an account named claude, as on the old Mac. Its lab's Linux user, and the paths it knows, come from that name. (Make one in System Settings → Users & Groups, as an administrator, log in to it, and run this again there.)"
  fi
  if [ -e "$HOME_DIR/secrets/vault.key" ] && [ -z "$FORCE" ]; then
    die "$HOME_DIR already has an agent in it. To replace it with the one in the image: PERSONHOOD_MOVE_FORCE=1 bash $0 in $IMAGE"
  fi
  if [ -d "$LIMA_DIR/lab" ] && [ -z "$FORCE" ]; then
    die "$LIMA_DIR/lab already exists. Remove it (limactl delete lab) or set PERSONHOOD_MOVE_FORCE=1 to replace it"
  fi
  [ -n "$TEST" ] || need_tools

  say "Opening the image (its password, please)"
  attach
  say "Checking it"
  ( cd "$MNT" && shasum -a 256 -c --quiet SHA256SUMS ) || die "the image's contents don't match their checksums; copy it again"
  [ -f "$MNT/about.txt" ] && sed 's/^/  /' "$MNT/about.txt"

  say "Unpacking its home and GitHub login"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if [ -e "$HOME/.ssh/id_ed25519" ] && ! tar -xOf "$MNT/home.tar" .ssh/id_ed25519 2>/dev/null | cmp -s - "$HOME/.ssh/id_ed25519"; then
    die "$HOME/.ssh/id_ed25519 already exists and isn't the agent's key; move it aside and run this again"
  fi
  tar -C "$HOME" -xpf "$MNT/home.tar" --no-acls
  chmod 700 "$HOME_DIR" "$HOME_DIR"/{secrets,mind,line,logs,claude-config} 2>/dev/null || true
  chmod 600 "$HOME/.ssh/id_ed25519" 2>/dev/null || true
  mkdir -p -m 700 "$HOME_DIR/run"
  if [ -z "$TEST" ]; then
    gh auth login --hostname github.com --git-protocol https --with-token < "$MNT/gh-token"
    gh auth setup-git >/dev/null 2>&1 || true
    echo "  GitHub: signed in as $(gh api user --jq .login)"
  fi

  if [ -f "$MNT/lima.tar" ]; then
    say "Unpacking its lab (a few minutes)"
    mkdir -p "$(dirname "$LIMA_DIR")"
    tar -C "$(dirname "$LIMA_DIR")" -xpf "$MNT/lima.tar" --no-acls
  fi

  [ -z "$TEST" ] || { say "Test run: unpacked"; return; }

  say "Bringing its mind and body up to date"
  for r in mind body; do git -C "$HOME_DIR/$r" pull -q --rebase --autostash origin main || echo "  ($r: couldn't pull; doctor will say more)"; done

  say "Running the installer (dependencies, the heartbeat, the line, the lab and its screen)"
  "$HOME_DIR/body/scripts/install.sh"

  if [ -f "$MNT/wick.tar" ] && mac_shell_on; then
    if ! sudo -n -u "$MAC_USER" true 2>/dev/null; then
      if id -Gn | tr ' ' '\n' | grep -qx admin; then
        say "Setting up its Mac shell (this asks for this Mac's password)"
        sudo "$HOME_DIR/body/scripts/mac-shell.sh"
      else
        # A standard account (a Mac shared with you): the setup needs an administrator.
        say "Setting up its Mac shell needs an administrator"
        cat <<MSG
Switch to your own account (Fast User Switching, in the menu bar), and in Terminal there run:

    sudo bash $HOME/personhood/body/scripts/mac-shell.sh $(id -un)

It makes the $MAC_USER account, and walls this account's home, and yours, off from it.
Then switch back here.
MSG
        until sudo -n -u "$MAC_USER" true 2>/dev/null; do
          printf 'Press Return once it has finished (or type skip to leave the Mac shell for later): '
          read -r a </dev/tty
          [ "$a" = skip ] && break
        done
      fi
    fi
    if sudo -n -u "$MAC_USER" true 2>/dev/null; then
      say "Unpacking its Mac shell's home"
      # As that account, so everything is its own; the home's inherited ACL lets the harness read it.
      ( cd / && sudo -n -u "$MAC_USER" /usr/bin/tar -C "/Users/$MAC_USER" -xpf - --no-acls < "$MNT/wick.tar" )
    else
      cp "$MNT/wick.tar" "$HOME_DIR/run/wick.tar" && chmod 600 "$HOME_DIR/run/wick.tar"
      echo "  Left for later: its Mac shell's files are in $HOME_DIR/run/wick.tar (docs/moving.md says how to finish)."
    fi
  fi

  detach
  MNT=""
  say "Checking everything"
  mainjs doctor || true
  echo
  if ask "If every line above is ✓, resume the agent now?"; then
    mainjs resume
    echo "Resumed. The next heartbeat (within 30 minutes) wakes it; /status on the line shows how it's doing."
  else
    echo "Still paused. When you're ready: node ~/personhood/body/runtime/main.ts resume"
  fi
  cat <<EOF

Once it has woken here and all is well:
  - delete the image ($IMAGE), and empty the Trash;
  - erase the old Mac (docs/moving.md, step 5).
EOF
}

if [ "$MODE" = out ]; then move_out; else move_in; fi
