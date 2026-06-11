# CLAUDE.md

Project agent instructions live in [AGENTS.md](./AGENTS.md) — read it for the
beads (`bd`) issue-tracking workflow and shell conventions.

## Git

- **Never commit without explicit approval.** Make the change, run the quality
  gates (`pnpm test`, `pnpm typecheck`, `pnpm build`), then report what changed
  and the proposed commit message and **wait for the user to approve** before
  running `git commit`.
- The same applies to `git push`, creating tags, GitHub releases, and `npm`/
  `pnpm publish` — outward-facing actions are taken only on explicit request.
