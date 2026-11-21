#!/usr/bin/env bash
# Give the agent a shell on its Mac: a standard (non-admin) macOS account, `wick` by default, that
# the mac_run life tool runs commands as. Run it once with sudo, naming the account the heartbeat
# runs under. From that account, if it's an administrator:
#
#   sudo ~/personhood/body/scripts/mac-shell.sh
#
# or, on a Mac you share with it (its account a standard one), from your own administrator account:
#
#   sudo bash /Users/claude/personhood/body/scripts/mac-shell.sh claude
#
# It:
#   - creates the account (hidden from the login window, no password, so nobody can log in; not an admin);
#   - lets the harness account run commands as that account, and only as it, without a password
#     (/etc/sudoers.d/personhood-<user>); the account itself gets no sudo at all;
#   - walls the harness account's home off from it with an ACL, and makes ~/personhood owner-only;
#   - walls every other account's home on the Mac off from it the same way (yours, on a shared Mac);
#   - lets the harness account read the new account's home (so the agent's Read tool can see what it made);
#   - installs Homebrew in its home (~/homebrew) and points pip and npm at its home too.
#
# Safe to re-run. It never prints a secret. Undo: `sudo dscl . -delete /Users/wick`, `sudo rm -rf /Users/wick`,
# `sudo rm /etc/sudoers.d/personhood-wick`, `chmod -a "user:wick deny …" ~` (see `ls -le ~`).

set -euo pipefail

