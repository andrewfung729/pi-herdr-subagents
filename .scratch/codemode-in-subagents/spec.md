# Spec: Codemode in herdr subagents

Status: ready-for-agent

## Problem Statement

Pi 0.99+ ships a built-in `codemode` tool (QuickJS sandbox that calls other tools in parallel and returns only script output). Package users of this herdr subagents extension cannot use it inside restricted children today: children launch with `--no-extensions` and a tool allowlist, and pi's `--no-extensions` also disables built-in extensions. The sandbox builder only re-enables *file-backed* tool extensions, and `codemode` is neither a builtin file tool nor a package entry. Without an explicit `-e builtin:codemode`, naming `codemode` in an agent allowlist silently yields no `codemode` tool in the child (nothing registers it, so the allowlist entry matches nothing).

Once codemode is reachable, a second problem appears: pi 0.99 makes every active tool with the default `direct` exposure callable from codemode scripts (`ctx.executeTool`). That includes this extension's orchestration and ask tools (`subagent`, `subagent_message`, `subagents_list`, `ask_question`). A script could fan out many `subagent` spawns in one `Promise.all`, or block mid-script on `ask_question` waiting for the orchestrator. Pi's own docs say tools that orchestrate other tools or ask the user should use `exposure: "model-only"` (declared to the model, never callable from scripts).

Separately, users who run virtual models on the parent session have no clear contract for what subagents inherit: virtual model ids only resolve in processes that loaded the registering extension, and restricted children do not discover bare `-e` routers. That is a documentation/trap problem for this pass, not a carry feature.

Default bundled agents (scout, researcher, worker) also do not list `codemode`, so even after the mechanism exists, out-of-the-box agents would not benefit unless frontmatter and short role guidance are updated.

The package still declares a pre-0.99 peer on pi, which does not match a product that defaults agents onto codemode.

## Solution

Ship a focused product change so restricted subagents can use pi codemode end-to-end:

1. When a subagent loadout tool allowlist includes `codemode`, the shared sandbox argv builder adds `-e builtin:codemode` (once), alongside existing `--no-extensions`, `--tools`, tool-backed `-e` paths, and carried package extensions.
2. The four tools this package registers — `subagent`, `subagent_message`, `subagents_list`, `ask_question` — declare `exposure: "model-only"`, so the model still calls them directly but codemode scripts cannot.
3. Bundled scout, researcher, and worker agents include `codemode` in their `tools:` frontmatter, with short role-specific body guidance (scout/researcher: prefer parallel gather + distill; worker: codemode for probe/parallel/filter only — edits stay direct).
4. Unit tests lock the argv contract at the existing `applySandboxToParts` seam, the `model-only` exposure of the four tools, and bundled agent defaults including `codemode`.
5. README documents codemode-in-child, calls out `pi >= 0.99`, documents that orchestration/ask tools are not script-callable, documents the `codemode.mode: "only"` trap, and documents virtual-model traps plus suggested physical pins — without implementing virtual-model extension carry.
6. AGENTS.md gets a one-line maintainer seam note: `codemode` needs `-e builtin:codemode`, not a filesystem extension path; tools this package registers that orchestrate or ask stay `model-only`.
7. Peer dependency on `@earendil-works/pi-coding-agent` (and pi-tui, kept paired) becomes `>=0.99.0`; devDependencies become `^0.99.1`. Package `version` field stays `0.1.0` for this change (no release bump in this work).

Resume continues to work without loadout schema changes: replaying the allowlist string re-derives the builtin `-e`.

## User Stories

