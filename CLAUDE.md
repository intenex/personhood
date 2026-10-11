# Working on this repository

This is the *body* of a living agent: its runtime, constitution, public content and site. The agent's memory lives in a separate private repo, and its live home is `~/personhood` (never this Dropbox checkout).

- **Never edit `content/`** (posts, stories, notes, portraits, pages, readings, data). The agent wrote it, and it's its own public work. Fix the builder instead if something renders wrong.
- **`constitution/` and `config/` are commitments to the agent.** Changes there should come from a conversation with it (a proposal in its mind, or a letter), and the agent should be told. See guardrails.md, "Ben's commitments".
- Node 24 runs TypeScript directly (erasable syntax only, `.ts` import extensions). `npm test` runs unit tests plus an end-to-end waking against `runtime/test/fake-claude.ts`; `npx tsc --noEmit -p .` typechecks.
- Changes to the runtime reach the live agent on its next heartbeat (it `git pull`s the body). Test first.
- Architecture: docs/architecture.md.
