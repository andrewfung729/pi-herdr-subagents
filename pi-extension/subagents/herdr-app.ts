/**
 * Herdr app surface — panes via `herdr-app`, terminal I/O via `hc` (herdr-core).
 *
 * The Herdr app is a desktop window over herdr-core. It has no `herdr pane`
 * CLI. A sub-agent pane is a `pane.split` in the caller's tab; screen reads
 * and keystrokes go to that pane's core terminal (`hc read` / `hc send`).
 *
 * Surface ids are `herdr-app|<pane>|<terminal>|<pid>|<launch>` (the last two
 * optional) so later calls know the pane, the core terminal, the program pid
 * at creation (a different pid later means herdr-core replaced a lost
 * terminal with a fresh shell) and the launch handoff token. Callers treat the
 * string as opaque.
 *
 * Launch panes: `pane.split --argv` starts a small bootstrap instead of a
 * shell. It waits for a handoff file, then runs it through the user's login
 * shell (`$SHELL -lic`), so the child sees the same environment as a typed
 * command. Nothing is typed with `hc send`, so there is no shell-ready delay
 * and no wait for a person's unfinished draft. When the launch script ends,
 * its program exits and the app closes the pane; the screen stays readable
 * with `hc read`.
 *
 * Splits do not keep focus; if the app moves focus anyway, it is put back.
 *
 * Remote spaces: a terminal in a space on a machine added with
 * `hc machine add` runs on that machine, where `herdr-app` cannot see the
 * window. There the sub-agent is started with `hc run` and the terminal's own
 * `herdr.space`/`herdr.tab` labels; the app adopts any labeled terminal as a
 * pane in that tab. Such surfaces have no pane id (the app places the pane),
 * and everything else goes through `hc` as usual.
 */
import { execFile, execFileSync, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Capture stderr: hc and herdr-app print JSON errors there, and it must not reach pi's TUI. */
const SYNC_OPTS: { encoding: "utf8"; stdio: StdioOptions } = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
};

/** Versions this backend was verified against (pane.split argv, hc exit codes, read --json). */
export const HERDR_APP_TESTED_VERSION = "0.1.17";
export const HC_TESTED_VERSION = "0.1.22";

const SURFACE_PREFIX = "herdr-app|";

/** History lines requested from `hc read`, then tail-sliced to the caller's count. */
const APP_READ_FLOOR_LINES = 200;

/** How long a launch pane waits for its handoff before giving up. */
const LAUNCH_WAIT_SECONDS = 600;

export interface AppSurfaceRef {
  /** App pane id; empty for a labeled terminal the app adopts (remote spaces). */
  pane: string;
  terminal: string;
  /** Program pid when the pane was created. */
  pid?: number;
  /** Handoff token of a launch pane. */
  launch?: string;
}

export function encodeAppSurface(ref: AppSurfaceRef): string {
  const parts = [ref.pane, ref.terminal];
  if (ref.pid !== undefined || ref.launch) parts.push(ref.pid === undefined ? "" : String(ref.pid));
  if (ref.launch) parts.push(ref.launch);
  return SURFACE_PREFIX + parts.map((part) => encodeURIComponent(part)).join("|");
}

export function decodeAppSurface(surface: string): AppSurfaceRef | null {
  if (!surface.startsWith(SURFACE_PREFIX)) return null;
  const parts = surface.slice(SURFACE_PREFIX.length).split("|");
  if (parts.length < 2 || parts.length > 4) return null;
  try {
    const [pane, terminal, pid, launch] = parts.map((part) => decodeURIComponent(part));
    if (!terminal) return null;
    const ref: AppSurfaceRef = { pane, terminal };
    if (pid) {
      const parsed = Number(pid);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      ref.pid = parsed;
    }
    if (launch) {
      if (!/^[0-9a-f]+$/.test(launch)) return null;
      ref.launch = launch;
    }
    return ref;
  } catch {
    return null;
  }
}

function mustDecode(surface: string): AppSurfaceRef {
  const decoded = decodeAppSurface(surface);
  if (!decoded) throw new Error(`Not a Herdr app surface: ${surface}`);
  return decoded;
}

