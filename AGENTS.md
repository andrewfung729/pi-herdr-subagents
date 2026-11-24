# AGENTS.md

Async subagent extension for [pi](https://github.com/earendil-works/pi), running sub-agents in Herdr app splits (the primary surface) or [herdr](https://herdr.dev) panes. TypeScript, ESM, no build step — the pi extension entry is loaded directly from source.

## Fork lineage & what this repo provides

Fork chain: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) (originated the architecture) → [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux-only) → **this repo** (Herdr app first, herdr too). History was squashed at the port commit, so `git log` cannot answer "what changed vs upstream" — **this repo's docs are the spec**. What the system provides today, summarized:

- **Herdr app and herdr surfaces:** one API in `pi-extension/subagents/herdr.ts`. The Herdr app (`HC_TERMINAL_ID`) uses `herdr-app` plus `hc` in `herdr-app.ts`; the herdr TUI (`HERDR_ENV=1`) uses `herdr pane split|run|read|close`. Each candidate must confirm its pane (`herdr pane current --current`, `herdr-app ls`); herdr is checked first because herdr panes started from an app terminal inherit `HC_TERMINAL_ID`. No confirmed pane → no tools registered. Two-column layout with vertical stacking. Herdr app sub-agent panes are launch panes (`pane.split --argv` bootstrap + file handoff, no typing). Herdr app reads are `hc read --json`; herdr reads are `recent-unwrapped`. Herdr app gate: herdr-app >=0.1.17, hc >=0.1.22, newer minor → untested warning. herdr gate: `>=0.8.2` required, skill pinned to 0.9.5 in `skills/herdr/`, verified by `check:herdr-skill`.
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
pnpm run test:surface         # surface tests — RUN IN A HERDR APP OR HERDR PANE, sequential (opens panes in your tab)
pnpm run test:integration     # full lifecycle — RUN IN A HERDR APP OR HERDR PANE, real LLM calls, slow
pnpm run check:herdr-skill    # verify skills/herdr matches pinned herdr 0.9.5
```

There is no build or bundle step. `pnpm check` is the CI gate.

## Layout

```
pi-extension/subagents/
  index.ts           # extension entry (package.json "pi.extensions"). Tool schemas, spawning,
                     # steering, registry, widget, ask_question wiring (largest file)
  herdr.ts           # surface API: create/split, send, read, poll-for-exit, runtime detection.
                     # Dispatches to the Herdr app or the herdr TUI.
  herdr-app.ts       # Herdr app backend: `herdr-app do pane.*`, `hc send|read|get|kill|rm`,
                     # launch-pane bootstrap and handoff
  session.ts         # child pi process launch: --no-extensions --tools <allowlist>, loadout snapshot
  models.ts          # pure spawn-time model resolution: param -> agent pin -> session model -> null
  packages.ts        # resolves installed pi packages' extension entries (deduped against the
                     # tool-extension map) so restricted children keep provider-registering
                     # packages (e.g. custom model providers) loaded
  activity.ts        # runtime activity snapshot files the child writes; parent polls for widget status
  status.ts          # status widget UI
  subagent-done.ts   # completion sidecars, fatal-startup-stall escalation
agents/              # bundled agent definitions (markdown + frontmatter): scout, worker, researcher
skills/herdr-app/    # bundled Herdr app skill: defers to `herdr-app --skill` / `hc --skill`
skills/herdr/        # bundled herdr CLI skill, pinned to herdr 0.9.5 (checked by scripts/check-herdr-skill.ts)
scripts/             # check-herdr-skill.ts, verify-fatal-stall.ts (NOT covered by biome config)
test/
  test.ts            # main unit tests (3k lines)
  system-prompt-mode.test.ts
  integration/       # harness.ts + herdr-surface + subagent-lifecycle (need a Herdr app or herdr pane; lifecycle needs LLM keys)
