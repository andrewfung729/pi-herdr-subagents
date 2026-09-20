import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the extension entry files of the pi packages a user has installed
 * (`pi install ...` → `packages` in settings.json), so restricted subagents can
 * carry them explicitly alongside `--no-extensions`.
 *
 * WHY THIS EXISTS: restricted subagents are launched with `--no-extensions` +
 * `--tools <allowlist>`, and only extensions *backing whitelisted tools* are
 * re-loaded via `-e`. Extensions that register model *providers*
 * (`pi.registerProvider`) provide no tools, so they were never re-loaded — a
 * subagent pinned to e.g. `commandcode/gpt-5.6-sol` (registered by the
 * `pi-commandcode-provider` package) died at startup with
 * `Error: Model "commandcode/..." not found` because the child process had no
 * such provider. User-installed packages are trusted (they load in every
 * normal pi session), and their custom tools are still gated by the child's
 * `--tools` allowlist, so carrying them keeps the sandbox's security property
 * (whitelist-only tool access) intact while restoring provider/model
 * availability.
 *
 * The resolution below mirrors pi's package layout (dist/core/package-manager.js
 * + dist/core/extensions/loader.js) for the read-only cases that matter after
 * installation — source parsing and on-disk entry discovery — without network
 * access or npm/git installs (a missing install is skipped, never fetched).
 */

export interface ResolvedPackageExtensions {
  /** Absolute extension entry file paths, deduplicated. */
  paths: string[];
  /** `packages` settings entries that could not be resolved to a local install. */
  unresolved: string[];
}

export interface ResolvePackageExtensionsOptions {
  /** Global agent config dir (PI_CODING_AGENT_DIR or ~/.pi/agent). */
  agentDir: string;
  /** Optional project config dir (`<cwd>/.pi`) for project-scope packages. */
  projectConfigDir?: string | null;
}

interface SettingsLike {
  packages?: Array<string | { source?: unknown }>;
}

function readSettings(configDir: string): SettingsLike | null {
  const p = join(configDir, "settings.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SettingsLike) : null;
  } catch {
    return null;
  }
}

function settingsSources(settings: SettingsLike | null): string[] {
  const out: string[] = [];
  for (const entry of settings?.packages ?? []) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.source === "string" &&
      entry.source.trim()
    )
      out.push(entry.source.trim());
  }
  return out;
}

/**
 * Parse an npm package source (`npm:name`, `npm:name@range`, including scoped
 * `npm:@scope/name`) into the package name. Mirrors pi's parseNpmSpec.
 */
function parseNpmName(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice(4).trim();
  if (!spec) return null;
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return match?.[1] ?? spec;
}

/**
 * Parse a git package source into `<host>/<path>` used under the git install
 * root. Mirrors pi's parseGitUrl for the read-only shorthand/URL forms:
 * `git:host/org/repo`, `git:https://host/org/repo(.git)`, plain
 * `https://host/org/repo(.git)`, and scp-like `git@host:org/repo`. Refs
 * (`#ref`, `@ref`) are stripped — they don't affect the install directory.
 */