// ── Errors ──

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const err = error as { message?: string; stdout?: unknown; stderr?: unknown };
  return [err.message ?? "", stringField(err.stdout), stringField(err.stderr)].join("\n");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type HcErrorKind = "not_found" | "finished" | "blocked" | "other";

/**
 * Classify a failed `hc` call. hc exits 3 (not_found), 9 (blocked) or
 * 11 (finished); sync failures carry the code in `status`, async ones in
 * `code`. The JSON error on stderr names the same kind.
 */
export function classifyHcError(error: unknown): HcErrorKind {
  const err = error as { status?: unknown; code?: unknown } | null;
  const exit =
    typeof err?.status === "number" ? err.status : typeof err?.code === "number" ? err.code : null;
  if (exit === 3) return "not_found";
  if (exit === 11) return "finished";
  if (exit === 9) return "blocked";
  const kind = /"kind"\s*:\s*"([a-z_]+)"/.exec(errorText(error))?.[1];
  if (kind === "not_found" || kind === "finished" || kind === "blocked") return kind;
  return "other";
}

function isTerminalGone(error: unknown): boolean {
  const kind = classifyHcError(error);
  return kind === "not_found" || kind === "finished";
}

/** Turn an hc failure into the error the surface layer reports. */
function hcFailure(error: unknown, terminal: string): Error {
  switch (classifyHcError(error)) {
    case "not_found":
    case "finished":
      return new Error(
        `pane_not_found: terminal ${terminal} has ended. ${errorText(error).trim()}`,
      );
    case "blocked":
      return new Error(
        `Terminal ${terminal} is blocked waiting for a person (a permission prompt or a question). ` +
          "Answer it in its pane, then try again.",
      );
    default:
      return error instanceof Error ? error : new Error(errorText(error));
  }
}

function isAppPaneMissing(error: unknown): boolean {
  return errorText(error).includes("no pane ");
}

function firstJson(text: string): any | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

// ── CLI plumbing ──

function appDo(command: string, args: Record<string, string>): any {
  const cli = ["do", command];
  for (const [key, value] of Object.entries(args)) {
    cli.push(`--${key}`, value);
  }

  let stdout: string;
  try {
    stdout = execFileSync("herdr-app", cli, SYNC_OPTS);
  } catch (error) {
    const parsed = firstJson(errorText(error));
    if (parsed?.error) {
      const message =
        typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
      throw new Error(`herdr-app: ${message}`);
    }
    throw error;
  }

  const parsed = JSON.parse(stdout);
  if (parsed?.error) {
    const message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
    throw new Error(`herdr-app: ${message}`);
  }
  return parsed;
}

function hc(args: string[]): string {
  return execFileSync("hc", args, SYNC_OPTS);
}

async function hcAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("hc", args, { encoding: "utf8" });
  return stdout;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Layout and runtime ──

interface AppTerminalNode {
  terminal?: string;
  pane?: string | null;
  sub_agents?: AppTerminalNode[];
}

function findPane(nodes: AppTerminalNode[] | undefined, terminalId: string): AppSurfaceRef | null {
  for (const node of nodes ?? []) {
    if (node.terminal === terminalId && typeof node.pane === "string" && node.pane !== "") {
      return { pane: node.pane, terminal: node.terminal };
    }
    const nested = findPane(node.sub_agents, terminalId);
    if (nested) return nested;
  }
  return null;
}

/** Pane in the Herdr app that is showing `terminalId` (`herdr-app ls`). */
export function paneForTerminal(terminalId: string): AppSurfaceRef {
  let stdout: string;
  try {
    stdout = execFileSync("herdr-app", ["ls"], SYNC_OPTS);
  } catch (error) {
    throw new Error(`Could not read the Herdr app layout (\`herdr-app ls\`): ${errorText(error)}`);
  }
  const layout = JSON.parse(stdout) as {
    spaces?: Array<{ tabs?: Array<{ terminals?: AppTerminalNode[] }> }>;
  };
  for (const space of layout.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      const found = findPane(tab.terminals, terminalId);
      if (found) return found;
    }
  }
  throw new Error(
    `Terminal ${terminalId} is not a pane in the Herdr app. ` +
      "Subagents split a pane in the current tab.",
  );
}

