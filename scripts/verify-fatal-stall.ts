/**
 * Live verification of the fatal-stall escalation.
 *
 * Spawns a REAL child pi with a model that has no API key (openrouter), lets
 * it sit at its prompt like the reported failure case, then drives the
 * extension's maybeEscalateFatalStall through the same per-tick observation
 * the watcher performs.
 *
 * Run inside herdr:  node --experimental-strip-types scripts/verify-fatal-stall.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import {
  closeSurface,
  createSurface,
  pollForExit,
  sendLongCommand,
} from "../pi-extension/subagents/herdr.ts";
import {
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusObservation,
} from "../pi-extension/subagents/status.ts";
import * as subagents from "../pi-extension/subagents/index.ts";

const testApi = (subagents as any).__test__;
const dir = mkdtempSync(join(tmpdir(), "stall-verify-"));
const sessionFile = join(dir, "stall.jsonl");
const activityFile = join(dir, "activity.json");
const scriptFile = join(dir, "launch.sh");
const subagentDonePath = join(
  fileURLToPath(new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url)),
);

function observe(read: ReturnType<typeof readSubagentActivityFile>) {
  const observation: StatusObservation = read.ok
    ? {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
      }
    : { snapshot: read.reason, snapshotError: read.error };
  running.statusState = observeStatus(running.statusState, observation, Date.now());
}

console.log("[1] creating pane…");
const surface = createSurface("stall-verify");
console.log("    surface:", surface);
await new Promise((r) => setTimeout(r, 1500));

console.log("[2] launching child pi with an unauthenticated openrouter model…");
const command = [
  "PI_SUBAGENT_NAME=stall-verify",
  "PI_SUBAGENT_ID=verify01",
  `PI_SUBAGENT_ACTIVITY_FILE='${activityFile}'`,
  `PI_SUBAGENT_SESSION='${sessionFile}'`,
  "PI_SUBAGENT_AUTO_EXIT=1",
  "pi",
  "--session", `'${sessionFile}'`,
  "-e", `'${subagentDonePath}'`,
  "--model", "'openrouter/google/gemini-2.0-flash-001'",
  "'Reply with the word hello.'",
].join(" ");
sendLongCommand(surface, command, { scriptPath: scriptFile });

// Same shape the watcher tracks, same per-tick steps as watchSubagent's onTick.
const running: any = {
  id: "verify01",
  name: "stall-verify",
  task: "",
  surface,
  startTime: Date.now(),
  sessionFile,
  interactive: false,
  statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
};

let escalated = false;
const deadline = Date.now() + 100_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));

  observe(readSubagentActivityFile(activityFile, "verify01"));

  const snapshot = classifyStatus(running.statusState, Date.now());
  const elapsedS = Math.floor((Date.now() - running.startTime) / 1000);
  process.stdout.write(
    `    t=${String(elapsedS).padStart(3)}s status=${snapshot.kind.padEnd(8)}\n`,
  );

  if (elapsedS >= 61 && snapshot.kind === "stalled") {
    console.log("[3] stalled at startup — driving maybeEscalateFatalStall…");
    testApi.maybeEscalateFatalStall(running);
    escalated = true;
    break;
  }
}

if (!escalated) {
  console.log("✗ FAIL: escalation never triggered within 100s");
  closeSurface(surface);
  process.exit(1);
}

const exitFile = `${sessionFile}.exit`;
console.log("[4] .exit sidecar exists:", existsSync(exitFile));
if (!existsSync(exitFile)) {
  console.log("✗ FAIL: no sidecar written");
  closeSurface(surface);
  process.exit(1);
}
const sidecar = JSON.parse(readFileSync(exitFile, "utf8"));
console.log(`    errorMessage: ${sidecar.errorMessage}`);

console.log("[5] watcher fast path resolves the sidecar…");
const abort = new AbortController().signal;
const result = await pollForExit(surface, abort, { interval: 1000, sessionFile });
console.log("    pollForExit →", JSON.stringify(result));
if (result.reason !== "error" || !/No API key|never started/i.test(result.errorMessage ?? "")) {
  console.log("✗ FAIL: watcher did not surface the error");
  process.exit(1);
}

try {
  closeSurface(surface);
  console.log("[6] pane already closed by escalation ✓");
} catch (e: any) {
  console.log(`[6] pane still open: ${e.message}`);
}

rmSync(dir, { recursive: true, force: true });
console.log("\n✓ PASS — the parent would receive:");
console.log(`  ✗ Sub-agent "stall-verify" (researcher) — failed (provider/agent error) · 1m 0s`);
console.log(`    Error: ${sidecar.errorMessage}`);
