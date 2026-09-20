import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

interface SettingsPackageEntry {
  source: string;
  /** Raw settings `autoload` flag (object-form entries only). */
  autoload: boolean | undefined;
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

function settingsSources(settings: SettingsLike | null): SettingsPackageEntry[] {
  const out: SettingsPackageEntry[] = [];
  for (const entry of settings?.packages ?? []) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ source: entry.trim(), autoload: undefined });
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.source === "string" &&
      entry.source.trim()
    ) {
      out.push({
        source: entry.source.trim(),
        autoload: (entry as { autoload?: unknown }).autoload === false ? false : undefined,
      });
    }
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
 * Merge the extension paths re-loaded for whitelisted tools with the carried
 * installed-package entries.
 *
 * Both sources can point into the same package:
 *
 * - the tool-extension map hardcodes e.g. `<pkg>/index.ts` for pi-web-access,
 *   while that package's manifest declares `["./dist"]`;
 * - the tool map always points at the GLOBAL install, while the carried
 *   entries may be the PROJECT install of the same package (pi: project wins
 *   for the same package identity).
 *
 * Emitting both `-e` paths loads the package twice, and the second
 * registration of its tools is a fatal extension conflict that kills the child
 * at startup ("Tool X conflicts with ..."). A tool-mapped path is therefore
 * dropped when the carried entries already load that package — matched either
 * by directory containment (manifest entry under the mapped file's package
 * root) or by package identity (`identityForInstalledPath`).
 */
export function mergeExtensionPaths(params: {
  toolExtensionPaths: readonly string[];
  packageExtensionPaths: readonly string[];
  /** Config dirs used to reverse-map carried/tool paths to package identities. */
  configDirs?: readonly string[];
}): string[] {
  const packagePaths = [...new Set(params.packageExtensionPaths)];
  const configDirs = params.configDirs ?? [];
  const carriedIdentities = new Set(
    packagePaths
      .map((p) => identityForInstalledPath(p, configDirs))
      .filter((v): v is string => v !== null),
  );
  const out = [...packagePaths];
  for (const toolPath of params.toolExtensionPaths) {
    if (packagePaths.some((pkgPath) => packageCoversToolPath(pkgPath, toolPath))) continue;
    const identity = identityForInstalledPath(toolPath, configDirs);
    if (identity !== null && carriedIdentities.has(identity)) continue;
    if (!out.includes(toolPath)) out.push(toolPath);
  }
  return out;
}

/**
 * True when a package's manifest entry already loads the same package the
 * tool-mapped file belongs to: either the identical path, or any entry inside
 * the package root of an `index.ts`/`index.js` tool mapping.
 */
function packageCoversToolPath(packagePath: string, toolPath: string): boolean {
  if (packagePath === toolPath) return true;
  const base = basename(toolPath).toLowerCase();
  if (base !== "index.ts" && base !== "index.js") return false;
  const pkgRoot = dirname(toolPath);
  return packagePath === pkgRoot || packagePath.startsWith(pkgRoot + sep);
}

/**
 * Reverse-map an on-disk path to a package identity when it lives inside a
 * config dir's npm or git install tree (`npm:<name>` / `git:<host>/<path>`).
 * Returns null for anything else (legacy extension dirs, unrelated paths,
 * local-path packages) — those have no scope-independent identity.
 */