/** The space and tab the app shows a labeled terminal in (labels are local to its machine). */
export interface AppLabelHost {
  space: string;
  tab: string;
}

/**
 * The labeled-terminal host from `hc get --json` of this terminal, or null.
 * The terminal's program must be an ancestor of this process, so a leaked
 * `HC_TERMINAL_ID` does not send panes to a tab pi is not in.
 */
export function labelHostFromTerminal(
  info: any,
  isAncestor: (pid: number) => boolean,
): AppLabelHost | null {
  const space = info?.labels?.["herdr.space"];
  const tab = info?.labels?.["herdr.tab"];
  if (typeof space !== "string" || space === "" || typeof tab !== "string" || tab === "") {
    return null;
  }
  if (typeof info?.pid !== "number" || !isAncestor(info.pid)) return null;
  return { space, tab };
}

/** Whether `pid` is `start` or one of its ancestors. */
export function isAncestorPid(
  pid: number,
  parentOf: (pid: number) => number | null,
  start: number = process.pid,
): boolean {
  let current: number | null = start;
  for (let depth = 0; depth < 64 && current !== null && current > 1; depth++) {
    if (current === pid) return true;
    current = parentOf(current);
  }
  return false;
}

function parentPid(pid: number): number | null {
  try {
    const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], SYNC_OPTS).trim());
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

function currentLabelHost(): AppLabelHost | null {
  const terminalId = process.env.HC_TERMINAL_ID;
  if (!terminalId) return null;
  try {
    const info = JSON.parse(hc(["get", "--json", terminalId]));
    return labelHostFromTerminal(info, (pid) => isAncestorPid(pid, parentPid));
  } catch {
    return null;
  }
}

/**
 * Where sub-agents of this terminal go: a pane `herdr-app` can split, or,
 * when the app cannot see this terminal (a remote space), the labels that
 * make the app adopt a terminal into this tab.
 */
export function currentAppHost():
  | { pane: AppSurfaceRef }
  | { labels: AppLabelHost }
  | { error: string } {
  const pane = currentAppPane();
  if ("ref" in pane) return { pane: pane.ref };
  const labels = currentLabelHost();
  return labels ? { labels } : { error: pane.error };
}

/** The current terminal's pane, or why there is none. */
export function currentAppPane(): { ref: AppSurfaceRef } | { error: string } {
  const terminalId = process.env.HC_TERMINAL_ID;
  if (!terminalId) return { error: "HC_TERMINAL_ID is not set." };
  try {
    return { ref: paneForTerminal(terminalId) };
  } catch (error: any) {
    return { error: error?.message ?? String(error) };
  }
}