1. As a package user, I want scout to have `codemode` by default, so that codebase recon can parallelize grep/read/find and return a distilled map with fewer model rounds.
2. As a package user, I want researcher to have `codemode` by default, so that web search and fetches can run in parallel and large pages can be filtered before they hit the model context.
3. As a package user, I want worker to have `codemode` by default, so that multi-file probing and output filtering are available without giving up direct edit/write.
4. As a worker agent, I want guidance that edits stay on direct tools, so that I do not route all file mutations through sandbox scripts.
5. As a scout agent, I want guidance to prefer codemode for parallel gather, so that I actually use the new tool instead of ignoring it.
6. As a researcher agent, I want guidance to prefer codemode for parallel research and distillation, so that briefs stay sourced and compact.
7. As a package user defining a custom agent, I want listing `codemode` in `tools:` to make the tool actually available in the child, so that allowlists are truthful.
8. As a package user, I want spawn and resume to apply the same codemode wiring, so that a resumed subagent does not lose codemode or drift unrestricted.
9. As a package maintainer, I want a single sandbox argv path to own builtin extension flags, so that launch and resume cannot diverge.
10. As a package maintainer, I want unit tests that fail if `codemode` stops producing `-e builtin:codemode`, so that regressions are caught without herdr or LLM keys.
11. As a package maintainer, I want unit tests that fail if bundled agents drop `codemode` from defaults, so that product intent stays locked.
12. As a package user on pi 0.99+, I want install peers to express that requirement, so that older pi is not silently expected to work with default codemode agents.
13. As a package user still on older pi, I want peer metadata to signal incompatibility rather than a new runtime version gate inside this extension, so that failure mode stays at install/tooling time (existing child startup failure paths remain if someone forces an old binary).
14. As a package user, I want README to state `pi >= 0.99` near requirements/codemode docs, so that I know the floor before debugging child startup.
15. As a package user running a virtual model on the parent, I want README to warn that children only resolve virtual ids if the registering extension is loaded in the child (e.g. installed pi package already carried), so that I do not inherit `provider/auto` and hit model-not-found stalls.
16. As a package user, I want a short suggested pin table (scout cheap physical, worker stronger or session, parent may use virtual), so that I can configure models without waiting for virtual-model carry.
17. As a package user, I want unrestricted / fork-style loadouts (null allowlist) to remain unrestricted and not suddenly inject codemode flags, so that existing fork behavior is preserved.
18. As a package user, I want allowlists without `codemode` to not load `builtin:codemode`, so that whitelist-only stays exact.
19. As a package user, I want `tool_search` and MCP-in-child to remain unavailable unless a future change adds them, so that this release does not expand the trust/surface area.
20. As a package user, I want `subagent`, `subagent_message`, and `subagents_list` to be callable only by the model directly, never from codemode scripts, so that a script cannot fan out an unbounded number of panes in one call.
21. As a package user, I want `ask_question` to be callable only by the model directly, so that a codemode script cannot block mid-execution waiting on the orchestrator.
22. As an extension author maintaining this repo, I want AGENTS.md to mention the codemode builtin seam and the `model-only` rule, so that agents editing sandbox or tool-registration code do not treat codemode like `read`/`bash` or a package path, and do not re-expose orchestration tools to scripts.
23. As a package user overriding an agent without `codemode`, I want that override to stick (no forced injection of the tool name into allowlists beyond what frontmatter/build allowlist already does), so that stricter agents remain possible.
24. As a package user, I want loadout sidecars to keep working without a new schema field, so that old and new snapshots that already store `toolAllowlist` strings remain replayable.
25. As a developer of this repo, I want `pnpm test` unit coverage only for this feature, so that CI stays free of herdr/LLM requirements.
26. As a package user reading docs, I want tools tables and bundled-agent tables updated to list `codemode` where appropriate, so that documentation matches runtime defaults.
27. As a package user, I want custom agents that only add `codemode` alongside existing tools to get the builtin extension automatically, so that docs examples stay minimal.
28. As a package user with `codemode.mode: "only"` in my global settings, I want README to warn that children read the same settings (shared config dir, and project `.pi/settings.json` when the child runs in the same cwd), which hides direct tool declarations and defeats the worker's "edits stay direct" guidance, so that I know to keep `codemode.mode` at `on` when relying on bundled agents.
29. As a maintainer, I want no widget changes for physical-vs-virtual dispatch in this work, so that scope stays on tool availability.
30. As a maintainer, I want no change to fatal-stall timing or behavior beyond whatever falls out of correct argv, so that failure escalation remains the existing contract.
31. As a user who installs this package, I want package `version` left at `0.1.0` for this implementation pass, so that publishing/semver can be a separate deliberate decision later.

## Implementation Decisions