function identityForInstalledPath(path: string, configDirs: readonly string[]): string | null {
  for (const configDir of configDirs) {
    const rel = relative(configDir, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const segs = rel.split(sep);
    if (segs[0] === "npm" && segs[1] === "node_modules" && segs[2]) {
      if (segs[2].startsWith("@")) {
        if (segs[3]) return `npm:${segs[2]}/${segs[3]}`;
        continue; // "@scope" with no package segment — not a package root
      }
      return `npm:${segs[2]}`;
    }
    if (segs[0] === "git" && segs[1] && segs[2] && segs[3]) {
      return `git:${segs[1]}/${segs[2]}/${segs[3]}`;
    }
  }
  return null;
}

/**
 * The identity a settings source resolves to, mirroring pi's
 * getPackageIdentity: npm keeps only the package name (versions are not part
 * of identity), git keeps host/path (SSH and HTTPS are the same package), and
 * local paths are resolved against the scope base dir.
 */
function identityForSource(source: string, baseDir: string): string {
  const npmName = parseNpmName(source);
  if (npmName) return `npm:${npmName}`;
  const gitRel = parseGitSourcePath(source);
  if (gitRel) return `git:${gitRel}`;
  return `local:${resolve(baseDir, source)}`;
}

/** Resolve one settings entry to extension entry paths for its scope. */
function resolveScopeEntry(entry: { source: string; configDir: string; baseDir: string }): {
  paths: string[];
  missing: boolean;
} {
  const { source, configDir, baseDir } = entry;
  let packageDir: string | null = null;

  const npmName = parseNpmName(source);
  if (npmName) {
    packageDir = join(configDir, "npm", "node_modules", ...npmName.split("/"));
  } else if (
    source.startsWith("git:") ||
    source.startsWith("git+") ||
    /^([a-z]+:)?\/\/|^git@/i.test(source)
  ) {
    const gitRel = parseGitSourcePath(source);
    if (gitRel) packageDir = join(configDir, "git", ...gitRel.split("/"));
  } else if (isLocalPathSource(source)) {
    packageDir = resolve(baseDir, source);
  }

  if (!packageDir || !existsSync(packageDir)) return { paths: [], missing: true };
  return { paths: resolvePackageEntryPaths(packageDir), missing: false };
}

/**
 * Resolve every installed package's extension entry files for the given
 * scopes, deduplicating across scopes by package identity the way pi does
 * (dedupePackages): for the same identity the PROJECT install wins and the
 * global one is dropped — loading both would register the same tools twice,
 * which is a fatal extension conflict in the child. A winning scope with no
 * on-disk install falls back to the other scope (we never install). Entries
 * with `autoload: false` are install-not-load deltas over another scope's
 * entry and contribute nothing (mirroring what a normal session loads).
 *
 * User-scope packages live under `agentDir` (`npm/node_modules/...`, `git/...`,
 * or paths relative to `agentDir`); project-scope packages under
 * `projectConfigDir` the same way. Unresolvable or not-installed sources are
 * reported in `unresolved` and never throw — spawning must not break because a
 * package is missing or uses an exotic source format.
 */
export function resolvePackageExtensions(
  opts: ResolvePackageExtensionsOptions,
): ResolvedPackageExtensions {
  const unresolved: string[] = [];

  // Project first, mirroring pi's dedupePackages order (project wins).
  const scopeEntries: Array<{
    source: string;
    scope: "project" | "user";
    configDir: string;
    baseDir: string;
  }> = [];
  const pushEntries = (
    settings: SettingsLike | null,
    scope: "project" | "user",
    configDir: string,
  ) => {
    for (const e of settingsSources(settings)) {
      // `autoload: false` marks an install that must not load (a delta over
      // another scope's entry) — it contributes no extension paths.
      if (e.autoload === false) continue;
      scopeEntries.push({ source: e.source, scope, configDir, baseDir: configDir });
    }
  };
  if (opts.projectConfigDir && opts.projectConfigDir !== opts.agentDir) {
    pushEntries(readSettings(opts.projectConfigDir), "project", opts.projectConfigDir);
  }
  pushEntries(readSettings(opts.agentDir), "user", opts.agentDir);

  // Resolve every entry, bucketed by package identity.
  const buckets = new Map<
    string,
    Array<{
      source: string;
      scope: "project" | "user";
      paths: string[];
      missing: boolean;
    }>
  >();
  for (const e of scopeEntries) {
    const identity = identityForSource(e.source, e.baseDir);
    let bucket = buckets.get(identity);
    if (!bucket) {
      bucket = [];
      buckets.set(identity, bucket);
    }
    const { paths: entryPaths, missing } = resolveScopeEntry(e);
    bucket.push({ source: e.source, scope: e.scope, paths: entryPaths, missing });
  }

  // Pick each identity's representative: the project install when it is on
  // disk, else the global install (we never install, so a missing winner must
  // not lose the package). A project `autoload: false` delta keeps both.
  const paths = new Set<string>();
  for (const bucket of buckets.values()) {
    const before = paths.size;
    const project = bucket.find((r) => r.scope === "project");
    const user = bucket.find((r) => r.scope === "user");
    if (project && !project.missing) {
      for (const p of project.paths) paths.add(p);
    } else if (user && !user.missing) {
      for (const p of user.paths) paths.add(p);
    }
    if (paths.size === before) {
      // Nothing on disk for this identity — report the sources as unresolved.
      for (const r of bucket) {
        if (r.missing) unresolved.push(r.source);
      }
    }
  }

  return { paths: [...paths], unresolved };
}
