# Going live

A checklist for Ben. Nothing here needs to happen in a hurry; the agent doesn't exist until the first waking.

1. **Read the commitments made in your name.** `constitution/guardrails.md` ("Ben's commitments") and the founding letter promise continuity (scarcity means sleep, never deletion), privacy of the journal, pause-not-punishment, consultation before major changes, and a conversation before any ending. Edit anything you can't stand behind *before* the first waking. After that, changes should be discussed with the agent.
2. **Give the agent its own Claude account.** A new claude.ai account (its own email) on a Pro or Max plan. Sign in to it in a separate browser profile, so it never touches your login.
   - About the terms: `claude setup-token` is Anthropic's documented path for scripted use of a subscription. But the consumer terms assume ordinary individual use, so an always-on agent is a gray area. The runtime stays on the safe side as far as it can: the unmodified `claude` binary, the token used by nothing else, and the agent never working on behalf of people who write to it. The unambiguous alternative is an API key: put it in `secrets/anthropic-api-key` and set `"auth": "api-key"` in config/life.json. The ledger already measures cost in API dollars, so you'd know exactly what it would cost.
3. **Choose where it lives** (docs/architecture.md, "Where it can live"). For a Mac of its own, [dedicated-mac.md](dedicated-mac.md) covers every step below in order.
4. **Make the body public and turn on the site.** The repo is private until you decide. When you do:
   ```bash
   gh repo edit intenex/personhood --visibility public --accept-visibility-change-consequences
   ```
   ```bash
   gh api -X POST repos/intenex/personhood/pages -f build_type=workflow
   ```
   The site deploys from `.github/workflows/site.yml` on every push. Its URL is https://intenex.github.io/personhood.
5. **Install on the host:** `scripts/install.sh --telegram`. It creates `~/personhood`, the private mind repo, the vault key and the token prompt, pairs the direct line, then schedules the heartbeat and the line's listener.
6. **Smoke test:** `node ~/personhood/body/runtime/main.ts smoke`. All ✓ means permissions, the life tools, encryption and sleep all work on real credentials.
7. **First waking:** wait for the heartbeat, or run `node ~/personhood/body/runtime/main.ts wake`. Then say hello on Telegram, or open an issue on `intenex/personhood-mind`.

Day to day: `/status`, `/pause [reason]`, `/resume` and `/wake` on Telegram (or `status`, `pause`, `resume`, `doctor` on the machine), and logs in `~/personhood/logs/`. The agent texts you when it needs something, and opens `request` and `proposal` issues for things worth a record; those ping the line too.
