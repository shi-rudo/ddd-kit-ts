# CLAUDE.md

Project agent instructions live in [AGENTS.md](./AGENTS.md). Read it for the
beads (`bd`) issue-tracking workflow and shell conventions.

## Prose style

Do not use em dashes (`—`) anywhere the project ships text: docs, code
comments, JSDoc, commit messages, CHANGELOG entries, and string literals.
Rewrite with the punctuation the grammar actually calls for: a comma for an
aside, a colon for an explanation or list, a semicolon or a separate sentence
for two independent clauses, or parentheses for a true parenthetical. Never
substitute a spaced hyphen (` - `); that is not a sentence connector.

## Git

- **Never commit without explicit approval.** Make the change, run the quality
  gates (`pnpm test`, `pnpm typecheck`, `pnpm build`), then report what changed
  and the proposed commit message and **wait for the user to approve** before
  running `git commit`.
- The same applies to `git push`, creating tags, GitHub releases, and `npm`/
  `pnpm publish`: outward-facing actions are taken only on explicit request.
