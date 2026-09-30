# pi-herdr-subagents

Async subagents for [pi](https://github.com/earendil-works/pi), running in [herdr](https://herdr.dev) panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**herdr-only fork.** This project runs the async subagent workflow in [herdr](https://herdr.dev) panes: every terminal surface operation goes through the `herdr` CLI, the parent wakes once per batch of sub-agents rather than per completion, and startup failures surface as results instead of hangs. It descends from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux-only), itself forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — see [Acknowledgements](#acknowledgements). [This fork](#this-fork) describes the system as it stands today.

## How it works

`subagent()` returns immediately. The first sub-agent opens as a right split off the parent pi pane; additional concurrent sub-agents split downward from that right-hand stack. The main session therefore stays as the left column while sub-agents share the right column, and pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent. Results appear as each sub-agent finishes; concurrent autonomous results are collected into context and the final completion steers the main session once.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and display results independently as each finishes, then steer the parent once when the autonomous batch is complete.

Each spawned pane is renamed to the sub-agent's name (best-effort via `herdr pane rename`), so the herdr sidebar and tab strip show useful labels.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## This fork

Five things define this project as it stands. Each subsection is a capability you can rely on; anything not covered here works as described in the rest of this README.

### Fully herdr-native

- Every terminal operation goes through the `herdr` CLI — `herdr pane split|run|read|close`, wrapped in `pi-extension/subagents/herdr.ts`.
- Stable two-column layout: the first sub-agent splits right off the parent pane; further concurrent sub-agents stack downward in that right-hand subtree. Herdr controls the ratios; adjust with `herdr pane resize`.
- Screen reads use herdr's `recent-unwrapped` snapshot: a 200-rendered-row window, tail-sliced in JS. Output on an alternate screen that never enters the terminal stream is unrecoverable — bounded, like tmux scrollback.
- Panes carry workspace-qualified ids (`w1:p3`) and are renamed to the sub-agent's name via `herdr pane rename`, so the herdr sidebar and tab strip stay legible.
- herdr is a hard dependency: the tools and `/subagent` register only inside a herdr pane. The installed CLI is classified once per process — `>=0.8.2` required, tested with `0.9.0`, `>=1.0.0` runs with an untested-compatibility warning, and a missing or incompatible runtime raises an error notification. The bundled skill (`skills/herdr/`) is pinned to 0.9.0 and verified by `pnpm run check:herdr-skill`.

### One wake-up per batch

- Completion messages stream into the transcript as each sub-agent finishes, but the parent session's turn triggers exactly **once per autonomous batch** — launches still in flight included. Ten parallel spawns cost one interruption, not ten.

### Failures surface, never hang

- A child pi that dies before its agent loop starts (missing API key, unknown model, crashed launch script) is escalated after 60 seconds of startup stall: the watcher reads the pane screen, extracts the error text, synthesizes the child's `.exit` sidecar, closes the pane, and delivers a normal failure result to the parent.
- A pane that disappears mid-run reports `Subagent pane closed before completion` instead of waiting forever.
- Explicitly requested `name:` values are reserved synchronously, so parallel spawns reusing a name auto-suffix (`scout`, `scout-2`, …) without colliding.

### Sub-agents run on pi, with pi's defaults

- Every sub-agent process is pi — one executor everywhere.
- Bundled agents omit `model:` and run on the spawning session's current model; spawn-time `model` parameters are validated against the session's scoped models (see [Model selection](#model-selection)).
- Web tools (`web_search`, `fetch_content`, `source_check`, `get_search_content`) are provided by the [pi-web-access](https://pi.dev/packages/pi-web-access) package.
- Shell access is plain `bash`.
- Custom agents are pi frontmatter only; role folders are configured with `AGENTS.md`.

### Ships with a development setup

- pnpm workspace on the `@earendil-works/*` packages.
- `pnpm check` — Biome lint/format plus `tsgo` strict typecheck — enforced by a husky pre-commit hook.
- Three-tier tests: unit (`pnpm test`), herdr surface (`pnpm run test:surface`), full lifecycle (`pnpm run test:integration`).
- `pnpm run check:herdr-skill` verifies the bundled skill against the pinned herdr release.

See [Development](#development) for the commands.

## Tools

The extension registers its tools and `/subagent` command only when Pi starts inside a herdr pane and the `herdr` CLI is available. In a regular terminal, the package may still be loaded by Pi, but it contributes no tools or commands.

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated herdr pane (async). Model-only — not callable from codemode scripts |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished. Model-only |
| `subagents_list` | List available agent definitions. Model-only |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply. Model-only |
| `codemode` | *(in children when allowlisted)* Pi's built-in QuickJS sandbox for parallel tool calls; see [Codemode](#codemode) |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget row. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened, submitted via `herdr pane run`) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | session model | `read`, `grep`, `find`, `ls`, `codemode` | Fast read-only codebase recon |
| **researcher** | session model | `web_search`, `fetch_content`, `codemode` | Web research, synthesized into a sourced brief |
| **worker** | session model | `read`, `write`, `edit`, `bash`, `web_search`, `fetch_content`, `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

Bundled agents omit `model`, so they run on the spawning session's current model (see [Model selection](#model-selection)). Set `model:` in an override file to pin one. All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

### Model selection

Spawn-time model resolution, most explicit source first:

1. **`model` parameter** on the `subagent` call — validated against the session's scoped models (`enabledModels`) when those are configured. An out-of-scope id never reaches the child: the spawn proceeds on the next source below and the tool result includes a warning saying so.
2. **Agent `model:` pin** — a definition's frontmatter overrides the session default. Not scope-validated: the pin is a deliberate config choice owned by the user.
3. **The spawning session's current model** — the default when neither of the above is set, so a sub-agent deterministically matches its caller instead of re-resolving pi's fresh-start default (which can differ: `enabledModels[0]` outranks the saved default model).
4. **pi's default** — only when the spawning session has no active model.

`subagents_list` lists the exact usable ids in its "Model selection" section. Thinking levels still come from the agent's `thinking:` frontmatter; a `model: provider/id:level` suffix applies only when the definition doesn't pin `thinking:`.

### Virtual models

Virtual model ids (e.g. a router-backed `provider/auto`) only resolve in processes that loaded the extension that registered them. Restricted children carry **installed pi packages** (see [Tool access control](#tool-access-control)), so a virtual model whose registrar is an installed package works in the child. A bare parent `-e` router extension that is **not** an installed package is **not** discovered under `--no-extensions` and is **not** carried — the child can hit `Model "..." not found` and fatal-stall.

Suggested pins while virtual-model carry of bare `-e` routers is not implemented:

| Role | Suggested model | Why |
| ---- | --------------- | --- |
| Parent / orchestrator | Virtual router ok | Full extension discovery; registrar is loaded |
| scout / researcher | Cheap physical id | Fast recon/research; avoid inheriting an unresolved virtual id |
| worker | Stronger physical id, or omit to inherit the session model | Needs quality for edits; pin explicitly if the parent uses a virtual model |

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: provider/model-id
thinking: medium
tools: read, edit, write, bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model (`provider/id`). Overrides the session default; a spawn-time `model` parameter still wins |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Pi builtin extension: `codemode` (auto-loads `-e builtin:codemode`). Extension-backed: `web_search`, `fetch_content`, `source_check`, `get_search_content` (from the [pi-web-access](https://pi.dev/packages/pi-web-access) package). Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Codemode

Requires **pi >= 0.99** (see [Requirements](#requirements)). Pi's built-in `codemode` tool is a QuickJS sandbox that can call other tools in parallel and return only script output.

**How it reaches a restricted child.** Listing `codemode` in an agent's `tools:` allowlist is enough: the shared sandbox argv builder adds `-e builtin:codemode` once alongside `--no-extensions` and `--tools`. Resume re-derives the same flag from the stored allowlist string — no extra loadout field. Allowlists without `codemode` do not load the builtin; unrestricted (null) loadouts stay unrestricted.

**What scripts cannot call.** This package registers `subagent`, `subagent_message`, `subagents_list`, and `ask_question` with `exposure: "model-only"`. The model still calls them directly; codemode scripts cannot. That blocks a script from fanning out unbounded `subagent` spawns in one `Promise.all`, or blocking mid-script on `ask_question`.

**Settings trap — `codemode.mode: "only"`.** Children read the same settings as the parent (shared config dir, and project `.pi/settings.json` when the child runs in the same cwd). `codemode.mode: "only"` hides direct tool declarations from the model and defeats the bundled worker's guidance that edits stay on direct `edit` / `write`. Keep `codemode.mode` at `on` (the default) when relying on bundled agents.

**Cost note.** Codemode scripts can call `models.classify()` using the session's credentials, which adds model cost beyond the sub-agent's own turns.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly, plus every installed pi package's extension entries (see below). There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

**Installed packages are carried into every restricted sub-agent.** Extensions that register model providers via `pi.registerProvider` (e.g. the `pi-commandcode-provider` package) bundle no tools, so without special handling a sub-agent pinned to one of their models would die at startup with `Error: Model "..." not found` — the provider simply wouldn't exist in the child process. At spawn (and resume) time the extension therefore resolves the `packages` entries in the global and project settings to their on-disk extension entry files (`npm/node_modules/...`, `git/...`, or local paths, with manifest/auto-discovery entry resolution mirroring pi) and loads them explicitly via `-e`. These packages are user-trusted (they load in every normal pi session) and their custom tools remain gated by the child's `--tools` allowlist, so the whitelist-only guarantee is unaffected. Missing or unparseable package sources are skipped silently — spawning never fails because of one.

**The two `-e` sources merge per package, never concatenate.** A tool's backing extension and a package manifest entry can resolve into the same package (the web-tool map hardcodes `pi-web-access/index.ts` while that package's manifest declares `["./dist"]`), and the tool map always points at the GLOBAL install while the carried entries may hold another scope's install of the same package. Loading one package twice registers its tools twice — a fatal extension conflict that kills the child at startup. `resolvePackageExtensions` therefore dedupes the two settings scopes by package identity the way pi does (npm name, git host/path; project install wins, an `autoload: false` install contributes nothing), and `mergeExtensionPaths` drops any tool-mapped `index.ts`/`index.js` file whose package is already carried. Tool-mapped files outside that pattern are always kept.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (AGENTS.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← AGENTS.md, .pi/…
    └── sre/             ← AGENTS.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

Relative `cwd` values resolve against the **parent session's working directory**
(`ctx.cwd`), not the node process cwd — the two differ when pi runs hosted (e.g.
under pi-web, where the process cwd is the host package directory). Absolute
paths are used as-is.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

### Fatal startup stalls

A sub-agent whose `pi` process fails before its agent loop starts (missing provider API key, unknown model, a launch script that dies instantly) never fires `agent_start`/`agent_end`, so it would otherwise sit at its interactive prompt forever and the parent would wait forever on a silent "stalled" status. The watcher escalates this case: when an autonomous sub-agent has been stalled at startup for 60 seconds (`FATAL_STALL_AFTER_SECONDS`) with no agent activity ever recorded, it reads the pane screen, extracts the error text (e.g. `Error: No API key found for <provider>.`), synthesizes the child's `.exit` error sidecar, closes the pane, and delivers a normal failure result (`Sub-agent "x" failed (provider/agent error)` with the underlying message) to the parent. Interactive sub-agents are exempt — the user drives those panes directly.

If your shell startup is legitimately slower than the threshold (e.g. heavy `direnv` hooks in the child cwd), raise `PI_SUBAGENT_SHELL_READY_DELAY_MS` so the launch command is sent later, or spawn the sub-agent with a working environment. A pane that disappears mid-run (closed from the herdr UI, or a herdr restart) is reported to the parent as `Subagent pane closed before completion` instead of hanging the wait.

## Requirements

- [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) **>= 0.99** — required for built-in `codemode` and tool `exposure` (peer dependency floor)
- [herdr](https://herdr.dev) >=0.8.2 — tested with 0.9.0; versions >=1.0.0 produce an untested-compatibility warning

```bash
herdr          # start or attach to the persistent session
# then, inside a pane:
pi
```

The first subagent pane is created with `herdr pane split --current --direction right --cwd <session-cwd> --no-focus` (the parent session's working directory, so a hosted pi process still lands the pane in the user's project). Additional concurrent panes target the newest subagent pane with `--direction down`, keeping the parent on the left and the subagent stack on the right without stealing focus.

## Development

```bash
pnpm install
pnpm check                    # biome (lint + format) + tsgo typecheck
pnpm test                     # unit tests (no multiplexer needed)
pnpm run check:herdr-skill    # compare the bundled skill with pinned Herdr 0.9.0
pnpm run test:surface         # herdr surface tests (run inside herdr)
pnpm run test:integration     # full lifecycle tests (real LLM calls, run inside herdr)
```

Checks follow the pi monorepo's setup: [Biome](https://biomejs.dev) for lint/format and the native TypeScript compiler (`tsgo`, strict mode) for typechecking, wired into a husky pre-commit hook.

## Acknowledgements

- [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) — the tmux-only fork this repo was ported from.
- [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