MAC_USER="${PERSONHOOD_MAC_USER:-wick}"
HARNESS="${1:-${SUDO_USER:-}}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this is for macOS"
[ "$(id -u)" = 0 ] || die "run it with sudo: sudo bash $0 <the account the heartbeat runs under>"
[ -n "$HARNESS" ] && [ "$HARNESS" != root ] || die "name the account the heartbeat runs under: sudo bash $0 claude"
id -u "$HARNESS" >/dev/null 2>&1 || die "no account named $HARNESS on this Mac"
[[ "$MAC_USER" =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || die "bad account name: $MAC_USER"
[ "$MAC_USER" != "$HARNESS" ] || die "the agent's account must not be the harness account"

# The new account can't see wherever this was started from (that's the point), so work from /.
cd /

HARNESS_HOME="$(dscl . -read "/Users/$HARNESS" NFSHomeDirectory | awk '{print $2}')"
MAC_HOME="/Users/$MAC_USER"
PERSONHOOD="${PERSONHOOD_HOME:-$HARNESS_HOME/personhood}"
[ -d "$PERSONHOOD" ] || die "no $PERSONHOOD; run scripts/install.sh first"

# The account is made directly in the local directory with dscl. (sysadminctl, which this used
# before, can report success on newer macOS and then roll the account back, leaving none.)
# No password at all ("*"): nobody can log in with it; the harness reaches it through sudo.
mac_user_ok() { dscacheutil -flushcache 2>/dev/null || true; id -u "$MAC_USER" >/dev/null 2>&1; }
if ! mac_user_ok; then
  say "Creating the account $MAC_USER (standard, not an admin)"
  REC="/Users/$MAC_USER"
  uid="$(dscl . -read "$REC" UniqueID 2>/dev/null | awk '{print $2}' || true)"
  if [ -z "$uid" ]; then
    uid="$(dscl . -list /Users UniqueID | awk '$2 >= 501 && $2 < 1000 {print $2}' | sort -n | tail -1 || true)"
    uid=$(( ${uid:-500} + 1 ))
    while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$(( uid + 1 )); done
  fi
  dscl . -create "$REC"
  dscl . -create "$REC" RealName "Wick (the agent's shell)"
  dscl . -create "$REC" UniqueID "$uid"
  dscl . -create "$REC" PrimaryGroupID 20
  dscl . -create "$REC" UserShell /bin/bash
  dscl . -create "$REC" NFSHomeDirectory "$MAC_HOME"
  dscl . -create "$REC" Password '*'
  dscl . -create "$REC" IsHidden 1
  for _ in 1 2 3 4 5 6 7 8 9 10; do mac_user_ok && break; sleep 1; done
  mac_user_ok || die "couldn't create the account $MAC_USER (dscl . -read $REC shows what's there)"
fi
[ "$(dscl . -read "/Users/$MAC_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)" = "$MAC_HOME" ] \
  || dscl . -create "/Users/$MAC_USER" NFSHomeDirectory "$MAC_HOME"
# Its home: an empty folder is all it needs (macOS fills in ~/Library as it's used). Ownership and
# permissions are set below, also when a folder was left there by an earlier try.
[ -d "$MAC_HOME" ] || mkdir "$MAC_HOME"

# Never an administrator, and no sudo of its own.
for g in admin wheel _developer _lpadmin com.apple.access_ssh com.apple.access_screensharing; do
  if dseditgroup -o checkmember -m "$MAC_USER" "$g" >/dev/null 2>&1; then
    dseditgroup -o edit -d "$MAC_USER" -t user "$g"
  fi
done

say "Letting $HARNESS run commands as $MAC_USER (and only as $MAC_USER) without a password"
grep -qE '^#includedir /private/etc/sudoers.d|^@includedir /private/etc/sudoers.d' /etc/sudoers \
  || die "/etc/sudoers doesn't include /private/etc/sudoers.d; add the rule by hand with visudo"
mkdir -p /private/etc/sudoers.d
rule="$(mktemp)"
cat > "$rule" <<EOF
# personhood: the harness ($HARNESS) runs the agent's mac_run commands as $MAC_USER, a standard
# account with no sudo of its own. This is the only thing $HARNESS may do through sudo without a password.
$HARNESS ALL=($MAC_USER) NOPASSWD: ALL
EOF
visudo -cqf "$rule" || { rm -f "$rule"; die "the sudoers rule didn't validate"; }
install -m 0440 -o root -g wheel "$rule" "/private/etc/sudoers.d/personhood-$MAC_USER"
rm -f "$rule"

say "Walling $HARNESS's home off from $MAC_USER"
# A deny entry for that one account: it can't list, enter or change anything under $HARNESS_HOME,
# whatever the Unix permissions further down say. Nobody else's access changes.
DENY="user:$MAC_USER deny list,search,add_file,add_subdirectory,delete_child,readattr,readextattr,readsecurity,writeattr,writeextattr,writesecurity,chown"
ls -led "$HARNESS_HOME" | grep -q "user:$MAC_USER deny" || chmod +a "$DENY" "$HARNESS_HOME"
# And a second layer: the agent's home is owner-only all the way down to its secrets.
chmod 700 "$PERSONHOOD"
for d in secrets secrets/lab secrets/mac claude-config logs run line mind; do
  [ -d "$PERSONHOOD/$d" ] && chmod 700 "$PERSONHOOD/$d"
done

# Everyone else's home too: on a Mac someone also uses as themselves, theirs is no business of its.
# (The agent's harness checks this from its side every waking and keeps the shell closed if not.)
OTHERS=()
while read -r u uid; do
  [ "$uid" -ge 500 ] 2>/dev/null || continue
  [ "$u" = "$MAC_USER" ] || [ "$u" = "$HARNESS" ] && continue
  h="$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  case "$h" in /Users/?*) [ -d "$h" ] || continue ;; *) continue ;; esac
  OTHERS+=("$h")
done < <(dscl . -list /Users UniqueID)
for h in ${OTHERS[@]+"${OTHERS[@]}"}; do
  say "Walling $h off from $MAC_USER"
  ls -led "$h" | grep -q "user:$MAC_USER deny" || chmod +a "$DENY" "$h"
done

say "Setting up $MAC_USER's home"
# Owner-only, plus read access for the harness account so the agent's Read tool can see its files.
chown "$(id -u "$MAC_USER"):20" "$MAC_HOME"
chmod 700 "$MAC_HOME"
ALLOW="user:$HARNESS allow list,search,read,readattr,readextattr,readsecurity,file_inherit,directory_inherit"
ls -led "$MAC_HOME" | grep -q "user:$HARNESS allow" || find "$MAC_HOME" -xdev -exec chmod +a "$ALLOW" {} + 2>/dev/null || true

as_mac() { sudo -n -u "$MAC_USER" -H /usr/bin/env -i HOME="$MAC_HOME" USER="$MAC_USER" LOGNAME="$MAC_USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 /bin/bash --noprofile --norc -c "$1"; }

as_mac 'cd ~ && cat > .bash_profile <<"EOF"
# Software lives in this home: Homebrew in ~/homebrew, pip --user in ~/.local, npm -g in ~/.npm-global.
export HOMEBREW_PREFIX="$HOME/homebrew" HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
export PATH="$HOME/homebrew/bin:$HOME/homebrew/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
export PIP_USER=1 PYTHONUSERBASE="$HOME/.local" npm_config_prefix="$HOME/.npm-global"
export BASH_SILENCE_DEPRECATION_WARNING=1
[ -r ~/.bashrc ] && . ~/.bashrc
EOF
mkdir -p .local/bin .npm-global/bin'

if ! as_mac 'test -d ~/homebrew/.git && test -x ~/homebrew/bin/brew'; then
  say "Installing Homebrew in $MAC_HOME/homebrew"
  # A git checkout, so `brew update` works (Homebrew's own "untar anywhere" install).
  as_mac 'cd ~ && rm -rf homebrew && git clone -q https://github.com/Homebrew/brew homebrew && homebrew/bin/brew --version | head -1' \
    || echo "(Homebrew didn't install; the agent can do it later with mac_run)"
fi

say "Checking"
fail=0
check() { if eval "$2"; then echo "✓ $1"; else echo "✗ $1"; fail=1; fi; }
check "$MAC_USER can't read $PERSONHOOD/secrets" "! as_mac 'ls $PERSONHOOD/secrets' >/dev/null 2>&1"
check "$MAC_USER can't enter $HARNESS_HOME" "! as_mac 'ls $HARNESS_HOME' >/dev/null 2>&1"
for h in ${OTHERS[@]+"${OTHERS[@]}"}; do check "$MAC_USER can't enter $h" "! as_mac 'ls $h' >/dev/null 2>&1"; done
check "$MAC_USER can't write $PERSONHOOD/body/runtime" "! as_mac 'touch $PERSONHOOD/body/runtime/.mac-probe' >/dev/null 2>&1"
check "$MAC_USER has no sudo" "! as_mac 'sudo -n true' >/dev/null 2>&1"
check "$MAC_USER reaches the internet" "as_mac 'curl -fsS -o /dev/null --max-time 20 https://example.com'"
check "$HARNESS can run as $MAC_USER without a password" "sudo -u '$HARNESS' sudo -n -u '$MAC_USER' true"
check "$HARNESS has no other passwordless sudo" "! sudo -u '$HARNESS' sudo -n -k true 2>/dev/null"
[ "$fail" = 0 ] && echo && echo "Done. Turn it on with \"mac\": {\"enabled\": true} in config/life.json (it may already be)." || exit 1