```

## Conventions & gotchas

- **ESM with explicit `.ts` import extensions** (`rewriteRelativeImportExtensions`), `strict` + `erasableSyntaxOnly` — no enums, no parameter properties; use plain types/objects. Target ES2022, Node16 resolution.
- **Biome only covers `pi-extension/**` and `test/**`** (see `biome.json` `files.includes`). Keep scripts/ clean anyway; 2-space indent, width 100.
- **herdr surface quirks:** screen reads use the `recent-unwrapped` snapshot with a 200-row window tail-sliced in JS (small `--lines` values truncate); pane ids are workspace-qualified (`w1:p3`), never tmux `%N`; panes are created `--no-focus`. Tested with herdr 0.9.5; >=1.0.0 is untested — compatibility is gated by version.
- **Herdr app surface quirks:** surface ids are `herdr-app|<pane>|<terminal>|<pid>|<launch>` (URI-encoded, opaque to callers). Sub-agent panes are launch panes (`createSurface(..., { launch: true })`): `pane.split --argv` runs a bash bootstrap that waits for `$TMPDIR/pi-herdr-subagents/launch-<token>.sh`, then execs it through `$SHELL -lic`; `sendLongCommand` hands the script over by atomic rename instead of `hc send`, and `surfaceNeedsShellReadyDelay` is false. Program exit closes the pane; `hc read` of a finished terminal still returns its screen, so pane-gone is `hc get` state `finished`/`not_found`, or a pid different from the one recorded at creation (herdr-core replaced a lost kept terminal). `hc` exits 3 not_found, 9 blocked, 11 finished. `hc send` waits up to 60 s for a person's draft — steering uses `sendCommandAsync`. `hc read` text adds `[hc] …` notes and returns screen only while working; use `--json`. Every sync `execFileSync` must pipe stderr (hc/herdr-app print JSON errors there; inherited stderr corrupts pi's TUI). `pane.split` has no cwd (launch script `cd`s). `pane.close` does not always end the terminal; cleanup also `hc kill`s and `hc rm`s. Tested with herdr-app 0.1.17 and hc 0.1.22.
- **Tool access is whitelist-only.** Children launch with `--no-extensions --tools <allowlist>`; only extensions backing listed tools are re-loaded. Spawning depth is enforced via `PI_SUBAGENT_ALLOWED`. Don't weaken this. `codemode` and `tool_search` are pi builtin extension ids (`-e builtin:codemode`, `-e builtin:tool-search`) wired from allowlist tokens — not filesystem paths from `getToolExtensionPath` and not package carry. Orchestration/ask tools this package registers (`subagent`, `subagent_message`, `subagents_list`, `ask_question`) stay `exposure: "model-only"` so codemode scripts cannot call them.
- **MCP in children is opt-in, per spawn or per allowlist.** `--no-extensions` also kills builtin MCP, so a restricted child sees no `mcp.json` servers unless it asks. The opt-in is an `mcp__<server>__*` entry in `--tools` (pi keeps MCP tools only then, and only the matching ones), which re-enables `-e builtin:mcp`. The spawn-time `mcp` parameter is only sugar: `resolveMcpSelection` turns server names into those patterns, which then live in the loadout's allowlist string (so resume needs no extra field). Unrestricted spawns already have every server and cannot be narrowed. `codemode`/`deferred` exposure still needs `codemode` or `tool_search` in the child to be callable — `launchSubagent` warns at spawn when it is missing.
- **Bundled agents omit `model`** so they run on the spawning session's current model. `subagents_list` exposes the session's scoped models, and spawn-time `model` parameters are validated against them (invalid ids fall back with a warning). `subagent_agents` frontmatter both grants and restricts the spawning toolset.
- **Docs are the spec:** `README.md` describes observable behavior in detail (resume, loadout snapshots, auto-exit, fatal-stall escalation). If you change behavior, update README in the same change.
- **User config lives outside the package:** `~/.pi/agent/herdr-subagents.json` and `<cwd>/.pi/herdr-subagents.json` (project wins; defaults in code; `herdr-subagents.example.json` is docs-only). The `.memory/` dir is gitignored.
- Tests use `node --test` with type-stripped TS — no test framework deps. Integration tests run `--test-concurrency=1` because they share one herdr workspace.
- Commit subjects: short capitalized imperative ("Escalate fatal startup stalls instead of waiting forever").

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
