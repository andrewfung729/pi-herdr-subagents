import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  __herdrVersionTest__,
  __pollForExitTest__,
  shellEscape,
} from "../pi-extension/subagents/herdr.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  formatModelMenu,
  resolveSpawnModel,
  splitThinkingSuffix,
} from "../pi-extension/subagents/models.ts";
import {
  mergeExtensionPaths,
  resolvePackageEntryPaths,
  resolvePackageExtensions,
} from "../pi-extension/subagents/packages.ts";
import {
  appendBranchSummary,
  copySessionFile,
  countSessionEntryLines,
  findLastAssistantMessage,
  getLeafId,
  getNewEntries,
  getSessionId,
  loadoutSidecarPath,
  mergeNewEntries,
  nameRegistryPath,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resetSessionIndexCache,
  resolveNameInRegistry,
  resolveSessionFileById,
  type SubagentLoadout,
  seedSubagentSessionFile,
  summarizeSessionStats,
  writeSubagentLoadout,
} from "../pi-extension/subagents/session.ts";
import {
  advanceStatusState,
  CONFIG_FILE_NAME,
  capStatusLines,
  classifyStatus,
  createStatusState,
  DEFAULT_STATUS_CONFIG,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  loadStatusConfig,
  observeStatus,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import subagentDoneExtension, {
  findLatestAssistantError,
  runningChildrenCount,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
} from "../pi-extension/subagents/subagent-done.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function registerSubagentsForTest(api: any) {
  (subagentsModule as any).__test__.registerExtension(api);
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, `${JSON.stringify({ type: "session", id: "x" })}\n\n\n`);
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, `${JSON.stringify({ type: "session", id, version: 3 })}\n`);
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,web_search,subagent,ask_question",
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), `${sf}.loadout.json`);
      assert.ok(existsSync(`${sf}.loadout.json`));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(`${sf}.loadout.json`, "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(
        entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile),
        false,
      );
      assert.equal(
        entries.some((entry) => entry.type === "message"),
        false,
      );
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        `${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
      writeFileSync(
        targetFile,
        `${[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`,
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (
      id: string,
      opts: {
        model?: string;
        tools?: string[];
        usage?: Record<string, unknown>;
      },
    ) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 1000,
            cacheWrite: 200,
            totalTokens: 1350,
            cost: { total: 0.01 },
          },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: {
            input: 30,
            output: 70,
            cacheRead: 2000,
            cacheWrite: 0,
            totalTokens: 3500,
            cost: { total: 0.02 },
          },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", {
          model: "claude-sonnet-4-6",
          usage: { totalTokens: 10, cost: { total: 0 } },
        }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("uses built-in defaults when no config files exist", () => {
    withTempDir((dir) => {
      const config = loadStatusConfig({ agentDir: dir, cwd: join(dir, "project") });
      assert.deepEqual(config, DEFAULT_STATUS_CONFIG);
    });
  });

  it("loads agent-dir config", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, CONFIG_FILE_NAME),
        `${JSON.stringify({ status: { enabled: false } }, null, 2)}\n`,
      );

      const config = loadStatusConfig({ agentDir: dir });
      assert.deepEqual(config, {
        enabled: false,
        lineLimit: 4,
      });
    });
  });

  it("lets project config override agent-dir config", () => {
    withTempDir((dir) => {
      const projectDir = join(dir, "project");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(
        join(dir, CONFIG_FILE_NAME),
        `${JSON.stringify({ status: { enabled: false } }, null, 2)}\n`,
      );
      writeFileSync(
        join(projectDir, ".pi", CONFIG_FILE_NAME),
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      );

      const config = loadStatusConfig({ agentDir: dir, cwd: projectDir });
      assert.equal(config.enabled, true);
    });
  });

  it("accepts partial overlays that omit status.enabled", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, CONFIG_FILE_NAME), `${JSON.stringify({}, null, 2)}\n`);
      assert.deepEqual(loadStatusConfig({ agentDir: dir }), DEFAULT_STATUS_CONFIG);
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
    assert.throws(() => parseStatusConfig({ status: {} }), /status\.enabled must be a boolean/);
  });

  it("reports invalid JSON from the agent-dir config", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, CONFIG_FILE_NAME), "{\n");

      assert.throws(
        () => loadStatusConfig({ agentDir: dir }),
        new RegExp(`Invalid JSON in subagent config .*${CONFIG_FILE_NAME}`),
      );
    });
  });

  it("fails on invalid project config instead of keeping the agent-dir value", () => {
    withTempDir((dir) => {
      const projectDir = join(dir, "project");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(
        join(dir, CONFIG_FILE_NAME),
        `${JSON.stringify({ status: { enabled: false } }, null, 2)}\n`,
      );
      writeFileSync(join(projectDir, ".pi", CONFIG_FILE_NAME), "{\n");

      assert.throws(
        () => loadStatusConfig({ agentDir: dir, cwd: projectDir }),
        new RegExp(`Invalid JSON in subagent config .*${CONFIG_FILE_NAME}`),
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      5_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: "present",
        updatedAt: 96_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 96_000,
        latestEvent: "agent_end",
      },
      96_000,
    );
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 5_000,
      },
      5_000,
    );
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 10_000,
        activityLabel: "bash",
      },
      10_000,
    );

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 3,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_001,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      11_000,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      21_000,
    );
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(
      stale,
      {
        snapshot: "present",
        updatedAt: 20_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 20_000,
        activityLabel: "bash",
      },
      22_000,
    );
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(
      sameTimestamp,
      {
        snapshot: "present",
        sequence: 2,
        updatedAt: 25_000,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 25_000,
        activityLabel: "streaming",
      },
      25_000,
    );
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(
      longName,
      classifyStatus(activeState, 300_000),
      "recovered",
    );

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine(
      "Worker",
      classifyStatus(activeState, 420_000),
      "recovered",
    );
    const lines = [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
      "Reviewer running 4m.",
      "Planner running 6m.",
    ];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        ["name: interactive-unset-test-agent", "model: anthropic/test-interactive-unset"].join(
          "\n",
        ),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}), true);
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null), true);
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: false }),
      false,
    );
  });

  it("bundled scout/researcher/worker all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("bundled scout/researcher/worker defaults include codemode", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      const tools = new Set(
        (defs.tools ?? "")
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean),
      );
      assert.ok(tools.has("codemode"), `expected ${name} tools to include codemode`);
    }
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", async () => {
    await withIsolatedAgentEnv(async ({ globalDir }) => {
      // Extension-backed tools only map when their backing extension file
      // exists on disk — stub the expected install layout so the test is
      // hermetic instead of depending on the developer's global extensions.
      mkdirSync(join(globalDir, "extensions", "web-search"), { recursive: true });
      writeFileSync(join(globalDir, "extensions", "web-search", "index.ts"), "stub\n");

      assert.equal(testApi.getToolExtensionPath("read"), undefined);
      assert.equal(testApi.getToolExtensionPath("bash"), undefined);
      assert.ok(testApi.getToolExtensionPath("web_search")?.endsWith("web-search/index.ts"));
      // Spawning tools are registered by this extension itself.
      assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
    });
  });

  it("getToolExtensionPath resolves pi-web-access tools from the npm package layout", async () => {
    await withIsolatedAgentEnv(async ({ globalDir }) => {
      const pkg = join(globalDir, "npm", "node_modules", "pi-web-access");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "index.ts"), "stub\n");

      // One package entry registers every web tool; all names resolve to it.
      for (const tool of ["web_search", "fetch_content", "source_check", "get_search_content"]) {
        assert.ok(
          testApi.getToolExtensionPath(tool)?.endsWith(join("pi-web-access", "index.ts")),
          `expected ${tool} to resolve to the pi-web-access entry`,
        );
      }
      // Legacy upstream names no longer resolve on their own.
      assert.equal(testApi.getToolExtensionPath("web_fetch"), undefined);
      assert.equal(testApi.getToolExtensionPath("youtube_search"), undefined);
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves a relative spawn cwd against the session cwd, not process.cwd()", () => {
    const sessionCwd = mkdtempSync(join(tmpdir(), "subagent-session-cwd-"));
    try {
      const { effectiveCwd } = testApi.resolveSubagentPaths(
        { name: "A", task: "T", agent: "scout", cwd: "role" },
        null,
        sessionCwd,
      );
      assert.equal(effectiveCwd, join(sessionCwd, "role"));
    } finally {
      rmSync(sessionCwd, { recursive: true, force: true });
    }
  });

  it("passes an absolute spawn cwd through unchanged", () => {
    const { effectiveCwd } = testApi.resolveSubagentPaths(
      { name: "A", task: "T", agent: "scout", cwd: "/tmp/abs-role" },
      null,
      "/tmp/anywhere",
    );
    assert.equal(effectiveCwd, "/tmp/abs-role");
  });

  it("resolves an agent frontmatter cwd against the agent config dir", async () => {
    await withIsolatedAgentEnv(async ({ globalDir, projectDir }) => {
      const { effectiveCwd } = testApi.resolveSubagentPaths(
        { name: "A", task: "T", agent: "scout" },
        { cwd: "roles/sre" },
        projectDir,
      );
      assert.equal(effectiveCwd, join(globalDir, "roles", "sre"));
    });
  });

  it("returns null cwd when neither params nor frontmatter specify one", () => {
    const { effectiveCwd } = testApi.resolveSubagentPaths(
      { name: "A", task: "T", agent: "scout" },
      null,
      "/tmp/anywhere",
    );
    assert.equal(effectiveCwd, null);
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T" },
        { sessionMode: "lineage-only" },
      ),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,bash",
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("applySandboxToParts loads builtin:codemode once when allowlist includes codemode", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      // Duplicate entries and surrounding whitespace must still produce exactly one
      // -e builtin:codemode (token match, not raw substring).
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read, codemode,bash,codemode",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );

      const builtinPairs: string[] = [];
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === "-e" && parts[i + 1].includes("builtin:codemode")) {
          builtinPairs.push(parts[i + 1]);
        }
      }
      assert.equal(
        builtinPairs.length,
        1,
        `expected exactly one -e builtin:codemode, got ${builtinPairs.join(", ")}`,
      );
      assert.ok(
        builtinPairs[0] === "'builtin:codemode'" || builtinPairs[0] === "builtin:codemode",
        `expected shell-escaped or raw builtin:codemode, got ${builtinPairs[0]}`,
      );
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      assert.ok(
        parts[toolsIdx + 1].includes("codemode"),
        "expected codemode to remain in the --tools allowlist",
      );
    });
  });

  it("applySandboxToParts does not load builtin:codemode for ordinary allowlists", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "scout",
          toolAllowlist: "read,bash",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "scout" },
      );

      const joined = parts.join(" ");
      assert.ok(
        !joined.includes("builtin:codemode"),
        "ordinary allowlist must not load builtin:codemode",
      );
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
    });
  });

  it("applySandboxToParts does not inject builtin:codemode for unrestricted loadouts", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
      assert.ok(!parts.join(" ").includes("builtin:codemode"));
    });
  });

  describe("resolveSpawnModel", () => {
    const scoped = [
      { provider: "zai", id: "glm-5.3" },
      { provider: "zai", id: "glm-5.3-flash" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ];
    const session = { provider: "zai", id: "glm-5.3-flash" };

    it("passes a scoped model reference through unchanged", () => {
      assert.deepEqual(resolveSpawnModel({ requestedModel: "zai/glm-5.3", scopedModels: scoped }), {
        model: "zai/glm-5.3",
        warning: null,
      });
    });

    it("matches a bare id and is case-insensitive", () => {
      const r = resolveSpawnModel({ requestedModel: "GLM-5.3-FLASH", scopedModels: scoped });
      assert.equal(r.model, "GLM-5.3-FLASH");
      assert.equal(r.warning, null);
    });

    it("accepts a thinking suffix on a scoped reference", () => {
      assert.deepEqual(
        resolveSpawnModel({ requestedModel: "zai/glm-5.3:high", scopedModels: scoped }),
        { model: "zai/glm-5.3:high", warning: null },
      );
    });

    it("falls back to the session model with a warning when the request is out of scope", () => {
      const r = resolveSpawnModel({
        requestedModel: "openrouter/z-ai/glm-5.3",
        sessionModel: session,
        scopedModels: scoped,
      });
      assert.equal(r.model, "zai/glm-5.3-flash");
      assert.match(r.warning ?? "", /openrouter\/z-ai\/glm-5\.3/);
      assert.match(r.warning ?? "", /zai\/glm-5\.3-flash/);
    });

    it("falls back to the agent pin before the session model", () => {
      const r = resolveSpawnModel({
        requestedModel: "flash",
        agentModel: "anthropic/claude-haiku-4-5",
        sessionModel: session,
        scopedModels: scoped,
      });
      assert.equal(r.model, "anthropic/claude-haiku-4-5");
      assert.match(r.warning ?? "", /pinned/);
    });

    it("falls back to pi default when nothing else is set", () => {
      const r = resolveSpawnModel({ requestedModel: "nope", scopedModels: scoped });
      assert.equal(r.model, null);
      assert.match(r.warning ?? "", /pi default/);
    });

    it("skips validation when no scoped models are configured", () => {
      assert.deepEqual(resolveSpawnModel({ requestedModel: "anything/at-all", scopedModels: [] }), {
        model: "anything/at-all",
        warning: null,
      });
    });

    it("defaults to the spawning session's model", () => {
      assert.deepEqual(resolveSpawnModel({ sessionModel: session, scopedModels: scoped }), {
        model: "zai/glm-5.3-flash",
        warning: null,
      });
    });

    it("prefers the agent pin over the session model", () => {
      const r = resolveSpawnModel({
        agentModel: "anthropic/claude-haiku-4-5",
        sessionModel: session,
        scopedModels: scoped,
      });
      assert.equal(r.model, "anthropic/claude-haiku-4-5");
      assert.equal(r.warning, null);
    });

    it("returns null when nothing is specified", () => {
      assert.deepEqual(resolveSpawnModel({ scopedModels: scoped }), { model: null, warning: null });
    });
  });

  describe("splitThinkingSuffix", () => {
    it("splits valid thinking-level suffixes", () => {
      assert.deepEqual(splitThinkingSuffix("zai/glm-5.3:high"), {
        base: "zai/glm-5.3",
        suffix: "high",
      });
    });

    it("keeps colon-containing ids that do not end in a thinking level", () => {
      assert.deepEqual(splitThinkingSuffix("openrouter/openai/gpt-5.4:exacto"), {
        base: "openrouter/openai/gpt-5.4:exacto",
        suffix: null,
      });
    });
  });

  describe("formatModelMenu", () => {
    it("lists scoped ids and the session default", () => {
      const menu = formatModelMenu({
        sessionModel: { provider: "zai", id: "glm-5.3-flash" },
        scopedModels: [
          { provider: "zai", id: "glm-5.3" },
          { provider: "zai", id: "glm-5.3-flash" },
        ],
      });
      assert.match(menu, /current model \(zai\/glm-5\.3-flash\)/);
      assert.match(menu, /zai\/glm-5\.3, zai\/glm-5\.3-flash/);
    });

    it("notes when no scoped models are configured", () => {
      const menu = formatModelMenu({
        sessionModel: { provider: "zai", id: "glm-5.3-flash" },
        scopedModels: [],
      });
      assert.match(menu, /No scoped models are configured/);
    });

    it("falls back to pi default wording without a session model", () => {
      const menu = formatModelMenu({ sessionModel: null, scopedModels: null });
      assert.match(menu, /pi's default model/);
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review,lint",
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review",
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      registerSubagentsForTest(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call-1", {}, undefined, undefined, {
        model: { provider: "zai", id: "glm-5.3-flash" },
        scopedModels: [{ model: { provider: "zai", id: "glm-5.3" } }],
      } as any);
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
      // The scoped-model menu is appended for spawn-time `model` choices.
      assert.match(result.content[0].text, /Model selection/);
      assert.match(result.content[0].text, /current model \(zai\/glm-5\.3-flash\)/);
      assert.match(result.content[0].text, /zai\/glm-5\.3/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      registerSubagentsForTest(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call-1", {}, undefined, undefined, {
        model: null,
        scopedModels: [],
      } as any);
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      registerSubagentsForTest(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call-1", {}, undefined, undefined, {
        model: null,
        scopedModels: [],
      } as any);
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(
        () => 3,
        () => {
          assert.equal(runningChildrenCount(), 3);
        },
      );
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(
        () => 0,
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => -1,
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => "two",
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => {
          throw new Error("boom");
        },
        () => assert.equal(runningChildrenCount(), 0),
      );
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question as model-only (not codemode-callable)", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.ok(tool, "expected ask_question to be registered");
        assert.equal(
          tool.exposure,
          "model-only",
          "ask_question must be model-only so codemode scripts cannot block on it",
        );
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = {
          shutdown() {
            shutdownCalled = true;
          },
        } as any;
        const out = await tool.execute(
          "call-1",
          { question: "Which API base URL?" },
          undefined,
          undefined,
          ctx,
        );

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        const askFile = `${sessionFile}.ask`;
        assert.ok(existsSync(askFile), ".ask signal file should be written");
        const payload = JSON.parse(readFileSync(askFile, "utf-8"));
        assert.equal(payload.question, "Which API base URL?");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        // No .exit sidecar — the session is not exiting.
        assert.ok(!existsSync(`${sessionFile}.exit`));
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    function setupCapturingExtension(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) {
          tools.push(t);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        sendUserMessage() {},
        sendMessage() {},
        getAllTools() {
          return [];
        },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) => {
        for (const h of handlers.get(event) ?? []) h(...args);
      };
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = async () => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, {
          shutdown() {},
        });
      };
      return { emit, ask, restore };
    }

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets awaitingAnswer mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        let shutdown = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown = true;
            },
          },
        );
        assert.equal(shutdown, true, "reply consumed mid-run → agent_end should exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let shutdown = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown = true;
            },
          },
        );
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let shutdown1 = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown1 = true;
            },
          },
        );
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        let shutdown2 = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown2 = true;
            },
          },
        );
        assert.equal(shutdown2, true, "after the reply turn, agent_end should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("herdr.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("no longer decodes ping payloads (ask_question keeps the session open instead)", () => {
    // ask_question writes a `.ask` signal, not a `.exit` ping sidecar, so an
    // unknown `type: "ping"` payload now falls through to a clean done.
    assert.deepEqual(interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    registerSubagentsForTest(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    registerSubagentsForTest(api);
    assert.equal(
      registeredCommands.find((c) => c.name === "iterate"),
      undefined,
    );
    assert.equal(
      registeredCommands.find((c) => c.name === "plan"),
      undefined,
    );
  });
});

describe("tool registration", () => {
  it("does not register tools or commands outside herdr", () => {
    const originalHerdrEnv = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;

    try {
      const { api, registeredTools, registeredCommands, registeredMessageRenderers } =
        createMockExtensionApi();
      (subagentsModule as any).default(api);

      assert.deepEqual(registeredTools, []);
      assert.deepEqual(registeredCommands, []);
      assert.deepEqual(registeredMessageRenderers, []);
    } finally {
      restoreEnvVar("HERDR_ENV", originalHerdrEnv);
    }
  });

  it("registers orchestration tools as model-only (not codemode-callable)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);
    for (const name of ["subagent", "subagent_message", "subagents_list"]) {
      const tool = registeredTools.find((t) => t.name === name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.equal(
        tool.exposure,
        "model-only",
        `${name} must be model-only so codemode scripts cannot call it`,
      );
    }
  });

  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });

  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // `name` is now optional and purely cosmetic.
    assert.match(props.name.description, /cosmetic/i);
    // The removed override knobs must be gone.
    for (const gone of [
      "tools",
      "skills",
      "systemPrompt",
      "fork",
      "interactive",
      "resumeSessionId",
    ]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("no longer registers subagent_interrupt or subagent_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and not the old interrupt/resume tools", () => {
    const { api, registeredTools } = createMockExtensionApi();
    registerSubagentsForTest(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set(
        "a1",
        makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }),
      );
      runningMap.set(
        "b2",
        makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }),
      );
      runningMap.set(
        "c3",
        makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }),
      );

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("reserves unique names even when callers explicitly reuse a cosmetic name", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      assert.equal(testApi.reserveUniqueSubagentName("researcher", "Researcher"), "Researcher");
      assert.equal(testApi.reserveUniqueSubagentName("researcher", "Researcher"), "Researcher-2");
      assert.deepEqual([...reserved], ["Researcher", "Researcher-2"]);
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("only steers the parent once the autonomous completion batch is done", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const launching = testApi.launchingSubagentSurfaces as Set<string>;
    runningMap.clear();
    launching.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", interactive: false }));
      assert.deepEqual(testApi.subagentResultDeliveryOptions(), {
        triggerTurn: false,
        deliverAs: "steer",
      });

      // Interactive panes should not indefinitely block autonomous result delivery.
      runningMap.set("a1", makeRunning({ id: "a1", interactive: true }));
      assert.deepEqual(testApi.subagentResultDeliveryOptions(), {
        triggerTurn: true,
        deliverAs: "steer",
      });

      runningMap.clear();
      launching.add("starting-pane");
      assert.deepEqual(testApi.subagentResultDeliveryOptions(), {
        triggerTurn: false,
        deliverAs: "steer",
      });

      launching.clear();
      assert.deepEqual(testApi.subagentResultDeliveryOptions(), {
        triggerTurn: true,
        deliverAs: "steer",
      });
    } finally {
      runningMap.clear();
      launching.clear();
    }
  });

  it("stacks concurrent subagent surfaces below the newest right-hand pane", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const launching = testApi.launchingSubagentSurfaces as Set<string>;
    runningMap.clear();
    launching.clear();

    try {
      // No existing subagent means the first launch should split right from the parent.
      assert.equal(testApi.selectSubagentSurfaceAnchor(), undefined);

      runningMap.set("a1", makeRunning({ id: "a1", surface: "right-top" }));
      assert.equal(testApi.selectSubagentSurfaceAnchor(), "right-top");

      // A pane still in its shell-ready delay is newer than registered panes.
      // This reservation is what makes simultaneous tool calls stack correctly.
      launching.add("right-bottom");
      assert.equal(testApi.selectSubagentSurfaceAnchor(), "right-bottom");
    } finally {
      runningMap.clear();
      launching.clear();
    }
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(
      running,
      "do this\nthen that",
      (surface: string, text: string) => {
        sentSurface = surface;
        sentText = text;
      },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer(
          { name: "Worker", message: "keep going" },
          (surface: string, text: string) => {
            sentSurface = surface;
            sentText = text;
          },
        ),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(
        result.content[0].text.includes('Message delivered to running subagent "Worker"'),
        true,
      );
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });

  it("strips ANSI codes from screen snapshots", () => {
    const testApi = (subagentsModule as any).__test__;
    const strip = testApi.stripAnsiCodes as (text: string) => string;

    const raw =
      "\x1b[38;2;224;108;117mError: No API key found for openrouter.\x1b[0m\n" +
      "\x1b[2mUse /login to log into a provider.\x1b[0m";
    assert.equal(
      strip(raw),
      "Error: No API key found for openrouter.\nUse /login to log into a provider.",
    );
  });

  it("extracts the pi error banner from a stalled pane's screen", () => {
    const testApi = (subagentsModule as any).__test__;
    const extract = testApi.extractScreenErrorText as (screen: string) => string | null;

    // What the pane looks like after a pre-flight auth failure (screenshot case).
    const screen = [
      "[Extensions]",
      "pi-web-access, subagent-done.ts",
      "",
      "\x1b[31mError: \x1b[0m\x1b[31mNo API key found for openrouter.\x1b[0m",
      "",
      "Use /login to log into a provider via OAuth or API key.",
      "[researcher] — 3 tools  (Ctrl+Alt+O to expand)",
      "~/dev/pi-herdr-subagents (master)",
    ].join("\n");
    assert.equal(extract(screen), "No API key found for openrouter.");

    // Shell-level launch failure.
    assert.equal(
      extract("bash: line 3: pi: command not found"),
      "bash: line 3: pi: command not found",
    );

    // Most recent banner wins.
    assert.equal(extract("Error: first failure\nError: second failure"), "second failure");

    // No recognizable error → null.
    assert.equal(extract("npm test\nall tests passed"), null);
  });

  it("builds a bounded single-line excerpt of the screen tail", () => {
    const testApi = (subagentsModule as any).__test__;
    const excerpt = testApi.screenTailExcerpt as (screen: string, maxChars?: number) => string;

    const text = excerpt("\x1b[31mline one\x1b[0m\nline two\nline three", 200);
    assert.equal(text, "line one | line two | line three");

    const bounded = excerpt("a\nbb\nccc", 6);
    assert.ok(bounded.length <= 7);
    assert.match(bounded, /ccc$/);
  });

  it("flags autonomous startup stalls as fatal but spares active and interactive subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const isCandidate = testApi.isFatalStallCandidate as (running: any) => boolean;

    // Agent loop never started: activity phase stuck at "starting".
    assert.equal(isCandidate(makeRunning({ activity: { phase: "starting" } })), true);
    // No valid activity snapshot at all (child crashed before pi booted).
    assert.equal(isCandidate(makeRunning({})), true);
    // Agent loop ran: phase left "starting".
    assert.equal(isCandidate(makeRunning({ activity: { phase: "waiting" } })), false);
    assert.equal(isCandidate(makeRunning({ activity: { phase: "active" } })), false);
    // Interactive subagents are user-driven — never escalated.
    assert.equal(
      isCandidate(makeRunning({ interactive: true, activity: { phase: "starting" } })),
      false,
    );
    // Already escalated — never twice.
    assert.equal(
      isCandidate(makeRunning({ fatalStallEscalated: true, activity: { phase: "starting" } })),
      false,
    );
  });

  it("escalates a fatal stall by synthesizing the child's .exit sidecar", () => {
    const testApi = (subagentsModule as any).__test__;
    const dir = mkdtempSync(join(tmpdir(), "subagent-stall-"));
    const sessionFile = join(dir, "stalled.jsonl");

    try {
      const running = makeRunning({
        id: "s1",
        name: "Researcher",
        surface: "definitely-not-a-real-pane",
        startTime: Date.now() - 120_000,
        sessionFile,
        activity: { phase: "starting" },
      });

      testApi.escalateFatalStall(running);

      const exitFile = `${sessionFile}.exit`;
      assert.equal(existsSync(exitFile), true, "expected .exit sidecar to be written");
      const data = JSON.parse(readFileSync(exitFile, "utf-8"));
      assert.equal(data.type, "error");
      assert.equal(data.stopReason, "error");
      assert.match(data.errorMessage, /never started its agent loop/);
      assert.match(data.errorMessage, /Researcher|stalled|pane/i);

      // The sidecar decodes through the same path as real child errors.
      const interpreted = __pollForExitTest__.interpretExitSidecar(data);
      assert.equal(interpreted.reason, "error");
      assert.equal(interpreted.exitCode, 1);
      assert.match(interpreted.errorMessage ?? "", /never started its agent loop/);

      // Guard: a second escalation attempt must not rewrite or throw.
      testApi.escalateFatalStall(running);
      assert.equal(existsSync(exitFile), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watcher tick only escalates after the fatal-stall threshold and a stalled classification", () => {
    const testApi = (subagentsModule as any).__test__;
    const maybeEscalate = testApi.maybeEscalateFatalStall as (running: any) => void;
    const threshold = testApi.FATAL_STALL_AFTER_SECONDS as number;
    const dir = mkdtempSync(join(tmpdir(), "subagent-stall-"));
    const sessionFile = join(dir, "tick.jsonl");

    try {
      // Too early: young stall must not escalate.
      const young = makeRunning({
        startTime: Date.now() - (threshold - 10) * 1000,
        sessionFile,
        activity: { phase: "starting" },
        statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
      });
      maybeEscalate(young);
      assert.equal(existsSync(`${sessionFile}.exit`), false);

      // Old enough + stalled classification → escalates.
      const old = makeRunning({
        startTime: Date.now() - (threshold + 10) * 1000,
        sessionFile,
        activity: { phase: "starting" },
        statusState: createStatusState({
          source: "pi",
          startTimeMs: Date.now() - (threshold + 10) * 1000,
        }),
      });
      old.statusState.firstObservationAtMs = Date.now() - (threshold + 10) * 1000;
      maybeEscalate(old);
      assert.equal(existsSync(`${sessionFile}.exit`), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    registerSubagentsForTest(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    registerSubagentsForTest(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime: 1_000_000 - 13_000,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
          },
          {
            id: "a2",
            name: "B",
            task: "",
            surface: "s2",
            startTime: 1_000_000 - 21_000,
            sessionFile: "sess2",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
          },
          {
            id: "a3",
            name: "C",
            task: "",
            surface: "s3",
            startTime: 1_000_000 - 27_000,
            sessionFile: "sess3",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
          },
        ],
        16,
      );

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
          },
        ],
        width,
      );

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("herdr.ts", () => {
  describe("version compatibility", () => {
    it("accepts the minimum release through the tested 0.9 line", () => {
      assert.deepEqual(__herdrVersionTest__.classifyHerdrVersionOutput("herdr 0.8.2"), {
        kind: "supported",
        compatible: true,
        version: "0.8.2",
      });
      assert.deepEqual(__herdrVersionTest__.classifyHerdrVersionOutput("herdr 0.8.99"), {
        kind: "supported",
        compatible: true,
        version: "0.8.99",
      });
      assert.deepEqual(__herdrVersionTest__.classifyHerdrVersionOutput("herdr 0.9.0"), {
        kind: "supported",
        compatible: true,
        version: "0.9.0",
      });
      assert.deepEqual(__herdrVersionTest__.classifyHerdrVersionOutput("herdr 0.9.5"), {
        kind: "supported",
        compatible: true,
        version: "0.9.5",
      });
    });

    it("rejects versions older than 0.8.2", () => {
      const status = __herdrVersionTest__.classifyHerdrVersionOutput("herdr 0.8.1");
      assert.equal(status.kind, "unsupported");
      assert.equal(status.compatible, false);
      assert.match(status.message ?? "", />=0\.8\.2/);
    });

    it("allows 1.0 and later with an untested warning", () => {
      for (const output of ["herdr 1.0.0", "herdr 1.0.0-beta.1"]) {
        const status = __herdrVersionTest__.classifyHerdrVersionOutput(output);
        assert.equal(status.kind, "untested");
        assert.equal(status.compatible, true);
        assert.match(status.message ?? "", /without a compatibility guarantee/);
      }
    });

    it("rejects an unparseable version response", () => {
      const status = __herdrVersionTest__.classifyHerdrVersionOutput("herdr unknown");
      assert.equal(status.kind, "unsupported");
      assert.equal(status.compatible, false);
      assert.match(status.message ?? "", /Could not parse/);
    });
  });

  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});

describe("packages.ts installed-package resolution", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-packages-"));
    mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
    mkdirSync(join(agentDir, "git"), { recursive: true });
  });

  after(() => {
    rmSync(join(tmpdir(), "pi-subagents-packages-"), { recursive: true, force: true });
  });

  function writeSettings(configDir: string, packages: unknown) {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ packages }), "utf8");
  }

  function writePackage(packageDir: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) {
      const p = join(packageDir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
  }

  it("resolves a manifest-based npm package", () => {
    const pkgDir = join(agentDir, "npm", "node_modules", "my-provider");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {};",
    });
    writeSettings(agentDir, ["npm:my-provider"]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, [join(pkgDir, "index.ts")]);
    assert.deepEqual(unresolved, []);
  });

  it("resolves scoped npm package names with version ranges", () => {
    const pkgDir = join(agentDir, "npm", "node_modules", "@scope", "pkg");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {};",
    });
    writeSettings(agentDir, ["npm:@scope/pkg@^1.2.0"]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, [join(pkgDir, "index.ts")]);
    assert.deepEqual(unresolved, []);
  });

  it("resolves git shorthand, URL, and ref forms to the same install dir", () => {
    const pkgDir = join(agentDir, "git", "github.com", "org", "repo");
    writePackage(pkgDir, { "index.ts": "export default function () {};" });
    writeSettings(agentDir, [
      "git:github.com/org/repo",
      "git:https://github.com/org/repo.git#v1.0",
      "https://github.com/org/repo",
    ]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, [join(pkgDir, "index.ts")]);
    assert.deepEqual(unresolved, []);
  });

  it("auto-discovers extensions/ dirs when no manifest entries exist", () => {
    const pkgDir = join(agentDir, "npm", "node_modules", "auto-pkg");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ name: "auto-pkg" }),
      "extensions/direct.ts": "export default function () {};",
      "extensions/sub/index.js": "export default function () {};",
    });
    writeSettings(agentDir, ["npm:auto-pkg"]);

    const { paths } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths.sort(), [
      join(pkgDir, "extensions", "direct.ts"),
      join(pkgDir, "extensions", "sub", "index.js"),
    ]);
  });

  it("resolves local-path sources against the agent dir", () => {
    const pkgDir = join(agentDir, "local-ext");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./main.ts"] } }),
      "main.ts": "export default function () {};",
    });
    writeSettings(agentDir, ["./local-ext"]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, [join(pkgDir, "main.ts")]);
    assert.deepEqual(unresolved, []);
  });

  it("carries project-scope packages from the project config dir", () => {
    const projectDir = join(agentDir, "project");
    const projectConfigDir = join(projectDir, ".pi");
    const pkgDir = join(projectConfigDir, "npm", "node_modules", "proj-pkg");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {};",
    });
    writeSettings(projectConfigDir, ["npm:proj-pkg"]);

    const { paths } = resolvePackageExtensions({ agentDir, projectConfigDir });
    assert.deepEqual(paths, [join(pkgDir, "index.ts")]);
  });

  it("reports missing installs as unresolved without throwing", () => {
    writeSettings(agentDir, [
      "npm:not-installed",
      "git:github.com/org/missing",
      "git:not-a-valid-source",
      "npm:",
    ]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, []);
    assert.deepEqual(unresolved.sort(), [
      "git:github.com/org/missing",
      "git:not-a-valid-source",
      "npm:",
      "npm:not-installed",
    ]);
  });

  it("returns empty results when settings.json is absent", () => {
    const { paths, unresolved } = resolvePackageExtensions({ agentDir });
    assert.deepEqual(paths, []);
    assert.deepEqual(unresolved, []);
  });

  it("deduplicates entries shared between global and project settings", () => {
    const pkgDir = join(agentDir, "npm", "node_modules", "shared-pkg");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {};",
    });
    writeSettings(agentDir, ["npm:shared-pkg"]);
    const projectConfigDir = join(agentDir, "project", ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeSettings(projectConfigDir, ["npm:shared-pkg"]);

    // The project install is absent on disk, so the global one is all we have.
    const { paths } = resolvePackageExtensions({ agentDir, projectConfigDir });
    assert.deepEqual(paths, [join(pkgDir, "index.ts")]);
  });

  it("project install wins over the global install of the same package", () => {
    // The wksync-my-learning failure: @juicesharp/rpiv-ask-user-question
    // installed in both scopes — loading both registers ask_user_question
    // twice, a fatal extension conflict at child startup.
    const globalDir = join(agentDir, "npm", "node_modules", "@juicesharp", "rpiv");
    const projectConfigDir = join(agentDir, "project", ".pi");
    const projectDir = join(projectConfigDir, "npm", "node_modules", "@juicesharp", "rpiv");
    writePackage(globalDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {}; // global",
    });
    writePackage(projectDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {}; // project",
    });
    writeSettings(agentDir, ["npm:@juicesharp/rpiv"]);
    mkdirSync(projectConfigDir, { recursive: true });
    writeSettings(projectConfigDir, ["npm:@juicesharp/rpiv"]);

    const { paths } = resolvePackageExtensions({ agentDir, projectConfigDir });
    assert.deepEqual(paths, [join(projectDir, "index.ts")]);
  });

  it("falls back to the global install when the winning project entry is not installed", () => {
    const globalDir = join(agentDir, "npm", "node_modules", "global-only");
    writePackage(globalDir, {
      "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "index.ts": "export default function () {};",
    });
    writeSettings(agentDir, ["npm:global-only"]);
    const projectConfigDir = join(agentDir, "project", ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeSettings(projectConfigDir, ["npm:global-only"]);

    const { paths, unresolved } = resolvePackageExtensions({ agentDir, projectConfigDir });
    assert.deepEqual(paths, [join(globalDir, "index.ts")]);
    assert.deepEqual(unresolved, []);
  });

  it("a project autoload:false entry loads nothing; the global entry stands in", () => {
    // The wksync-my-learning shape: the project pins the package with
    // autoload:false (+ an extensions delta) while the global install is the
    // one a normal session actually loads. Carrying both would double-load it.
    const globalDir = join(agentDir, "npm", "node_modules", "delta-pkg");
    const projectConfigDir = join(agentDir, "project", ".pi");
    const projectDir = join(projectConfigDir, "npm", "node_modules", "delta-pkg");
    for (const dir of [globalDir, projectDir]) {
      writePackage(dir, {
        "package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
        "index.ts": "export default function () {};",
      });
    }
    writeSettings(agentDir, ["npm:delta-pkg"]);
    mkdirSync(projectConfigDir, { recursive: true });
    writeSettings(projectConfigDir, [{ source: "npm:delta-pkg", autoload: false }]);

    const { paths } = resolvePackageExtensions({ agentDir, projectConfigDir });
    assert.deepEqual(paths, [join(globalDir, "index.ts")]);
  });

  it("resolvePackageEntryPaths prefers manifest entries and skips missing files", () => {
    const pkgDir = join(agentDir, "entry-order");
    writePackage(pkgDir, {
      "package.json": JSON.stringify({
        pi: { extensions: ["./gone.ts", "./real.ts"] },
      }),
      "index.ts": "export default function () {};",
      "real.ts": "export default function () {};",
    });

    assert.deepEqual(resolvePackageEntryPaths(pkgDir), [join(pkgDir, "real.ts")]);
  });

  describe("mergeExtensionPaths", () => {
    it("drops the tool-mapped index file when the package manifest covers the same package", () => {
      // The pi-web-access regression shape: the tool-extension map hardcodes
      // <pkg>/index.ts while the manifest ships ["./dist"] — emitting both
      // -e paths loads the package twice and the second registration of its
      // tools is a fatal extension conflict at child startup.
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/npm/node_modules/pi-web-access/index.ts"],
        packageExtensionPaths: ["/agent/npm/node_modules/pi-web-access/dist"],
      });
      assert.deepEqual(merged, ["/agent/npm/node_modules/pi-web-access/dist"]);
    });

    it("keeps the tool path when no package entry covers its package", () => {
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/extensions/web-search/index.ts"],
        packageExtensionPaths: ["/agent/npm/node_modules/other-pkg/dist"],
      });
      assert.deepEqual(merged, [
        "/agent/npm/node_modules/other-pkg/dist",
        "/agent/extensions/web-search/index.ts",
      ]);
    });

    it("deduplicates identical paths between the tool map and the manifest", () => {
      const p = "/agent/npm/node_modules/rpiv/index.ts";
      const merged = mergeExtensionPaths({
        toolExtensionPaths: [p],
        packageExtensionPaths: [p],
      });
      assert.deepEqual(merged, [p]);
    });

    it("does not let a similarly named sibling package shadow the tool path", () => {
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/npm/node_modules/pi-web-access/index.ts"],
        packageExtensionPaths: ["/agent/npm/node_modules/pi-web-access-fork/dist"],
      });
      assert.deepEqual(merged, [
        "/agent/npm/node_modules/pi-web-access-fork/dist",
        "/agent/npm/node_modules/pi-web-access/index.ts",
      ]);
    });

    it("drops a tool path that duplicates the carried install of another scope", () => {
      // The tool map hardcodes the GLOBAL npm path; the carried entries hold
      // the PROJECT install of the same package (identity npm:name). Only the
      // project copy may load.
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/npm/node_modules/@juicesharp/rpiv/index.ts"],
        packageExtensionPaths: ["/agent/project/.pi/npm/node_modules/@juicesharp/rpiv/index.ts"],
        configDirs: ["/agent", "/agent/project/.pi"],
      });
      assert.deepEqual(merged, ["/agent/project/.pi/npm/node_modules/@juicesharp/rpiv/index.ts"]);
    });

    it("prefers a manifest file entry nested inside the package over the root index", () => {
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/git/host/org/repo/index.ts"],
        packageExtensionPaths: ["/agent/git/host/org/repo/src/main.ts"],
      });
      assert.deepEqual(merged, ["/agent/git/host/org/repo/src/main.ts"]);
    });

    it("keeps non-index tool-mapped files even inside a covered package", () => {
      // Only index.ts/index.js mappings yield to the manifest entry; any other
      // tool-mapped file is treated as its own extension and kept.
      const merged = mergeExtensionPaths({
        toolExtensionPaths: ["/agent/npm/node_modules/duo/bespoke.ts"],
        packageExtensionPaths: ["/agent/npm/node_modules/duo/dist"],
      });
      assert.deepEqual(merged, [
        "/agent/npm/node_modules/duo/dist",
        "/agent/npm/node_modules/duo/bespoke.ts",
      ]);
    });
  });
});
