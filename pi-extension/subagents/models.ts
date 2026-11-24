/**
 * Spawn-time model selection for sub-agents.
 *
 * The resolution order mirrors how explicit a choice each source represents:
 *
 * 1. `model` parameter on the `subagent` tool call (the calling model's runtime
 *    choice). It is either a configured tier name (resolved against the tier's
 *    candidates) or a concrete ref, validated against the session's scoped models
 *    when those are configured, so a hallucinated or copied id can never reach the
 *    child as a doomed launch;
 * 2. the agent definition's `model:` pin (a deliberate config choice, not
 *    validated — the user owns that file);
 * 3. the `models.agents` role map in herdr-subagents.json: a tier name or a
 *    concrete ref configured for this agent (a policy map, so less specific than
 *    the agent file's own pin);
 * 4. the spawning session's current model — the default-sync so a sub-agent
 *    deterministically matches its caller instead of re-rolling pi's fresh-start
 *    default (which can differ, e.g. `enabledModels[0]` outranks the saved default
 *    model);
 * 5. null — the child resolves pi's default on its own.
 *
 * Pure functions only: the extension passes in snapshots of `ctx.model`,
 * `ctx.scopedModels` and the models config, so everything here is unit-testable
 * without a mux.
 */

import type { ModelsConfig } from "./config.ts";
import { hasOwnKey } from "./config.ts";

/** A scoped model option, snapshotted from the spawning session's context. */
export interface ModelOption {
  provider: string;
  id: string;
}

/** The spawning session's currently active model, when one is set. */
export interface SessionModel {
  provider: string;
  id: string;
}

/** Which resolution source picked the model (see the module docblock). */
export type SpawnModelSource =
  | "param"
  | "param-tier"
  | "agent"
  | "role"
  | "role-tier"
  | "session"
  | "default";

export interface SpawnModelResolution {
  /** Model reference for the child's `--model` flag, or null for pi's default. */
  model: string | null;
  /**
   * Warning when a requested model or tier was rejected and the spawn fell back to
   * a later source (the spawn proceeds); null otherwise.
   */
  warning: string | null;
  /** The source that supplied `model`. */
  source: SpawnModelSource;
  /** Tier name involved in the choice (`param-tier` / `role-tier`), else null. */
  tier: string | null;
}

export interface SpawnModelParams {
  requestedModel?: string | null;
  /** The agent being spawned; selects its `models.agents` role entry. */
  agentName?: string | null;
  agentModel?: string | null;
  sessionModel?: SessionModel | null;
  scopedModels?: readonly ModelOption[] | null;
  modelsConfig?: ModelsConfig | null;
}

/** Thinking levels pi accepts as a `--model <ref>:<level>` suffix. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Split a trailing `:<level>` thinking suffix off a model reference.
 * Returns the input unchanged (suffix null) unless the suffix is a valid
 * thinking level — OpenRouter-style ids containing colons stay intact.
 */
export function splitThinkingSuffix(modelRef: string): { base: string; suffix: string | null } {
  const colonIdx = modelRef.lastIndexOf(":");
  if (colonIdx === -1) return { base: modelRef, suffix: null };
  const suffix = modelRef.slice(colonIdx + 1);
  if (!suffix || !THINKING_LEVELS.has(suffix.toLowerCase()))
    return { base: modelRef, suffix: null };
  return { base: modelRef.slice(0, colonIdx), suffix };
}

/**
 * Check a model reference (already thinking-suffix-stripped) against the
 * session's scoped models: canonical `provider/id` (case-insensitive), or a
 * bare `id` when it is unambiguous within the scope.
 */
function matchesScopedModels(base: string, scoped: readonly ModelOption[]): boolean {
  const ref = base.trim().toLowerCase();
  if (!ref) return false;
  if (scoped.some((m) => `${m.provider}/${m.id}`.toLowerCase() === ref)) return true;
  const bareIdMatches = scoped.filter((m) => m.id.toLowerCase() === ref);
  return bareIdMatches.length === 1;
}

/** Provider of a `provider/id[:level]` ref: the segment before the first `/`. */
function providerOf(modelRef: string): string {
  return splitThinkingSuffix(modelRef).base.split("/")[0]?.toLowerCase() ?? "";
}

/**
 * The `--model` argument for a child: `<ref>[:<thinking>]`. An explicit thinking
 * level replaces any valid thinking suffix already on the ref (so `x/y:high` with
 * thinking `low` gives `x/y:low`, never `x/y:high:low`). Without a thinking level the
 * ref is returned unchanged. Non-thinking colons (e.g. `a/b:free`) are kept.
 */