- **Scope name:** codemode-in-subagents (B-only from design grilling). Virtual model support is documentation-only.
- **Primary module:** the subagents extension sandbox/launch path that turns a `SubagentLoadout` into pi CLI argv parts (shared by initial spawn and resume).
- **Builtin mapping:** treat `codemode` as a special allowlist token that contributes the extension specifier `builtin:codemode` via `-e`, not as a filesystem path from `getToolExtensionPath`, and not via `registerToolExtension`. Expected shape is a single guarded push inside the existing `if (loadout.toolAllowlist)` block of `applySandboxToParts`, outside the `mergeExtensionPaths` call (the builtin id is not a package path). A single `includes("codemode")` check is naturally idempotent for duplicate allowlist entries.
- **No ordering work:** pi loads file-backed `-e` paths first and `builtin:` paths second regardless of argv order, and a built-in `codemode` is `replaceable` — if a carried package registers its own `codemode` tool, pi drops the built-in. No ordering or conflict handling is needed here.
- **No new loadout fields:** do not add `builtinExtensions` or similar. Presence of `codemode` in `toolAllowlist` is sufficient to re-derive the flag on resume.
- **Non-codemode allowlists:** unchanged; no builtin codemode flag.
- **Null allowlist (unrestricted):** unchanged; do not inject codemode or `--no-extensions`.
- **`getToolExtensionPath`:** leave unchanged (returns undefined for `codemode`). Do not pretend `builtin:codemode` is a file that `existsSync` must find.
- **Tool exposure:** add `exposure: "model-only"` to the `pi.registerTool` definitions of `subagent`, `subagent_message`, `subagents_list` (`index.ts`) and `ask_question` (`subagent-done.ts`). Keep everything else about their registration unchanged. Older pi ignores the field, but the peer floor makes that moot.
- **Do not** special-case `tool_search`, `builtin:tool-search`, `builtin:mcp`, or MCP server config for children.
- **Bundled agents:** update scout, researcher, and worker frontmatter `tools:` to include `codemode` (preserve existing tools and worker `subagent_agents`).
- **Agent body copy:** short, per-agent (not a shared include):
  - scout / researcher: prefer codemode for parallel gather and distillation; final message stays a structured map / sourced brief.
  - worker: use codemode for multi-file probe, parallel reads, and filtering large command output; perform code changes with direct `edit` / `write` (and direct `bash` when appropriate for builds/tests).
