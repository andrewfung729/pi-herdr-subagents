/**
 * Spawn-time model selection for sub-agents.
 *
 * The resolution order mirrors how explicit a choice each source represents:
 *
 * 1. `model` parameter on the `subagent` tool call (the calling model's
 *    runtime choice) — validated against the session's scoped models when
 *    those are configured, so a hallucinated or copied id (docs examples,
 *    other providers) can never reach the child as a doomed launch;
 * 2. the agent definition's `model:` pin (a deliberate config choice, not
 *    validated — the user owns that file);
 * 3. the spawning session's current model — the default-sync so a sub-agent
 *    deterministically matches its caller instead of re-rolling pi's
 *    fresh-start default (which can differ, e.g. `enabledModels[0]` outranks
 *    the saved default model);
 * 4. null — the child resolves pi's default on its own.
 *
 * Pure functions only: the extension passes in snapshots of `ctx.model` and
 * `ctx.scopedModels`, so everything here is unit-testable without a mux.
 */

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

export interface SpawnModelResolution {
  /** Model reference for the child's `--model` flag, or null for pi's default. */
  model: string | null;
  /**
   * Warning when a requested model was rejected as out of scope and fell back
   * (the spawn proceeds); null otherwise.
   */
  warning: string | null;
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

/**
 * Resolve the model a sub-agent should run on. See the module docblock for
 * the resolution order. When scoped models are configured and the requested
 * reference is not one of them, the request is dropped with a warning and the
 * next source in the chain applies — a bad guess degrades to the session
 * default instead of a doomed spawn.
 */
export function resolveSpawnModel(params: {
  requestedModel?: string | null;
  agentModel?: string | null;
  sessionModel?: SessionModel | null;
  scopedModels?: readonly ModelOption[] | null;
}): SpawnModelResolution {
  const requested = params.requestedModel?.trim() || null;
  const sessionDefault = params.sessionModel
    ? `${params.sessionModel.provider}/${params.sessionModel.id}`
    : null;

  if (requested) {
    const scoped = params.scopedModels ?? [];
    if (scoped.length > 0) {
      const { base } = splitThinkingSuffix(requested);
      if (!matchesScopedModels(base, scoped)) {
        const fallback = params.agentModel ?? sessionDefault;
        const fallbackLabel = params.agentModel
          ? `the agent's pinned model "${params.agentModel}"`
          : (fallback ?? "the child's pi default");
        return {
          model: fallback,
          warning: `Model "${requested}" is not in this session's scoped models; using ${fallbackLabel} instead.`,
        };
      }
    }
    return { model: requested, warning: null };
  }

  if (params.agentModel) return { model: params.agentModel, warning: null };
  return { model: sessionDefault, warning: null };
}

/**
 * Format the model-selection guidance shown in `subagents_list` output: what
 * omitting `model` does, and which ids the session's scope allows.
 */
export function formatModelMenu(params: {
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