export function buildModelArg(model: string, thinking?: string | null): string {
  if (!thinking) return model;
  return `${splitThinkingSuffix(model).base}:${thinking}`;
}

/**
 * Pick one candidate of a tier. Candidates outside the session's scoped models are
 * dropped (when scoped models are configured); among the rest the first one on the
 * session model's provider wins, else the first remaining. The returned ref keeps
 * its thinking suffix. Null when no candidate is usable.
 */
export function resolveTier(
  candidates: readonly string[],
  sessionModel?: SessionModel | null,
  scopedModels?: readonly ModelOption[] | null,
): string | null {
  const scoped = scopedModels ?? [];
  const usable =
    scoped.length === 0
      ? [...candidates]
      : candidates.filter((c) => matchesScopedModels(splitThinkingSuffix(c).base, scoped));
  if (usable.length === 0) return null;
  if (sessionModel) {
    const provider = sessionModel.provider.toLowerCase();
    const sameProvider = usable.find((c) => providerOf(c) === provider);
    if (sameProvider) return sameProvider;
  }
  return usable[0] ?? null;
}

/**
 * Names of configured tiers that have no usable candidate under the session's
 * scoped models. Always empty when no scoped models are configured.
 */
export function tiersWithoutCandidates(
  modelsConfig: ModelsConfig | null | undefined,
  scopedModels: readonly ModelOption[] | null | undefined,
): string[] {
  const scoped = scopedModels ?? [];
  if (scoped.length === 0 || !modelsConfig) return [];
  return Object.keys(modelsConfig.tiers).filter(
    (name) => resolveTier(modelsConfig.tiers[name] ?? [], null, scoped) === null,
  );
}

/**
 * Resolve the model a sub-agent should run on, with provenance. See the module
 * docblock for the order. A rejected request (out of scope, or a tier with no usable
 * candidate) is dropped with a warning and the next source applies, so a bad guess
 * degrades to a fallback instead of a doomed spawn.
 */
export function resolveSpawnModelDetailed(params: SpawnModelParams): SpawnModelResolution {
  const requested = params.requestedModel?.trim() || null;
  const scoped = params.scopedModels ?? [];
  const tiers = params.modelsConfig?.tiers ?? {};
  const agents = params.modelsConfig?.agents ?? {};
  const role = params.agentName?.trim() || null;
  const sessionDefault = params.sessionModel
    ? `${params.sessionModel.provider}/${params.sessionModel.id}`
    : null;
  const rejections: string[] = [];

  const finish = (
    model: string | null,
    source: SpawnModelSource,
    tier: string | null,
  ): SpawnModelResolution => {
    if (rejections.length === 0) return { model, warning: null, source, tier };
    const label = describeFallback(model, source, tier, role);
    return {
      model,
      warning: `${rejections.join("; ")}; using ${label} instead.`,
      source,
      tier,
    };
  };

  // 1. The `model` parameter: a tier name, or a concrete ref.
  if (requested) {
    if (hasOwnKey(tiers, requested)) {
      const model = resolveTier(tiers[requested] ?? [], params.sessionModel, scoped);
      if (model) return finish(model, "param-tier", requested);
      rejections.push(`Tier "${requested}" has no candidate in this session's scoped models`);
    } else if (
      scoped.length === 0 ||
      matchesScopedModels(splitThinkingSuffix(requested).base, scoped)
    ) {
      return finish(requested, "param", null);
    } else {
      rejections.push(`Model "${requested}" is not in this session's scoped models`);
    }
  }

  // 2. The agent definition's own `model:` pin.
  if (params.agentModel) return finish(params.agentModel, "agent", null);

  // 3. The `models.agents` role map: a tier name or a concrete ref (not scope-validated).
  const roleTarget = role && hasOwnKey(agents, role) ? agents[role] : undefined;
  if (roleTarget !== undefined) {
    if (hasOwnKey(tiers, roleTarget)) {
      const model = resolveTier(tiers[roleTarget] ?? [], params.sessionModel, scoped);
      if (model) return finish(model, "role-tier", roleTarget);
      rejections.push(
        `Tier "${roleTarget}" for role "${role}" has no candidate in this session's scoped models`,
      );
    } else {
      return finish(roleTarget, "role", null);
    }
  }

  // 4. The spawning session's current model.
  if (sessionDefault) return finish(sessionDefault, "session", null);

  // 5. pi's default (the child resolves it).
  return finish(null, "default", null);
}