interface Semver {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(output: string): Semver | null {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: Semver, right: Semver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export type AppVersionStatus =
  | { kind: "supported" | "untested"; version: string; message?: string }
  | { kind: "unsupported"; version?: string; message: string };

/**
 * Classify `herdr-app --version` and `hc --version`. Older than the tested
 * versions is unsupported (launch panes need `pane.split --argv` and hc's
 * exit codes); a newer minor or major runs with a warning. `appOutput` is
 * null for labeled terminals (remote spaces), which use only hc.
 */
export function classifyHerdrAppVersions(
  appOutput: string | null,
  hcOutput: string,
): AppVersionStatus {
  const app = appOutput === null ? null : parseSemver(appOutput);
  const core = parseSemver(hcOutput);
  if ((appOutput !== null && !app) || !core) {
    return {
      kind: "unsupported",
      message: `Could not parse herdr-app/hc version output: ${appOutput?.trim() || "<empty>"} / ${hcOutput.trim() || "<empty>"}`,
    };
  }
  const version = app ? `herdr-app ${app.raw} / hc ${core.raw}` : `hc ${core.raw}`;
  const checks: Array<[string, Semver, string]> = [["hc", core, HC_TESTED_VERSION]];
  if (app) checks.unshift(["herdr-app", app, HERDR_APP_TESTED_VERSION]);
  const untested: string[] = [];
  for (const [name, found, testedRaw] of checks) {
    const tested = parseSemver(testedRaw) as Semver;
    if (compareSemver(found, tested) < 0) {
      return {
        kind: "unsupported",
        version,
        message: `${name} ${found.raw} is too old; subagents require ${name} >=${testedRaw}.`,
      };
    }
    if (found.major !== tested.major || found.minor !== tested.minor) {
      untested.push(`${name} ${found.raw} (tested ${testedRaw})`);
    }
  }
  if (untested.length > 0) {
    return {
      kind: "untested",
      version,
      message: `${untested.join(", ")} is outside the tested range; continuing without a compatibility guarantee.`,
    };
  }
  return { kind: "supported", version };
}

/** Read and classify the installed herdr-app (unless `hcOnly`) and hc versions. */
export function readHerdrAppVersionStatus(hcOnly = false): AppVersionStatus {
  try {
    const app = hcOnly ? null : execFileSync("herdr-app", ["--version"], SYNC_OPTS);
    const core = execFileSync("hc", ["--version"], SYNC_OPTS);
    return classifyHerdrAppVersions(app, core);
  } catch (error) {
    return {
      kind: "unsupported",
      message: `Could not read herdr-app or hc version: ${errorText(error)}`,
    };
  }
}

function focusedPane(): string | null {
  try {
    const stdout = execFileSync("herdr-app", ["status"], SYNC_OPTS);
    const pane = JSON.parse(stdout)?.focused_pane;
    return typeof pane === "string" && pane !== "" ? pane : null;
  } catch {
    return null;
  }
}

function terminalPid(terminal: string): number | undefined {
  try {
    const pid = JSON.parse(hc(["get", "--json", terminal]))?.pid;
    return typeof pid === "number" && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function tailLines(text: string, lines: number): string {
  if (lines <= 0) return "";
  const rows = text.split("\n");
  return rows.length <= lines ? text : rows.slice(-lines).join("\n");
}

// ── Launch panes ──

/** Where the parent drops the handoff for launch token `token`. */
export function pendingLaunchPath(token: string): string {
  return join(tmpdir(), "pi-herdr-subagents", `launch-${token}.sh`);
}

/**
 * argv for a launch pane: wait for `pendingPath`, then run it through the
 * user's login shell so the child gets the environment a typed command would
 * get. Shells that do not take `-lic cmd name arg` (fish, nu) fall back to
 * bash.
 */
export function launchBootstrapArgv(pendingPath: string): string[] {
  const script = [
    'p="$1"',
    "i=0",
    'while [ ! -e "$p" ]; do',
    "  i=$((i+1))",
    `  if [ "$i" -gt ${LAUNCH_WAIT_SECONDS * 10} ]; then echo "pi-herdr-subagents: launch script never arrived: $p" >&2; exit 124; fi`,
    "  sleep 0.1",
    "done",
    'case "$(basename "$SHELL")" in',
    '  bash|zsh|sh|ksh|dash) login_shell="$SHELL" ;;',
    "  *) login_shell=/bin/bash ;;",
    "esac",
    `exec "$login_shell" -lic 'exec bash "$1"' pi-subagent "$p"`,
  ].join("\n");
  return ["/bin/bash", "-c", script, "pi-subagent-launch", pendingPath];
}

const handedOff = new Set<string>();

/**
 * Hand `scriptPath` to a launch pane that is still waiting. Returns false for
 * surfaces without a pending launch, so the caller types the command instead.
 */
export function handOffAppLaunch(surface: string, scriptPath: string): boolean {
  const ref = decodeAppSurface(surface);
  if (!ref?.launch || handedOff.has(ref.launch)) return false;
  const pending = pendingLaunchPath(ref.launch);
  mkdirSync(dirname(pending), { recursive: true, mode: 0o700 });
  const tmp = `${pending}.${process.pid}.tmp`;
  writeFileSync(tmp, `rm -f "$0"\nexec bash ${shellQuote(scriptPath)}\n`, { mode: 0o600 });
  renameSync(tmp, pending);
  handedOff.add(ref.launch);
  return true;
}

/** True for a launch pane whose handoff has not happened yet. */
export function isPendingAppLaunch(surface: string): boolean {
  const launch = decodeAppSurface(surface)?.launch;
  return !!launch && !handedOff.has(launch);
}

// ── Surface primitives ──

/** `hc run` arguments for a terminal the app adopts into `host`'s tab. */
export function labeledRunArgs(host: AppLabelHost, cwd: string, argv: string[]): string[] {
  return [
    "run",
    "--bg",
    "--json",
    // No parent: hc would type notes about the child into the parent pi's input.
    "--no-parent",
    "--cwd",
    cwd,
    "--label",
    `herdr.space=${host.space}`,
    "--label",
    `herdr.tab=${host.tab}`,
    ...(argv.length > 0 ? ["--", ...argv] : []),
  ];
}

// shortcut: the app places adopted panes itself (each one splits the last pane to the right)
// and they keep the program's title; upgrade if hc labels ever choose placement or a name.
function createLabeledSurface(host: AppLabelHost, cwd: string, launch?: string): string {
  const argv = launch ? launchBootstrapArgv(pendingLaunchPath(launch)) : [];
  const created = JSON.parse(hc(labeledRunArgs(host, cwd, argv)));
  const terminal = created?.address;
  if (typeof terminal !== "string" || terminal === "") {
    throw new Error(`Unexpected hc run output: ${JSON.stringify(created)}`);
  }
  return encodeAppSurface({ pane: "", terminal, pid: terminalPid(terminal), launch });
}

/**
 * Split `direction` off `fromSurface`, or off the caller's pane when omitted.
 * Herdr app splits inherit the source pane's directory. With `launch`, the
 * pane runs the launch bootstrap instead of a shell (see `handOffAppLaunch`).
 * In a remote space (no pane the app can split) the terminal is started with
 * `hc run` in `cwd` and adopted by the app; `direction` does not apply.
 */
export function createAppSurfaceSplit(
  name: string,
  direction: "right" | "down",
  fromSurface?: string,
  options?: { launch?: boolean; cwd?: string },
): string {
  const launch = options?.launch ? randomBytes(8).toString("hex") : undefined;
  let source = fromSurface ? mustDecode(fromSurface) : undefined;
  if (!source?.pane) {
    const host = currentAppHost();
    if ("error" in host) throw new Error(host.error);
    if ("labels" in host)
      return createLabeledSurface(host.labels, options?.cwd ?? process.cwd(), launch);
    source = host.pane;
  }
  const args: Record<string, string> = { direction, pane: source.pane };
  if (launch) args.argv = JSON.stringify(launchBootstrapArgv(pendingLaunchPath(launch)));

  const focusBefore = focusedPane();
  const created = appDo("pane.split", args);
  const pane = created?.pane;
  const terminal = created?.terminal;
  if (typeof pane !== "string" || pane === "" || typeof terminal !== "string" || terminal === "") {
    throw new Error(`Unexpected herdr-app pane.split output: ${JSON.stringify(created)}`);
  }

  if (focusBefore) {
    const focusAfter = focusedPane();
    if (focusAfter && focusAfter !== focusBefore) {
      try {
        appDo("pane.focus", { pane: focusBefore });
      } catch {
        // Focus restore is cosmetic; the pane itself is already created.
      }
    }
  }

  if (name) {
    try {
      appDo("pane.rename", { pane, name });
    } catch {
      // Renaming is cosmetic; never fail a spawn over it.
    }
  }

  return encodeAppSurface({ pane, terminal, pid: terminalPid(terminal), launch });
}

export function sendAppCommand(surface: string, command: string): void {
  const { terminal } = mustDecode(surface);
  try {
    hc(["send", terminal, command]);
  } catch (error) {
    throw hcFailure(error, terminal);
  }
}

/**
 * Async send. `hc send` waits up to 60 s for a person's unfinished draft in
 * that terminal; this keeps the parent's event loop running meanwhile.
 */
export async function sendAppCommandAsync(surface: string, command: string): Promise<void> {
  const { terminal } = mustDecode(surface);
  try {
    await hcAsync(["send", terminal, command]);
  } catch (error) {
    throw hcFailure(error, terminal);
  }
}

/**
 * Screen text from `hc read --json`. While a program is working, blocked or
 * in error, hc returns only the screen (`complete: false`); the plain-text
 * form would add an `[hc] only its screen …` line, which is dropped here.
 */
export function parseAppReadOutput(stdout: string): string {
  let text: string;
  try {
    const parsed = JSON.parse(stdout);
    text = typeof parsed?.text === "string" ? parsed.text : stdout;
  } catch {
    text = stdout;
  }
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[hc] "))
    .join("\n")
    .replace(/\n+$/, "");
}

function readArgs(terminal: string, lines: number): string[] {
  return ["read", "--json", "--lines", String(Math.max(lines, APP_READ_FLOOR_LINES)), terminal];
}

export function readAppScreen(surface: string, lines = 50): string {
  const { terminal } = mustDecode(surface);
  try {
    return tailLines(parseAppReadOutput(hc(readArgs(terminal, lines))), lines);
  } catch (error) {
    throw hcFailure(error, terminal);
  }
}

export async function readAppScreenAsync(surface: string, lines = 50): Promise<string> {
  const { terminal } = mustDecode(surface);
  try {
    return tailLines(parseAppReadOutput(await hcAsync(readArgs(terminal, lines))), lines);
  } catch (error) {
    throw hcFailure(error, terminal);
  }
}

export type AppTerminalState = "live" | "gone" | "replaced";

/** Interpret `hc get --json` for a surface created with program pid `pid`. */
export function classifyAppTerminal(info: any, pid?: number): AppTerminalState {
  if (info?.error?.kind === "not_found") return "gone";
  if (info?.state === "finished") return "gone";
  if (pid !== undefined && typeof info?.pid === "number" && info.pid !== pid) return "replaced";
  return "live";
}

/**
 * Whether the surface's core terminal is still the program we started.
 * `hc read` still prints a finished terminal's screen, so a missing sentinel
 * plus a gone terminal is how a closed Herdr app pane shows up. After a core
 * crash a kept terminal comes back as a fresh shell at the same address; the
 * pid changes, which reads as `replaced`.
 */
export async function appTerminalStateAsync(surface: string): Promise<AppTerminalState> {
  const ref = decodeAppSurface(surface);
  if (!ref) return "live";
  try {
    return classifyAppTerminal(JSON.parse(await hcAsync(["get", "--json", ref.terminal])), ref.pid);
  } catch (error) {
    return isTerminalGone(error) ? "gone" : "live";
  }
}

/** Close the pane and end its terminal. Already-gone panes count as closed. */
export function closeAppSurface(surface: string): void {
  const ref = mustDecode(surface);
  let failure: unknown;
  if (ref.pane) {
    try {
      appDo("pane.close", { pane: ref.pane });
    } catch (error) {
      if (!isAppPaneMissing(error)) failure = error;
    }
  }
  // pane.close does not always end the terminal before it returns.
  try {
    hc(["kill", ref.terminal]);
  } catch (error) {
    if (!isTerminalGone(error)) failure ??= error;
  }
  if (ref.launch) rmSync(pendingLaunchPath(ref.launch), { force: true });
  removeFinishedTerminal(ref.terminal);
  if (failure) throw failure;
}

/**
 * Drop the finished terminal from herdr-core (`hc rm`), so closed sub-agent
 * panes do not pile up in `hc ls --all`. The kill may not have landed yet, so
 * retry a few times in the background; failures are harmless.
 */
function removeFinishedTerminal(terminal: string, attempt = 0): void {
  hcAsync(["rm", terminal]).catch((error) => {
    if (classifyHcError(error) === "not_found" || attempt >= 4) return;
    const timer = setTimeout(() => removeFinishedTerminal(terminal, attempt + 1), 250);
    timer.unref?.();
  });
}
