/**
 * Terminal surface layer. Two backends, one API:
 *
 * - **Herdr app**: `herdr-app do pane.split` plus `hc` for send/read/kill.
 *   Active when `HC_TERMINAL_ID` is set and this terminal has a pane in the
 *   app. See `herdr-app.ts`.
 * - **herdr** (the TUI): `herdr pane split|run|read|close`. Active when
 *   `HERDR_ENV=1` and `herdr pane current` finds this pane. Pane ids are
 *   workspace-qualified (`w1:p3`).
 *
 * When both are set, herdr is checked first: a herdr server started from a
 * Herdr app terminal passes `HC_TERMINAL_ID` to every herdr pane, and those
 * panes must split inside herdr. If herdr cannot confirm the pane (a leaked
 * `HERDR_ENV`), the Herdr app is checked next.
 *
 * Everything the extension does to a pane goes through this file: create/split
 * a pane, type a command into it, read its screen, close it, and poll for
 * exit. index.ts stays free of CLI details.
 *
 * A split targets the parent pi pane, or an explicit pane, so callers can
 * build a stable two-column layout with subagents stacked on the right.
 *
 * Ported from the tmux surface of amosblomqvist/pi-interactive-subagents.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  appTerminalStateAsync,
  closeAppSurface,
  createAppSurfaceSplit,
  currentAppPane,
  decodeAppSurface,
  handOffAppLaunch,
  isPendingAppLaunch,
  readAppScreen,
  readAppScreenAsync,
  readHerdrAppVersionStatus,
  sendAppCommand,
  sendAppCommandAsync,
} from "./herdr-app.ts";

const execFileAsync = promisify(execFile);

export type SurfaceBackend = "herdr" | "herdr-app";

// ── Availability ──

export const HERDR_MIN_VERSION = "0.8.2";
export const HERDR_TESTED_VERSION = "0.9.5";
export const HERDR_REVIEW_VERSION = "1.0.0";

interface SemanticVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export type HerdrRuntimeStatus =
  | {
      kind: "outside-herdr" | "missing" | "unsupported";
      compatible: false;
      message: string;
      version?: string;
      backend?: SurfaceBackend;
    }
  | {
      kind: "supported" | "untested";
      compatible: true;
      message?: string;
      version: string;
      backend?: SurfaceBackend;
    };

const commandAvailability = new Map<string, boolean>();
let installedHerdrStatus: HerdrRuntimeStatus | undefined;
let runtimeStatusCache: { key: string; status: HerdrRuntimeStatus } | undefined;

/**
 * Surfaces the environment points at, in the order they are checked. The
 * runtime check confirms the pane before a backend is used.
 */
export function surfaceCandidatesFromEnv(env: NodeJS.ProcessEnv): SurfaceBackend[] {
  const candidates: SurfaceBackend[] = [];
  if (env.HERDR_ENV === "1") candidates.push("herdr");
  if (env.HC_TERMINAL_ID) candidates.push("herdr-app");
  return candidates;
}

/** The first surface the environment points at, before any CLI check. */
export function surfaceBackendFromEnv(env: NodeJS.ProcessEnv): SurfaceBackend | "outside" {
  return surfaceCandidatesFromEnv(env)[0] ?? "outside";
}

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

