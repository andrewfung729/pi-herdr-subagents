# AGENTS.md

Async subagent extension for [pi](https://github.com/earendil-works/pi), running sub-agents in [herdr](https://herdr.dev) panes. TypeScript, ESM, no build step — the pi extension entry is loaded directly from source.

## Fork lineage & what this repo provides

Fork chain: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) (originated the architecture) → [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux-only) → **this repo** (herdr-only). History was squashed at the port commit, so `git log` cannot answer "what changed vs upstream" — **this repo's docs are the spec**. What the system provides today, summarized:

- **herdr-only surface:** all terminal operations via the `herdr` CLI (`pi-extension/subagents/herdr.ts`); two-column layout with vertical stacking; `recent-unwrapped` screen reads; workspace-qualified pane ids (`w1:p3`); tools register only inside herdr; version gate (`>=0.8.2` required, skill pinned to 0.9.0 in `skills/herdr/`, verified by `check:herdr-skill`).
- **One parent wake per batch:** completions stream in individually; the parent turn triggers once per autonomous batch.
- **Failures surface, never hang:** fatal startup stalls escalate after 60 s (read pane → synthesize `.exit` → deliver failure result); vanished panes error out; explicit spawn names reserved synchronously.
- **pi-only execution:** every sub-agent is a pi process; bundled agents run on the spawning session's current model; web tools via pi-web-access (`fetch_content`, `source_check`, `get_search_content`); shell is plain `bash`; role folders use `AGENTS.md`.
- **Dev infra:** pnpm, Biome + tsgo (`pnpm check`), husky pre-commit, three-tier test suite. Peer floor `pi >= 0.99` (codemode builtin + tool `exposure`).

Upstream repos document a different system (tmux surface, different tool names and models, other CLI backends). Read their issues and PRs for history, but trust this repo's docs and code for behavior.

## Commands

```bash
pnpm install                  # pnpm@12 (mise; see packageManager)
pnpm check                    # biome lint+format (error-on-warnings) + tsgo typecheck — must pass before commit (husky pre-commit)
pnpm fix                      # biome autofix
pnpm test                     # unit tests (node --test) — no multiplexer needed, safe anywhere
pnpm run test:unit            # subset that runs without herdr
pnpm run test:surface         # herdr surface tests — RUN INSIDE A HERDR PANE, sequential
pnpm run test:integration     # full lifecycle — RUN INSIDE HERDR, real LLM calls, slow
pnpm run check:herdr-skill    # verify skills/herdr matches pinned herdr 0.9.0
```

There is no build or bundle step. `pnpm check` is the CI gate.

## Layout

```
pi-extension/subagents/
  index.ts           # extension entry (package.json "pi.extensions"). Tool schemas, spawning,
                     # steering, registry, widget, ask_question wiring (~2.7k lines — largest file)
  herdr.ts           # surface layer: thin wrapper over `herdr pane split|run|read|close` CLI.
                     # Same API the tmux version had (create/split, send, read, poll-for-exit)
  session.ts         # child pi process launch: --no-extensions --tools <allowlist>, loadout snapshot
  packages.ts        # resolves installed pi packages' extension entries (deduped against the
                     # tool-extension map) so restricted children keep provider-registering
                     # packages (e.g. custom model providers) loaded
  activity.ts        # runtime activity snapshot files the child writes; parent polls for widget status
  status.ts          # status widget UI
  subagent-done.ts   # completion sidecars, fatal-startup-stall escalation
agents/              # bundled agent definitions (markdown + frontmatter): scout, worker, researcher
skills/herdr/        # bundled herdr CLI skill, pinned to herdr 0.9.0 (checked by scripts/check-herdr-skill.ts)
scripts/             # check-herdr-skill.ts, verify-fatal-stall.ts (NOT covered by biome config)
test/
  test.ts            # main unit tests (3k lines)
  system-prompt-mode.test.ts
  integration/       # harness.ts + herdr-surface + subagent-lifecycle (need herdr; lifecycle needs LLM keys)
```

## Conventions & gotchas

- **ESM with explicit `.ts` import extensions** (`rewriteRelativeImportExtensions`), `strict` + `erasableSyntaxOnly` — no enums, no parameter properties; use plain types/objects. Target ES2022, Node16 resolution.
- **Biome only covers `pi-extension/**` and `test/**`** (see `biome.json` `files.includes`). Keep scripts/ clean anyway; 2-space indent, width 100.
- **herdr surface quirks:** screen reads use the `recent-unwrapped` snapshot with a 200-row window tail-sliced in JS (small `--lines` values truncate); pane ids are workspace-qualified (`w1:p3`), never tmux `%N`; panes are created `--no-focus`. Tested with herdr 0.9.0; >=1.0.0 is untested — compatibility is gated by version.
- **Tool access is whitelist-only.** Children launch with `--no-extensions --tools <allowlist>`; only extensions backing listed tools are re-loaded. Spawning depth is enforced via `PI_SUBAGENT_ALLOWED`. Don't weaken this. `codemode` is a pi builtin extension id (`-e builtin:codemode`) wired from the allowlist token — not a filesystem path from `getToolExtensionPath` and not package carry. Orchestration/ask tools this package registers (`subagent`, `subagent_message`, `subagents_list`, `ask_question`) stay `exposure: "model-only"` so codemode scripts cannot call them.
- **Bundled agents omit `model`** so they run on the spawning session's current model. `subagents_list` exposes the session's scoped models, and spawn-time `model` parameters are validated against them (invalid ids fall back with a warning). `subagent_agents` frontmatter both grants and restricts the spawning toolset.
- **Docs are the spec:** `README.md` describes observable behavior in detail (resume, loadout snapshots, auto-exit, fatal-stall escalation). If you change behavior, update README in the same change.
- **config.json is gitignored** (copy from `config.json.example`); the `.memory/` dir is also ignored.
- Tests use `node --test` with type-stripped TS — no test framework deps. Integration tests run `--test-concurrency=1` because they share one herdr workspace.
- Commit subjects: short capitalized imperative ("Escalate fatal startup stalls instead of waiting forever").

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
