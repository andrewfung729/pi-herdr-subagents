/**
 * Integration tests for the herdr surface layer.
 *
 * These tests exercise real herdr operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside herdr:
 *   herdr 'npm run test:integration'
 */

import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  cleanupTestEnv,
  closeSurface,
  createTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  getAvailableBackends,
  getCurrentPaneId,
  getFocusedSurface,
  getPaneLayout,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendLongCommand,
  sleep,
  type TestEnv,
  uniqueId,
  untrackSurface,
  waitForFile,
  waitForScreen,
} from "./harness.ts";

const backends = getAvailableBackends();
const SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "1500");

if (backends.length === 0) {
  console.log("⚠️  herdr is not available — skipping herdr-surface integration tests");
  console.log("   Run inside herdr (HERDR_ENV=1) to enable these tests.");
}

for (const backend of backends) {
  describe(`herdr-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("keeps the parent left and stacks subagent surfaces on the right", async () => {
      const caller = getCurrentPaneId();
      const focusBefore = getFocusedSurface();
      assert.ok(focusBefore !== null, "Expected a focused pane in the herdr session");

      // The first subagent splits right from the caller.
      const childA = createTrackedSurface(env, "focus-child-a");
      const layoutAfterFirst = getPaneLayout(caller);
      const callerAfterFirst = layoutAfterFirst.panes.find((pane) => pane.pane_id === caller);
      const childAfterFirst = layoutAfterFirst.panes.find((pane) => pane.pane_id === childA);
      assert.ok(callerAfterFirst);
      assert.ok(childAfterFirst);

      // The second subagent splits down from the first, not right from the
      // caller. The caller therefore keeps exactly the same left-column rect.
      const childB = createTrackedSurfaceSplit(env, "focus-child-b", "down", childA);
      const layoutAfterSecond = getPaneLayout(caller);
      const callerAfterSecond = layoutAfterSecond.panes.find((pane) => pane.pane_id === caller);
      const childTop = layoutAfterSecond.panes.find((pane) => pane.pane_id === childA);
      const childBottom = layoutAfterSecond.panes.find((pane) => pane.pane_id === childB);
      assert.ok(callerAfterSecond);
      assert.ok(childTop);
      assert.ok(childBottom);
      assert.deepEqual(callerAfterSecond.rect, callerAfterFirst.rect);
      assert.equal(childTop.rect.x, childAfterFirst.rect.x);
      assert.equal(childBottom.rect.x, childAfterFirst.rect.x);
      assert.equal(childTop.rect.width, childAfterFirst.rect.width);
      assert.equal(childBottom.rect.width, childAfterFirst.rect.width);
      assert.ok(childTop.rect.y < childBottom.rect.y);

      await sleep(SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), focusBefore);

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), focusBefore);
      assert.equal(getCurrentPaneId(), caller);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(screen.includes(`SPEC_${marker}`), `Expected special-char output. Got:\n${screen}`);
      // $ should be literal inside single quotes
      assert.ok(screen.includes("$HOME"), `Expected literal $HOME in output. Got:\n${screen}`);
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(SHELL_READY_DELAY_MS);

      const marker = uniqueId();
      const filePath = `/tmp/pi-herdr-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });

    it("closing an already-closed surface is a no-op", async () => {
      const surface = createTrackedSurface(env, "double-close-test");
      await sleep(SHELL_READY_DELAY_MS);
      closeSurface(surface);
      untrackSurface(env, surface);
      // A pane closed from the herdr UI must not fail the watcher's cleanup.
      closeSurface(surface);
    });
  });
}
