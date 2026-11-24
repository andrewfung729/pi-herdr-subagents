# Subagent model tiers (role → tier → concrete model)

Status: ready-for-agent

## Problem

Every sub-agent without an explicit `model` runs on the spawning session's model. Cheap recon
(scout, researcher) then pays for the strong model, or a cheap parent starves the worker. Pinning
`model:` in agent markdown hard-codes one provider and must be edited whenever the user switches
providers. The parent LLM can pass `model`, but must spell exact `provider/id` strings.

## Goal

A user-level policy in `herdr-subagents.json` that maps **roles → tiers → candidate model lists**,
resolved at spawn time, preferring the session's provider. The parent LLM may also request a tier
by name. No behavior change when the `models` section is absent.

## Config shape

`~/.pi/agent/herdr-subagents.json` and `<cwd>/.pi/herdr-subagents.json` (project wins, merged
per key: project `tiers.fast` replaces global `tiers.fast`; project `agents.scout` replaces
global `agents.scout`; other keys are kept).

```json
{
  "status": { "enabled": true },
  "models": {
    "tiers": {
      "fast":   ["anthropic/claude-haiku-5-5", "openai/gpt-x-mini"],
      "strong": ["anthropic/claude-opus-5-5:high", "openai/gpt-x"]
    },
    "agents": { "scout": "fast", "researcher": "fast", "worker": "strong" }
  }
}
```

- `tiers`: object; key = tier name (free-form, must match `/^[A-Za-z0-9_-]+$/`, so it never
  contains `/` or `:`); value = non-empty array of non-empty strings, each a model ref
  `provider/id` optionally suffixed `:<thinking>`. A suffix that *looks* like a thinking level
  but is not valid (e.g. `:hgih` when the part before it has a `/` and the suffix is all letters)
  is NOT required to be detected — keep it simple: only validate that each candidate contains `/`.
- `agents`: object; key = agent name; value = either a tier name defined in `tiers` or a
  concrete model ref (contains `/`). A value that is neither is a structural error.
- Unknown keys under `models` are a structural error.

## Resolution order (models.ts `resolveSpawnModel`)

1. `model` param. If it exactly matches a configured tier name → resolve the tier (below).
   Otherwise → existing behavior (scope validation of a concrete ref). If the tier resolves to no
   candidate → warning, continue at step 2.
2. Agent frontmatter `model:` pin (unchanged; not validated).
3. **New:** `models.agents[<agent name>]` (only when an agent name is given). Tier name → resolve
   tier; no candidate → warning, continue at step 4. Concrete ref → use as-is (user-owned config,
   not scope-validated, same policy as frontmatter pins).
4. Session model (unchanged).
5. null → pi default (unchanged).

Frontmatter beats config on purpose: a per-agent file is a more specific choice than a policy map.

### Tier resolution (pure function `resolveTier`)

Input: candidates, session model, scoped models.
1. If scoped models are non-empty, drop candidates whose base ref (thinking suffix stripped) does
   not match the scope (reuse `matchesScopedModels` semantics).
2. Among the rest, pick the first whose provider equals the session model's provider.
3. Else pick the first remaining.
4. Else return null (caller warns and falls through).

The returned ref keeps its thinking suffix. Thinking precedence is unchanged: agent `thinking:`
frontmatter still wins (do not modify the existing suffix/thinking handling in index.ts).

### Resolution provenance

Extend `SpawnModelResolution` with `source: "param" | "param-tier" | "agent" | "role" |
"role-tier" | "session" | "default"` and `tier: string | null`. Surface it in the spawn tool
result text as one line, e.g. `Model: anthropic/claude-haiku-5-5 (tier "fast" via role scout)`,
next to where `modelWarning` is already surfaced (index.ts ~2264). Keep existing warnings.

## Validation

- **Structural** (pure `parseModelsConfig(raw, source)` → `{ config, errors: string[] }`):
  shape, tier-name pattern, candidates contain `/`, `agents` values reference a defined tier or a
  concrete ref. If any error: the whole `models` section is ignored (config = empty) and errors
  are returned — **never throw** for `models` schema problems. Invalid JSON keeps the existing
  throwing behavior of `readOptionalJsonFile` (shared file).
- `status.ts`: root `rejectUnsupportedKeys` currently allows only `status` — it must also allow
  `models`, otherwise adding `models` breaks status loading.
- **Unknown agent names** in `agents` are fine (custom agents may appear later). No warning needed.
- **When**: models config is re-read **at every spawn** (cheap; edits apply without restart) and
  also at `session_start`. At `session_start`, `ctx.ui.notify(..., "warning")` once with the
  structural errors (if any), plus one soft line per tier that has no candidate under the current
  scoped models (only when scoped models are non-empty). Never check API keys / registry.

## Code layout

- New `pi-extension/subagents/config.ts`: shared `readOptionalJsonFile`, config paths
  (`getConfigPaths({cwd, agentDir})`), `loadModelsConfig({cwd, agentDir})` returning
  `{ config: ModelsConfig, errors: string[] }`, and `parseModelsConfig`. Move
  `readOptionalJsonFile` there from status.ts and import it back in status.ts (no behavior change).
- `models.ts`: `resolveTier`, extended `resolveSpawnModel` (new optional params
  `agentName`, `modelsConfig`), `formatModelMenu` extended to list tiers with what each
  resolves to right now and the role → tier map. All pure.
- `index.ts`: `launchSubagent` loads models config with `ctx.cwd` and passes it +
  `params.agent`; subagents_list menu (~2376) passes it too; `session_start` notify; `model`
  param schema description mentions tier names. Resume path must keep using the snapshotted
  concrete model (do not re-resolve on resume).
- `README.md`: update "Model selection" (new step 3, tier names in the param, config example,
  validation behavior) and the "Virtual models" suggested-pins note (tiers with physical ids solve
  it). Update the "Bundled agents" paragraph.
- `herdr-subagents.example.json`: add a `models` example.

## Tests (test/test.ts, node --test)

- parseModelsConfig: valid; bad tier name; empty candidate list; candidate without `/`; agents
  value referencing undefined tier; unknown key → errors and empty config, no throw.
- loadModelsConfig: global + project merge per key; missing files → empty, no errors.
- loadStatusConfig still works with a `models` key present.
- resolveTier: scope filter; same-provider preference; fallback to first; none → null; suffix kept.
- resolveSpawnModel: param tier; param tier with no candidate falls to agent pin / role / session
  with warning; frontmatter pin beats role map; role tier; role concrete ref; role absent →
  session; no models config → identical results to current tests (existing tests unchanged and
  passing); provenance `source`/`tier` correct in each case.
- formatModelMenu shows tiers and role map when configured; unchanged output when not.

## Out of scope

Auto-routing by task difficulty; carrying bare `-e` virtual-model routers into children; built-in
default role map.

## Done when

`pnpm check` and `pnpm test` pass; README + example updated; no commit.