function parseHerdrVersion(output: string): SemanticVersion | null {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function requiredVersion(version: string): SemanticVersion {
  const parsed = parseHerdrVersion(version);
  if (!parsed) throw new Error(`Invalid built-in Herdr version: ${version}`);
  return parsed;
}

function classifyHerdrVersionOutput(output: string): HerdrRuntimeStatus {
  const parsed = parseHerdrVersion(output);
  if (!parsed) {
    return {
      kind: "unsupported",
      compatible: false,
      message: `Could not parse \`herdr --version\` output: ${output.trim() || "<empty>"}`,
    };
  }

  if (compareVersions(parsed, requiredVersion(HERDR_MIN_VERSION)) < 0) {
    return {
      kind: "unsupported",
      compatible: false,
      version: parsed.raw,
      message: `Herdr ${parsed.raw} is too old; subagents require Herdr >=${HERDR_MIN_VERSION}.`,
    };
  }

  if (compareVersions(parsed, requiredVersion(HERDR_REVIEW_VERSION)) >= 0) {
    return {
      kind: "untested",
      compatible: true,
      version: parsed.raw,
      message:
        `Herdr ${parsed.raw} is outside the tested compatibility range ` +
        `(>=${HERDR_MIN_VERSION} <${HERDR_REVIEW_VERSION}); continuing without a compatibility guarantee.`,
    };
  }

  return { kind: "supported", compatible: true, version: parsed.raw };
}

function getInstalledHerdrStatus(): HerdrRuntimeStatus {
  if (installedHerdrStatus) return installedHerdrStatus;

  try {
    installedHerdrStatus = classifyHerdrVersionOutput(
      execFileSync("herdr", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch (error: any) {
    installedHerdrStatus = {
      kind: "unsupported",
      compatible: false,
      message: `Could not run \`herdr --version\`: ${error?.message ?? String(error)}`,
    };
  }
  return installedHerdrStatus;
}

function runtimeCacheKey(): string {
  return [process.env.HERDR_ENV, process.env.HERDR_PANE_ID, process.env.HC_TERMINAL_ID]
    .map((value) => value ?? "")
    .join("\0");
}

function getHerdrAppRuntimeStatus(): HerdrRuntimeStatus {
  if (!hasCommand("herdr-app") || !hasCommand("hc")) {
    return {
      kind: "missing",
      compatible: false,
      backend: "herdr-app",
      message: "Herdr app subagents need both the `herdr-app` and `hc` CLIs on PATH.",
    };
  }
  // No pane for this terminal (window closed, a pane-less `hc run` terminal,
  // or a leaked HC_TERMINAL_ID): this process is not in the Herdr app.
  const pane = currentAppPane();
  if ("error" in pane) {
    return { kind: "outside-herdr", compatible: false, backend: "herdr-app", message: pane.error };
  }
  const version = readHerdrAppVersionStatus();
  if (version.kind === "unsupported") {
    return {
      kind: "unsupported",
      compatible: false,
      backend: "herdr-app",
      version: version.version,
      message: version.message,
    };
  }
  return {
    kind: version.kind,
    compatible: true,
    backend: "herdr-app",
    version: version.version,
    ...(version.message ? { message: version.message } : {}),
  };
}

/**
 * Classify a failed `herdr pane current --current`. No server, or no such
 * pane, means this process is not in a herdr pane. Anything else (an older
 * CLI without the command, say) is not evidence either way.
 */
export function herdrPaneCheckSaysOutside(error: unknown): boolean {
  const err = error as { message?: unknown; stdout?: unknown; stderr?: unknown } | null;
  const text = [err?.message, err?.stdout, err?.stderr]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return /server_not_running|pane_not_found|no current pane/.test(text);
}

function getHerdrTuiRuntimeStatus(): HerdrRuntimeStatus {
  if (!hasCommand("herdr")) {
    return {
      kind: "missing",
      compatible: false,
      backend: "herdr",
      message: "The herdr CLI is not available on PATH.",
    };
  }
  const installed = { ...getInstalledHerdrStatus(), backend: "herdr" as const };
  if (!installed.compatible) return installed;
  try {
    herdr(["pane", "current", "--current"]);
  } catch (error) {
    if (herdrPaneCheckSaysOutside(error)) {
      return {
        kind: "outside-herdr",
        compatible: false,
        backend: "herdr",
        message: "HERDR_ENV=1 is set, but this process is not in a herdr pane.",
      };
    }
  }
  return installed;
}

/**
 * Inspect the terminal surface once per environment. Each candidate from
 * `surfaceCandidatesFromEnv` is checked in turn; one whose CLI is missing or
 * whose pane cannot be found is skipped. When none is usable, the first
 * failure is returned (`outside-herdr` or `missing`, so no tools register).
 */
export function getHerdrRuntimeStatus(): HerdrRuntimeStatus {
  const key = runtimeCacheKey();
  if (runtimeStatusCache?.key === key) return runtimeStatusCache.status;

  let status: HerdrRuntimeStatus | undefined;
  let firstSkipped: HerdrRuntimeStatus | undefined;
  for (const backend of surfaceCandidatesFromEnv(process.env)) {
    const candidate = backend === "herdr" ? getHerdrTuiRuntimeStatus() : getHerdrAppRuntimeStatus();
    if (candidate.kind === "outside-herdr" || candidate.kind === "missing") {
      firstSkipped ??= candidate;
      continue;
    }
    status = candidate;
    break;
  }
  status ??= firstSkipped ?? {
    kind: "outside-herdr",
    compatible: false,
    message:
      "Subagents require pi to run inside the Herdr app (HC_TERMINAL_ID) or herdr (HERDR_ENV=1).",
  };

  runtimeStatusCache = { key, status };
  return status;
}

/** True when the current Herdr runtime is present and not known to be incompatible. */
export function isHerdrAvailable(): boolean {
  return getHerdrRuntimeStatus().compatible;
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return (
    "Start pi in a Herdr app pane (`herdr-app`, with `hc` on PATH), " +
    `or inside herdr >=${HERDR_MIN_VERSION} (\`herdr\`, https://herdr.dev).`
  );
}

function requireSurface(): SurfaceBackend {
  const status = getHerdrRuntimeStatus();
  if (!status.compatible || !status.backend) {
    throw new Error(`${status.message ?? "No terminal surface available."} ${muxSetupHint()}`);
  }
  return status.backend;
}

export const __herdrVersionTest__ = { classifyHerdrVersionOutput, parseHerdrVersion };

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── CLI plumbing ──

/**
 * Run `herdr` synchronously and return stdout. Server errors are JSON on
 * stderr with exit status 1; Node folds that stderr into the thrown error's
 * `message`, so a non-zero exit still surfaces the JSON for callers that
 * detect a destroyed pane via `isPaneGoneError`.
 */
function herdr(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Run `herdr` asynchronously. */
async function herdrAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
  return stdout;
}

/** Parse the JSON envelope herdr CLI commands print (`{id, result, …}`). */
function parseCliJson(stdout: string): any {
  const parsed = JSON.parse(stdout);
  if (parsed?.error) {
    const message = parsed.error.message ?? parsed.error.code ?? "herdr CLI error";
    throw new Error(`herdr: ${message}`);
  }
  return parsed;
}

/** A herdr error mentioning a pane that no longer exists. */
function isPaneGoneError(error: any): boolean {
  const text = [
    error?.message ?? "",
    typeof error?.stdout === "string" ? error.stdout : "",
    typeof error?.stderr === "string" ? error.stderr : "",
  ].join(" ");
  return (
    text.includes("pane_not_found") ||
    text.includes("no pane ") ||
    /"kind"\s*:\s*"not_found"/.test(text)
  );
}

// ── Surface primitives ──

/**
 * Create the first pane in a subagent stack: a right split off the parent pi's
 * pane (`--current`), with the given working directory (defaults to the node
 * process cwd) and focus kept on the parent. Later panes can use
 * `createSurfaceSplit(..., "down", existingSurface)` to remain in the same
 * right-hand column. The pane is renamed to the subagent name (best-effort) so
 * the sidebar shows a useful label.
 *
 * Returns the new surface id (`w1:p3` on herdr, `herdr-app|<pane>|<terminal>`
 * in the Herdr app).
 */
export function createSurface(name: string, cwd?: string, options?: SurfaceOptions): string {
  return createSurfaceSplit(name, "right", undefined, cwd, options);
}

export interface SurfaceOptions {
  /**
   * The pane will run exactly one `sendLongCommand` script. In the Herdr app
   * the pane starts a launch bootstrap (`pane.split --argv`) and the script is
   * handed over as a file, with no typing and no shell-ready delay. herdr
   * ignores it and opens a shell as usual.
   */
  launch?: boolean;
}

/** Whether a command typed into `surface` must wait for shell startup. */
export function surfaceNeedsShellReadyDelay(surface: string): boolean {
  return !isPendingAppLaunch(surface);
}

/**
 * Create a new split in the given direction, optionally off a specific pane.
 * Both backends support `right` and `down`. Without `fromSurface`, the split
 * targets the calling pane. On herdr, `cwd` is the new pane's directory; the
 * Herdr app inherits the source pane's directory (`pane.split` has no folder).
 * Returns the new surface id.
 */
export function createSurfaceSplit(
  name: string,
  direction: "right" | "down",
  fromSurface?: string,
  cwd: string = process.cwd(),
  options?: SurfaceOptions,
): string {
  if (requireSurface() === "herdr-app") {
    return createAppSurfaceSplit(name, direction, fromSurface, options);
  }

  const args = [
    "pane",
    "split",
    fromSurface ? "--pane" : "--current",
    ...(fromSurface ? [fromSurface] : []),
    "--direction",
    direction === "right" ? "right" : "down",
    "--cwd",
    cwd,
    "--no-focus",
  ];
  const stdout = herdr(args);
  const paneId = parseCliJson(stdout)?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !/^\w+:\w+$/.test(paneId)) {
    throw new Error(`Unexpected herdr pane split output: ${stdout.trim()}`);
  }

  // Best-effort cosmetic label for the herdr sidebar/tab strip.
  if (name) {
    try {
      herdr(["pane", "rename", paneId, name]);
    } catch {
      // Renaming is cosmetic; never fail a spawn over it.
    }
  }

  return paneId;
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` submits text plus Enter atomically and honors the pane's live
 * bracketed-paste mode (equivalent to tmux send-keys -l + Enter).
 */
export function sendCommand(surface: string, command: string): void {
  if (requireSurface() === "herdr-app") {
    sendAppCommand(surface, command);
    return;
  }
  herdr(["pane", "run", surface, command]);
}

/**
 * Async `sendCommand`. Use it from tool handlers: `hc send` can wait up to
 * 60 s for a person's unfinished draft, and this keeps the event loop free.
 */
export async function sendCommandAsync(surface: string, command: string): Promise<void> {
  if (requireSurface() === "herdr-app") {
    await sendAppCommandAsync(surface, command);
    return;
  }
  await herdrAsync(["pane", "run", surface, command]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, `${scriptParts.join("\n")}\n`, {
    mode: 0o755,
  });
  if (!handOffAppLaunch(surface, scriptPath)) {
    sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  }
  return scriptPath;
}

/**
 * Floor for herdr `--lines`. herdr caps the `recent` window at the last N
 * *rendered* rows before joining soft wraps; small values both truncate and
 * (below the snapshot size) misbehave by returning nothing, so always ask
 * for a generous window and tail-slice in JS to the caller's line count.
 */
const HERDR_READ_FLOOR_LINES = 200;

/**
 * Read the screen contents of a pane (sync).
 *
 * Uses the `recent-unwrapped` snapshot (soft-wrapped rows joined — the right
 * source for logs and transcripts), requests a generous rendered-row window,
 * then keeps the last `lines` joined lines in JS.
 */
export function readScreen(surface: string, lines = 50): string {
  if (requireSurface() === "herdr-app") return readAppScreen(surface, lines);
  const text = herdr([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(lines, HERDR_READ_FLOOR_LINES)),
  ]);
  return tailLines(text, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (requireSurface() === "herdr-app") return readAppScreenAsync(surface, lines);
  const text = await herdrAsync([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(lines, HERDR_READ_FLOOR_LINES)),
  ]);
  return tailLines(text, lines);
}

/** Keep the last `lines` newline-delimited rows of a screen snapshot. */
function tailLines(text: string, lines: number): string {
  if (lines <= 0) return "";
  const rows = text.split("\n");
  return rows.length <= lines ? text : rows.slice(-lines).join("\n");
}

/**
 * Close a pane. A pane that is already gone (closed by the user from the
 * herdr UI, or torn down with its tab) counts as closed.
 */
export function closeSurface(surface: string): void {
  if (requireSurface() === "herdr-app") {
    closeAppSurface(surface);
    return;
  }
  try {
    herdr(["pane", "close", surface]);
  } catch (error) {
    if (isPaneGoneError(error)) return;
    throw error;
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write an `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

/** Consume the `.exit` sidecar if it exists. */
function takeExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;
  try {
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) {
      const data = JSON.parse(readFileSync(exitFile, "utf-8"));
      rmSync(exitFile, { force: true });
      return interpretExitSidecar(data);
    }
  } catch {}
  return null;
}

const PANE_CLOSED_MESSAGE = "Subagent pane closed before completion (pane_not_found).";
const TERMINAL_REPLACED_MESSAGE =
  "Subagent terminal was replaced by a fresh shell (herdr-core restarted) before completion (pane_not_found).";

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    const early = takeExitSidecar(options.sessionFile);
    if (early) return early;

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
      // Herdr app keeps a finished terminal's screen readable, so reads do
      // not fail when the pane goes. A gone or replaced terminal with no
      // sentinel is the pane-gone case.
      if (decodeAppSurface(surface)) {
        const state = await appTerminalStateAsync(surface);
        if (state !== "live") {
          const late = takeExitSidecar(options.sessionFile);
          if (late) return late;
          return {
            reason: "error",
            exitCode: 1,
            errorMessage: state === "replaced" ? TERMINAL_REPLACED_MESSAGE : PANE_CLOSED_MESSAGE,
          };
        }
      }
    } catch (error) {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      const late = takeExitSidecar(options.sessionFile);
      if (late) return late;
      if (isPaneGoneError(error)) {
        // The pane was destroyed without a sentinel (closed by the user, a
        // multiplexer restart, or a fatal-stall escalation). Return instead of
        // looping forever — the parent must be woken either way.
        return { reason: "error", exitCode: 1, errorMessage: PANE_CLOSED_MESSAGE };
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
