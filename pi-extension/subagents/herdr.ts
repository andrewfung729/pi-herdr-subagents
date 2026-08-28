/**
 * herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr CLI calls isolated here means
 * index.ts stays testable without a multiplexer running.
 *
 * Panes are identified by herdr workspace-qualified pane ids (e.g. `w1:p1`).
 * A split can target the parent pi pane (`--current`, resolved from
 * HERDR_PANE_ID) or an explicit pane id, so callers can build a stable
 * two-column layout with subagents stacked vertically on the right.
 *
 * Ported from the tmux surface of amosblomqvist/pi-interactive-subagents.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

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

/**
 * True when running inside a herdr pane with the herdr binary on PATH.
 * `HERDR_ENV=1` is set by herdr in every process it spawns.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside herdr (https://herdr.dev) — `brew install herdr`, then run `herdr` and start pi in a pane.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── CLI plumbing ──

/**
 * Run `herdr` synchronously and return stdout. Server errors are JSON on
 * stdout with exit status 1, so a non-zero exit surfaces as an exception
 * carrying that JSON (callers use it to detect a destroyed pane).
 */
function herdr(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
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
  const text = `${error?.message ?? ""} ${typeof error?.stdout === "string" ? error.stdout : ""}`;
  return text.includes("pane_not_found");
}

// ── Surface primitives ──

/**
 * Create the first pane in a subagent stack: a right split off the parent pi's
 * pane (`--current`), with the caller's working directory preserved and focus
 * kept on the parent. Later panes can use `createSurfaceSplit(..., "down",
 * existingSurface)` to remain in the same right-hand column. The pane is
 * renamed to the subagent name (best-effort) so the herdr sidebar shows a
 * useful label.
 *
 * Returns the new pane id (e.g. `w1:p3`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new split in the given direction, optionally off a specific pane.
 * herdr only supports `right` and `down` splits. Without `fromSurface`, the
 * split targets the calling pane (`--current`).
 * Returns the new pane id (e.g. `w1:p3`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "right" | "down",
  fromSurface?: string,
): string {
  void name;
  requireHerdr();

  const args = [
    "pane",
    "split",
    fromSurface ? "--pane" : "--current",
    ...(fromSurface ? [fromSurface] : []),
    "--direction",
    direction === "right" ? "right" : "down",
    "--cwd",
    process.cwd(),
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
  requireHerdr();
  herdr(["pane", "run", surface, command]);
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
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
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
  requireHerdr();
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
  requireHerdr();
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
  requireHerdr();
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
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
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
