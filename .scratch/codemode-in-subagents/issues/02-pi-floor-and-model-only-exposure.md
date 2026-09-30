# 02: Raise pi floor + `model-only` on orchestration/ask tools

**What to build:** Package metadata requires pi 0.99+ so built-in codemode and tool `exposure` are real dependencies, and the four tools this extension registers for orchestration and user questions stay callable by the model directly but never from codemode scripts — a script cannot `Promise.all` unbounded `subagent` spawns or block mid-script on `ask_question`.

**Blocked by:** None (can start immediately; parallel with 01).

**Status:** done

- [x] peerDependencies: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` → `>=0.99.0`
- [x] devDependencies for the same two packages → `^0.99.1` (bounded; not open `>=`)
- [x] Package `version` field left at `0.1.0` (no release bump)
- [x] Do not commit `minimumReleaseAgeExclude` entries for 0.99.x; if `pnpm add` writes them, revert that hunk and wait for release age (or escalate) instead of excluding
- [x] Escalate `esbuild` `allowBuilds` to a human — do not set true/false yourself; install/check may stay blocked until that policy choice lands (human approved `esbuild: true` 2026-09-30)
- [x] `subagent`, `subagent_message`, `subagents_list`, and `ask_question` each register with `exposure: "model-only"`; all other registration behaviour unchanged
- [x] Unit tests via existing mock extension registration assert `exposure: "model-only"` on all four tools
- [x] No TypeBox import migration; no runtime pi version gate beyond peer metadata
