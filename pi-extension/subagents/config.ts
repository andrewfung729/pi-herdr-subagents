import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Config filename under the agent dir and project `.pi/`. */
export const CONFIG_FILE_NAME = "herdr-subagents.json";

/** Tier names must be safe as a bare `model` parameter value (no `/` or `:`). */
const TIER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODELS_KEYS = ["tiers", "agents"];

/**
 * The `models` section of the sidecar config: tier name → candidate model refs in
 * preference order, and agent (role) name → tier name or a concrete `provider/id` ref.
 */
export interface ModelsConfig {
  tiers: Record<string, string[]>;
  agents: Record<string, string>;
}

export interface ConfigLocationOptions {
  /** Project working directory; when set, also reads `<cwd>/.pi/herdr-subagents.json`. */
  cwd?: string;
  /** Override agent dir (tests). Defaults to `getAgentDir()`. */
  agentDir?: string;
}

export interface ModelsConfigResult {
  config: ModelsConfig;
  errors: string[];
}

export function emptyModelsConfig(): ModelsConfig {
  return { tiers: {}, agents: {} };
}

/** Config files in merge order: agent dir first, project `.pi/` last (project wins). */
export function getConfigPaths(options: ConfigLocationOptions = {}): string[] {
  const agentDir = options.agentDir ?? getAgentDir();
  const paths = [join(agentDir, CONFIG_FILE_NAME)];
  if (options.cwd) {
    paths.push(join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
  }
  return paths;
}

/** Read and parse a config file; null when it does not exist. Invalid JSON throws. */
export function readOptionalJsonFile(configPath: string): unknown | null {
  let rawConfig: string;
  try {
    rawConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${configPath}: ${detail}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Own-property check that is safe for arbitrary (e.g. `__proto__`) keys. */
export function hasOwnKey(record: object | null | undefined, key: string): boolean {
  return record != null && Object.hasOwn(record, key);
}

/**
 * Shape-only validation of a parsed root object's `models` section. Cross-references
 * (agents → tiers) need the merged tier set, so they are checked separately.
 */
function parseModelsSection(rawRoot: unknown, source: string): ModelsConfigResult {
  const errors: string[] = [];
  const fail = (message: string): ModelsConfigResult => {
    errors.push(`Invalid models config in ${source}: ${message}`);
    return { config: emptyModelsConfig(), errors };
  };

  if (!isPlainObject(rawRoot)) return fail("root must be an object");
  if (rawRoot.models === undefined) return { config: emptyModelsConfig(), errors };
  const models = rawRoot.models;
  if (!isPlainObject(models)) return fail("models must be an object");

  const unsupported = Object.keys(models).filter((key) => !MODELS_KEYS.includes(key));
  if (unsupported.length > 0) {
    return fail(`models has unsupported key(s): ${unsupported.join(", ")}`);
  }

  const tierEntries: [string, string[]][] = [];
  if (models.tiers !== undefined) {
    if (!isPlainObject(models.tiers)) return fail("models.tiers must be an object");
    for (const [name, candidates] of Object.entries(models.tiers)) {
      if (!TIER_NAME_PATTERN.test(name)) {
        return fail(`tier name "${name}" must match /^[A-Za-z0-9_-]+$/`);
      }
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return fail(`models.tiers.${name} must be a non-empty array of model refs`);
      }
      const refs: string[] = [];
      for (const candidate of candidates) {
        const ref = typeof candidate === "string" ? candidate.trim() : "";
        if (!ref.includes("/")) {
          return fail(
            `models.tiers.${name} entries must be provider/id model refs (got ${JSON.stringify(candidate)})`,
          );
        }
        refs.push(ref);
      }
      tierEntries.push([name, refs]);
    }
  }

  const agentEntries: [string, string][] = [];
  if (models.agents !== undefined) {
    if (!isPlainObject(models.agents)) return fail("models.agents must be an object");
    for (const [agent, value] of Object.entries(models.agents)) {
      const ref = typeof value === "string" ? value.trim() : "";
      if (!ref) {
        return fail(`models.agents.${agent} must be a tier name or a provider/id model ref`);
      }
      agentEntries.push([agent, ref]);
    }
  }

  // fromEntries (not assignment) so keys like "__proto__" stay plain data.
  const config = {
    tiers: Object.fromEntries(tierEntries),
    agents: Object.fromEntries(agentEntries),
  };
  return { config, errors };
}

/** Agents may only point at a defined tier or at a concrete ref (contains `/`). */
function checkAgentReferences(config: ModelsConfig, source: string): string[] {
  const errors: string[] = [];
  for (const [agent, value] of Object.entries(config.agents)) {
    if (value.includes("/") || hasOwnKey(config.tiers, value)) continue;
    errors.push(
      `Invalid models config in ${source}: models.agents.${agent} references undefined tier "${value}"`,
    );
  }
  return errors;
}

/**
 * Validate the `models` section of one config object. Any problem makes the whole
 * section ignored (empty config) and is returned as an error string; never throws.
 */
export function parseModelsConfig(rawRoot: unknown, source = CONFIG_FILE_NAME): ModelsConfigResult {
  const parsed = parseModelsSection(rawRoot, source);
  if (parsed.errors.length > 0) return parsed;
  const errors = checkAgentReferences(parsed.config, source);
  if (errors.length > 0) return { config: emptyModelsConfig(), errors };
  return parsed;
}

/**
 * Non-throwing `loadModelsConfig` for spawn and listing paths: an unreadable or
 * invalid config file must not break spawning. The failure is returned as an error
 * and the models config is treated as empty.
 */
export function safeLoadModelsConfig(options: ConfigLocationOptions = {}): ModelsConfigResult {
  try {
    return loadModelsConfig(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: emptyModelsConfig(), errors: [message] };
  }
}

/**
 * Resolve the `models` section: agent-dir file ← project file, merged per key (a
 * project `tiers.fast` replaces the global one; other keys are kept). Missing files
 * are skipped. Any validation error empties the config and is returned in `errors`.
 */
export function loadModelsConfig(options: ConfigLocationOptions = {}): ModelsConfigResult {
  const paths = getConfigPaths(options);
  const errors: string[] = [];
  const sections: ModelsConfig[] = [];
  for (const configPath of paths) {
    const raw = readOptionalJsonFile(configPath);
    if (raw === null) continue;
    const parsed = parseModelsSection(raw, configPath);
    errors.push(...parsed.errors);
    sections.push(parsed.config);
  }
  if (errors.length > 0) return { config: emptyModelsConfig(), errors };

  const merged: ModelsConfig = {
    tiers: Object.fromEntries(sections.flatMap((s) => Object.entries(s.tiers))),
    agents: Object.fromEntries(sections.flatMap((s) => Object.entries(s.agents))),
  };
  const crossErrors = checkAgentReferences(merged, paths.join(", "));
  if (crossErrors.length > 0) return { config: emptyModelsConfig(), errors: crossErrors };
  return { config: merged, errors: [] };
}
