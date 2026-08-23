# Agent Instructions

## Repository attribution policy

- Never include an assistant, agent, model, automation, or tool identity in
  branch names, commit messages, pull-request titles or descriptions, issues,
  changelogs, release notes, or any other repository-visible artifact.
- Use neutral, intent-based naming and write every artifact as ordinary project
  work without generated-by attribution.

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Source organization

Organize source code by architectural responsibility first and by cohesive
capability second.

The allowed top-level areas under `src/` are:

- `domain`: domain models, aggregates, entities, value objects, domain events,
  specifications, and domain state machines.
- `application`: use-case orchestration, CQRS, handlers, idempotency, units of
  work, deadlines, and projections.
- `messaging`: integration messages, event buses, and outbox processing.
- `persistence`: repositories, event stores, snapshot stores, persistence
  models, and storage adapters.
- `presentation`: HTTP concerns, public error mapping, and external
  representations.
- `testing`: reusable testing contracts and test support that form part of the
  package API.
- `internal`: non-public, dependency-free implementation helpers.

Before you create or move a source file:

1. Identify the capability that owns the file.
2. Place it under that capability, not under the capability that merely
   consumes it.
3. Reuse an existing module before you create a new directory.
4. Create a new top-level directory only when none of the defined
   architectural areas applies.
5. Update the affected exports, API-surface tests, and architecture tests.

Apply these constraints:

- Do not create generic `core`, `common`, `shared`, `helpers`, or `utils`
  directories.
- Move a reusable helper to the capability that owns its meaning. Place it in
  `internal` only when it is generic, non-public, and has no architectural
  owner.
- Keep ports with the capability that requires them. Place implementations in
  an `adapters/` subdirectory.
- Treat in-memory stores as adapters, not as contracts.
- Keep domain events separate from integration messages.
- Keep persistence contracts, persistence models, and storage adapters visibly
  separated.
- Keep unit tests next to their implementation.
- Place architecture, API-surface, and cross-module integration tests under
  `test/`.
- Place examples and demonstration implementations under `examples/`, never
  among production modules.
- Use `index.ts` only at intentional public module boundaries.
- Do not add root-level proxy files when the `package.json` exports can target
  the owning module directly.
- Do not create directories merely to shorten a file listing. Every directory
  must represent a stable capability or architectural boundary.
- Avoid names that repeat their parent context, such as
  `domain/domain-state-machine/`.
- Do not reorganize unrelated modules as part of a local change.

If a file has more than one plausible location, choose the module that owns its
invariants and lifecycle. If the ownership stays unclear, document the
architectural decision before you implement the change.

A change is not complete when it does any of the following:

- It introduces an unexplained top-level directory.
- It adds a generic utility collection.
- It mixes a port with its adapter.
- It exposes internal implementation details through the public API.

### Current state

The tree does not follow this rule yet. Today it breaks the rule in four ways:

- No top-level directory under `src/` carries an allowed name.
- `src/core` and `src/utils` are two of the forbidden collections.
- Five root-level proxy files exist.
- The examples sit in `src/app`.

Bead `ddd-kit-ts-j0r7` tracks the migration and its order.

The rule binds every new and every moved file from now on. Do not read the
current tree as permission.


<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Version-controlled: Built on Dolt with cell-level merge
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