function describeFallback(
  model: string | null,
  source: SpawnModelSource,
  tier: string | null,
  role: string | null,
): string {
  switch (source) {
    case "agent":
      return `the agent's pinned model "${model}"`;
    case "role":
      return `the models.agents entry for "${role}" ("${model}")`;
    case "role-tier":
      return `tier "${tier}" for role "${role}" ("${model}")`;
    case "session":
      return model ?? "the child's pi default";
    default:
      return "the child's pi default";
  }
}

/**
 * Model and warning only, without provenance. Kept for callers that do not need
 * to know which source applied; launch uses `resolveSpawnModelDetailed`.
 */
export function resolveSpawnModel(params: SpawnModelParams): {
  model: string | null;
  warning: string | null;
} {
  const { model, warning } = resolveSpawnModelDetailed(params);
  return { model, warning };
}

/**
 * One human-readable line naming the model a spawn will run on and why, for the
 * spawn tool result. `agentName` is the spawned agent (for the role wording).
 */
export function formatModelProvenance(
  resolution: Pick<SpawnModelResolution, "model" | "source" | "tier">,
  agentName: string | null | undefined,
): string {
  const model = resolution.model ?? "pi default";
  const role = agentName?.trim() || "this agent";
  switch (resolution.source) {
    case "param":
      return `Model: ${model} (requested)`;
    case "param-tier":
      return `Model: ${model} (tier "${resolution.tier}" requested)`;
    case "agent":
      return `Model: ${model} (agent pin)`;
    case "role":
      return `Model: ${model} (role ${role})`;
    case "role-tier":
      return `Model: ${model} (tier "${resolution.tier}" via role ${role})`;
    case "session":
      return `Model: ${model} (session model)`;
    default:
      return `Model: ${model} (no session model)`;
  }
}

/**
 * Format the model-selection guidance shown in `subagents_list` output: what
 * omitting `model` does, which ids the session's scope allows, and — when the
 * models config defines any — the tiers (with what each resolves to now) and the
 * role map.
 */
export function formatModelMenu(params: {
  sessionModel?: SessionModel | null;
  scopedModels?: readonly ModelOption[] | null;
  modelsConfig?: ModelsConfig | null;
}): string {
  const base = formatBaseModelMenu(params);
  const configured = formatConfiguredModels(params);
  return configured ? `${base}\n${configured}` : base;
}

function formatBaseModelMenu(params: {
  sessionModel?: SessionModel | null;
  scopedModels?: readonly ModelOption[] | null;
}): string {
  const omitLine = params.sessionModel
    ? `- Omit \`model\` → the sub-agent runs on this session's current model (${params.sessionModel.provider}/${params.sessionModel.id})`
    : "- Omit `model` → the sub-agent resolves pi's default model";

  const scoped = params.scopedModels ?? [];
  if (scoped.length === 0) {
    return (
      "Model selection:\n" +
      `${omitLine}\n` +
      "- No scoped models are configured: any authenticated model may be requested, but omitting `model` is safest."
    );
  }

  const ids = scoped.map((m) => `${m.provider}/${m.id}`).join(", ");
  return (
    "Model selection:\n" +
    `${omitLine}\n` +
    `- Or pass one of this session's scoped models: ${ids}\n` +
    "Prefer fast, inexpensive models for simple recon/research sub-agents; reserve strong models for complex work."
  );
}

function formatConfiguredModels(params: {
  sessionModel?: SessionModel | null;
  scopedModels?: readonly ModelOption[] | null;
  modelsConfig?: ModelsConfig | null;
}): string | null {
  const tiers = params.modelsConfig?.tiers ?? {};
  const agents = params.modelsConfig?.agents ?? {};
  const tierNames = Object.keys(tiers);
  const roleEntries = Object.entries(agents);
  if (tierNames.length === 0 && roleEntries.length === 0) return null;

  const scoped = params.scopedModels ?? [];
  const lines = ["Configured model tiers (pass a tier name as `model`):"];
  for (const name of tierNames) {
    const candidates = tiers[name] ?? [];
    const now = resolveTier(candidates, params.sessionModel, scoped);
    const resolvesTo = now ? `now resolves to ${now}` : "no candidate in this session's scope";
    lines.push(`- ${name}: ${resolvesTo} (candidates: ${candidates.join(", ")})`);
  }
  if (roleEntries.length > 0) {
    const map = roleEntries.map(([agent, target]) => `${agent} → ${target}`).join(", ");
    lines.push(`Role map (models.agents): ${map}`);
  }
  return lines.join("\n");
}