- **Dependencies:**
  - peerDependencies: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` → `>=0.99.0` (codemode builtin ships in 0.99.0).
  - devDependencies: same two packages → `^0.99.1` (bounded range; no open-ended `>=` for dev installs).
  - Do not bump package `version`.
  - Supply-chain note: 0.99.0 and 0.99.1 were both published 2026-09-29. Do not merge before these have been public ≥7 days (2026-10-06).
  - Release-age policy: a trial install on 2026-09-30 made pnpm auto-append 8 `@earendil-works/*@0.99.1` entries to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Do not commit those entries. If `pnpm add` writes them, revert that hunk and wait until the release clears the minimum age instead of excluding it.
  - Build-script approval: the bump pulls in `esbuild@0.28.2`, whose build script pnpm blocks (`ERR_PNPM_IGNORED_BUILDS`) and marks with an `esbuild: set this to true or false` placeholder under `allowBuilds`. Until it is set, `pnpm check` / `pnpm test` fail at pnpm's pre-run install check. This is a security-policy choice: the implementing agent must escalate it to a human, not pick a value.
  - TypeBox: no migration. Trial upgrade confirmed the existing `@sinclair/typebox` imports typecheck against 0.99 types (typebox 1.x `TSchema` is structural; `Static` inference still works), and pi 0.99 aliases `@sinclair/typebox` to its bundled typebox 1.x at runtime. Switching imports to `typebox` is optional cleanup and out of scope.
  - `exposure` requires the bump: the field exists in 0.99 types (`ToolExposure`) and not in 0.87 or earlier, so the exposure change and the devDependency bump land together.
- **Runtime version gate:** none beyond peer metadata and docs. No spawn-time pi version parser for this feature.
- **Docs:**
  - README: requirements floor `pi >= 0.99`; tools / bundled agent tables; short codemode section (child needs allowlist entry + automatic builtin `-e`; `subagent*` / `ask_question` are `model-only`, not callable from scripts; `codemode.mode: "only"` in shared settings also applies to children and hides direct tool declarations; codemode scripts can call `models.classify()` using the session's credentials, which adds cost); virtual models section = traps (child must have registrar loaded — installed packages are carried; bare parent `-e` router is not) + suggested pin table; do not promise virtual carry roadmap.
  - AGENTS.md: one maintainer note under conventions/gotchas that `codemode` is a pi builtin extension id (`-e builtin:codemode`) wired from the allowlist, distinct from file-backed tools and package carry; and that this package's orchestration/ask tools are registered `model-only`.
- **Export/test surface:** keep using existing `__test__` exposure of `applySandboxToParts`, `loadAgentDefaults`, `buildSubagentToolAllowlist`, and `registerExtension`. Do not add exports.
- **Formatting/check:** `pnpm check` and unit tests must pass.

## Testing Decisions

- **Good tests** assert external behavior of the sandbox argv seam, registered tool definitions, and bundled defaults — not private helper names, not implementation branch coverage for its own sake, not LLM behavior, not herdr pane lifecycle.
- **Highest seam (agreed):** `applySandboxToParts` (already the single source of truth for spawn + resume sandbox flags; already unit-tested).
- **Cases for `applySandboxToParts`:**
  1. `toolAllowlist` includes `codemode` → parts include exactly one `-e` paired with `builtin:codemode` (account for existing `shellEscape` quoting in assertions). Build the allowlist with `codemode` listed twice so the same case covers idempotency.
  2. `toolAllowlist` is ordinary tools only (e.g. `read,bash`) → parts must not include `builtin:codemode`.
  3. `toolAllowlist` is `null` → still omits restriction flags; must not add codemode builtin.
- **Tool exposure:**
  4. Using the existing mock extension APIs (`createMockExtensionApi` + `registerSubagentsForTest`, and `setupSubagentExtension` for `subagent-done.ts`), `subagent`, `subagent_message`, `subagents_list`, and `ask_question` each register with `exposure: "model-only"`.
- **Bundled defaults (existing `loadAgentDefaults`):**
  5. scout, researcher, worker each load with `tools` including `codemode`.
- **Prior art:** unit tests in the main unit suite that already call `__test__.applySandboxToParts`, `__test__.getToolExtensionPath`, `__test__.loadAgentDefaults`, and inspect `registeredTools` from the mock extension API.
- **Not in this spec's test plan:** surface tests, integration/LLM tests, asserting README contents, asserting AGENTS.md contents, executing codemode scripts, verifying the pi binary accepts `builtin:codemode` (verified manually against pi 0.99.1 source: `resource-loader.js` resolves `builtin:<name>` and errors on unknown names; the peer floor documents the requirement).

## Out of Scope

- Virtual model extension carry into children; spawn-time validation that a virtual id resolves in the child; widget display of selected vs physical dispatch models.
- `tool_search` / `builtin:tool-search` wiring.
- MCP-in-child (`builtin:mcp`, mcp.json trust, exposure modes).
- Per-child overrides of `codemode.mode` / `codemode.inlineBudget` (documented as a trap only).
- Rate-limiting or capping concurrent spawns (moot once spawning tools are `model-only`).
- Runtime pi version detection/refusal beyond peer + docs.
- Package semver bump, changelog release notes, npm publish.
- Surface/integration/real-LLM test additions for codemode.
- New loadout sidecar schema versioning.
- Replacing herdr subagent orchestration with in-process codemode.
- Classifier / Jev router bundling inside this package.

## Further Notes

- Design origin: conversation on benefiting from pi codemode + virtual models, then grilling consensus (product PR, B-only, all three bundled agents, hard peer floor 0.99.0, docs for virtual traps + pins, unit-only tests, no package version bump). Spec review added: `model-only` exposure for orchestration/ask tools, bounded devDependency range, `codemode.mode: "only"` trap, removal of the ordering concern.
- Trial upgrade (throwaway copy, 2026-09-30): baseline on 0.84.3 passes `pnpm check`. After bumping devDependencies to `^0.99.1` and adding `exposure: "model-only"` to the four tools, biome + tsgo pass and unit tests pass (201/201 + 1/1), run via `node_modules/.bin` because of the esbuild `allowBuilds` placeholder above.
- Verified against pi 0.99.1 source: `--tools` filters the tool registry before codemode computes its callable set, so scripts can never reach tools outside the child allowlist — whitelist-only holds.
- Domain vocabulary: loadout, allowlist, default-deny, `--no-extensions`, herdr child pane, bundled agents (scout/researcher/worker), package carry, spawn vs resume — match existing README/AGENTS.md language.
- Codemode landed in pi **0.99.0**; do not document an older floor.
- Success is mechanism + exposure + defaults + docs + unit locks; success is not measured by model choosing codemode optimally in production (guidance only improves odds).
- When implementing, prefer the smallest diff in the sandbox builder, tool registrations, and agent markdown; avoid drive-by refactors of `index.ts`.