function parseGitSourcePath(source: string): string | null {
  let rest = source;
  if (rest.startsWith("git:")) rest = rest.slice(4).trim();
  else if (rest.startsWith("git+")) rest = rest.slice(4).trim();

  let host: string | null = null;
  let path: string;
  if (rest.startsWith("git@")) {
    const scp = rest.match(/^git@([^:]+):(.+)$/);
    if (!scp) return null;
    host = scp[1] ?? null;
    path = scp[2] ?? "";
  } else if (/^[a-z]+:\/\//i.test(rest)) {
    try {
      const url = new URL(rest);
      host = url.host || null;
      path = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    // Shorthand `host/org/repo` — pi stores this form via `pi install git:...`.
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    host = rest.slice(0, slash) || null;
    path = rest.slice(slash + 1);
  }
  if (!host || !path) return null;
  // Strip a trailing .git and any ref fragment.
  path = path
    .replace(/\.git$/i, "")
    .replace(/#.*$/, "")
    .replace(/(^|\/)@[^/]*$/, "$1");
  path = path.replace(/\/+$/, "");
  if (!path || path.split("/").includes("..")) return null;
  return `${host}/${path}`;
}

function isLocalPathSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../") || source.startsWith("/");
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry files inside an installed package directory,
 * mirroring pi's discovery order: package.json `pi.extensions` manifest first,
 * then an `extensions/` directory (direct files, or one level of subdirectories
 * with their own manifest/index), then a root `index.ts`/`index.js`.
 */
export function resolvePackageEntryPaths(packageDir: string): string[] {
  const manifestPath = join(packageDir, "package.json");
  if (existsSync(manifestPath)) {
    const entries = readPiManifestExtensions(manifestPath);
    if (entries.length > 0) return entries;
  }

  const extensionsDir = join(packageDir, "extensions");
  if (existsSync(extensionsDir)) {
    const discovered = discoverExtensionsInDir(extensionsDir);
    if (discovered.length > 0) return discovered;
  }

  const indexTs = join(packageDir, "index.ts");
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = join(packageDir, "index.js");
  if (existsSync(indexJs)) return [indexJs];
  return [];
}

function readPiManifestExtensions(packageJsonPath: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const entries = pkg?.pi?.extensions;
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const packageDir = dirname(packageJsonPath);
    const out: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const resolved = resolve(packageDir, entry.trim());
      if (existsSync(resolved)) out.push(resolved);
    }
    return out;
  } catch {
    return [];
  }
}

/** Direct `*.ts`/`*.js` files plus one level of subdirectory entries. */
function discoverExtensionsInDir(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      discovered.push(...resolvePackageEntryPaths(entryPath));
    }
  }
  return discovered;
}

/**
 * Resolve every installed package's extension entry files for the given
 * scopes. User-scope packages live under `agentDir` (`npm/node_modules/...`,
 * `git/...`, or paths relative to `agentDir`); project-scope packages under
 * `projectConfigDir` the same way. Unresolvable or not-installed sources are
 * reported in `unresolved` and never throw — spawning must not break because a
 * package is missing or uses an exotic source format.
 */
export function resolvePackageExtensions(
  opts: ResolvePackageExtensionsOptions,
): ResolvedPackageExtensions {
  const unresolved: string[] = [];
  const paths = new Set<string>();

  const scopes: Array<{ configDir: string; baseDir: string }> = [
    { configDir: opts.agentDir, baseDir: opts.agentDir },
  ];
  if (opts.projectConfigDir && opts.projectConfigDir !== opts.agentDir) {
    scopes.push({ configDir: opts.projectConfigDir, baseDir: opts.projectConfigDir });
  }

  for (const scope of scopes) {
    const settings = readSettings(scope.configDir);
    for (const source of settingsSources(settings)) {
      // npm:name / npm:name@range
      const npmName = parseNpmName(source);
      if (npmName) {
        const packageDir = join(scope.configDir, "npm", "node_modules", ...npmName.split("/"));
        if (existsSync(packageDir)) {
          for (const p of resolvePackageEntryPaths(packageDir)) paths.add(p);
        } else {
          unresolved.push(source);
        }
        continue;
      }

      // git sources → gitRoot/<host>/<path>
      if (
        source.startsWith("git:") ||
        source.startsWith("git+") ||
        /^([a-z]+:)?\/\/|^git@/i.test(source)
      ) {
        const gitRel = parseGitSourcePath(source);
        if (gitRel) {
          const packageDir = join(scope.configDir, "git", ...gitRel.split("/"));
          if (existsSync(packageDir)) {
            for (const p of resolvePackageEntryPaths(packageDir)) paths.add(p);
          } else {
            unresolved.push(source);
          }
        } else {
          unresolved.push(source);
        }
        continue;
      }

      // Local path sources, resolved against the scope base dir.
      if (isLocalPathSource(source)) {
        const packageDir = resolve(scope.baseDir, source);
        if (existsSync(packageDir)) {
          for (const p of resolvePackageEntryPaths(packageDir)) paths.add(p);
        } else {
          unresolved.push(source);
        }
        continue;
      }

      unresolved.push(source);
    }
  }

  return { paths: [...paths], unresolved };
}
