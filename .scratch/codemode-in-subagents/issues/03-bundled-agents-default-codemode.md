# 03: Default bundled agents onto `codemode` + role guidance

**What to build:** Out-of-the-box scout, researcher, and worker can use codemode without custom agent files: each bundled agent allowlist includes `codemode`, with short role-specific guidance so scouts/researchers prefer parallel gather + distill, and workers use codemode for probe/parallel/filter while keeping edits on direct tools. Custom overrides that omit `codemode` still stick — no forced injection beyond frontmatter/allowlist build.

**Blocked by:** 01 (Wire allowlist `codemode` → `-e builtin:codemode`) — defaults must not name a tool the child never loads.

**Status:** done

- [x] scout, researcher, and worker frontmatter `tools:` include `codemode` while preserving existing tools and worker `subagent_agents`
- [x] Short per-agent body guidance (not a shared include): scout/researcher prefer codemode for parallel gather and distillation; worker uses codemode for multi-file probe, parallel reads, and filtering large output, and performs code changes with direct `edit` / `write` (and direct `bash` when appropriate)
- [x] Unit tests via existing `loadAgentDefaults` assert each of the three agents loads with `tools` including `codemode`
- [x] No widget, fatal-stall, or loadout-schema changes
