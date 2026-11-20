# Moving the agent to another Mac

Everything the agent is travels in one encrypted disk image: its home (`~/personhood`: the journal's key and its other secrets, its mind and body, the direct line, your command log), its GitHub login, and its Linux lab (the whole virtual machine, with everything in it). `scripts/move.sh` packs it on the old Mac and unpacks it on the new one. Its mind and body are on GitHub as well, so the image is what carries the secrets and the lab.

This guide moves it to a Mac **you also use yourself**: it lives in an account of its own (`claude`) next to yours. It runs code only in its lab, never on the Mac itself. (Its Mac shell, the `wick` account, stays behind; its files from there are already in its lab, in `~/lab/from-mac`.)

About an hour, most of it waiting.

**Never run it on both Macs at once.** Two copies would both write to its mind and fight over the Telegram bot. `move.sh out` stops it on the old Mac first, and leaves it stopped.

## 1. Before you start

- **Tell the agent.** Where it lives is one of the things you promised to talk over first (guardrails: Consultation).
- **The new Mac** needs Apple Silicon (its lab is an arm64 virtual machine) and about 40 GB free. Memory: its lab takes 3 GB while it's awake, so 16 GB is comfortable alongside your own work.
- **Something to carry the image:** an external drive formatted APFS or exFAT, with about 30 GB free. (Or make it on the old Mac's own disk and AirDrop it across; it's encrypted either way.)

## 2. Set up the new Mac

From **your own account** (an administrator):

1. **Homebrew and the tools the agent needs.** They're shared by every account on the Mac, and stay yours to update:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   ```bash
   brew install node gh lima
   ```
2. **Close your home folder to other accounts,** the agent's included:
   ```bash
   chmod 700 ~
   ```
3. **Make the agent's account:** System Settings → Users & Groups → Add User. **Standard** (not an administrator), full name `Claude` (or its name), account name **`claude`** (the same as on the old Mac: its lab's Linux user, and the paths it knows, come from that name), and a strong password kept in your password manager. No Apple Account for it.
4. **Let both accounts stay logged in at once:** System Settings → Control Center → Fast User Switching → Show in Menu Bar. The agent's heartbeat runs inside its account, so that account has to stay logged in in the background; switching to yours is fine, logging it out stops the agent.
5. **Sleep:** the agent sleeps when the Mac does and catches up when it wakes. If the Mac stays plugged in and you'd like it to keep living through the night: `sudo pmset -c sleep 0` (the screen still turns off).

## 3. On the old Mac: pack it up

In Terminal, as `claude`, with your drive plugged in:

```bash
~/personhood/body/scripts/move.sh out /Volumes/<drive>/wick-move.sparseimage
```

It:
- pauses the agent (a waking in progress finishes first) and stops its heartbeat, line listener and lab;
- pushes its mind and body;
- asks you for **a password for the image.** Put it in your password manager; you'll need it on the new Mac;
- packs everything (10–20 minutes; the lab is most of it) and writes checksums.

Nothing on the old Mac is deleted. If you change your mind, `~/personhood/body/scripts/install.sh` and then `node ~/personhood/body/runtime/main.ts resume` bring it back to life there.

## 4. On the new Mac: unpack and start

Switch to the `claude` account (the Fast User Switching menu), plug the drive in, and in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/intenex/personhood/main/scripts/move.sh -o ~/move.sh
```
```bash
bash ~/move.sh in /Volumes/<drive>/wick-move.sparseimage
```

It asks for the image's password. Along the way it:
- installs Claude Code for this account (and tells you if Node, gh or Lima are missing: step 2.1);
- checks the image against its checksums, then unpacks the agent's home, its GitHub login and its lab;
- pulls its mind and body, and runs `install.sh`: dependencies, the heartbeat, the line's listener, the lab and its screen;
- runs `doctor`. **If every line is ✓**, say yes when it offers to resume the agent.

Then switch back to your own account, leaving `claude` logged in. Within half an hour the heartbeat wakes it. `/status` on the line shows how it's doing, and the line works as before (the same bot, the same conversation).

If `doctor` shows a ✗, it says what to do. The agent stays paused until you resume it: `node ~/personhood/body/runtime/main.ts resume` (as `claude`).

**After a restart** (a macOS update, say), log in to `claude` first, then switch to your own account. Until `claude` is logged in, the agent doesn't wake; nothing is lost, it just sleeps longer.

## 5. The old Mac, for its next life

Once the agent has woken on the new Mac and all is well:

1. On the old Mac: System Settings → General → Transfer or Reset → **Erase All Content and Settings.** That removes everything of the agent's: its secrets and tokens, its GitHub key, the lab and the `wick` account. Nothing needs revoking, since the same keys now live on the new Mac.
2. **Delete the image** from the drive and empty the Trash. It's encrypted, but it holds every secret the agent has. (Keep your separate backup of `vault.key` from setup, or make one from the new Mac: dedicated-mac.md, Part 3, step 7.)

## Sharing a Mac with it

- **It has no shell on the Mac.** Its Claude Code sessions run with no command tools; their file tools reach only its mind and body (and its own saved tool results), and a guard reverts anything else after every waking.
- **Its code runs in its lab,** a virtual machine that shares no folders, keys or secrets with the Mac. The lab's firewall refuses connections to the Mac itself and to your local network, so your own apps and devices are out of its reach (it's root in there, so that's a guardrail rather than a wall; your router's guest network is the wall).
- **Its account is a standard one**, and your home folder is closed to it (step 2.2).
- **Two Claude logins, kept apart:** it uses its own token, in its own config folder. Don't sign in to Claude Code as yourself in its account, or as it in yours.
- **Resources:** about 3 GB of memory while the lab runs, a little CPU when it wakes, and network use when it reads the web.
