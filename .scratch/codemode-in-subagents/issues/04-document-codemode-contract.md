# 04: Document codemode contract, traps, and maintainer seam

**What to build:** Package users and maintainers can read the full codemode-in-child contract without reverse-engineering: requirements floor, how allowlist + builtin `-e` work, which tools are script-callable, settings traps, virtual-model inheritance traps with suggested pins, and a one-line maintainer note so future edits do not treat `codemode` like a file tool or re-expose orchestration tools to scripts.

**Blocked by:** 01 (Wire allowlist `codemode` → `-e builtin:codemode`), 02 (Raise pi floor + `model-only` on orchestration/ask tools), 03 (Default bundled agents onto `codemode` + role guidance).

**Status:** done

- [x] README states `pi >= 0.99` near requirements / codemode docs
- [x] README tools and bundled-agent tables list `codemode` where defaults warrant it
- [x] README short codemode section: child needs allowlist entry + automatic builtin `-e`; `subagent*` / `ask_question` are `model-only` (not script-callable); `codemode.mode: "only"` in shared/project settings also applies to children and hides direct tool declarations (keep `on` for bundled worker guidance); codemode scripts can call `models.classify()` with session credentials (extra cost)
- [x] README virtual-models section: traps only (child resolves virtual ids only if registrar is loaded — installed packages are carried; bare parent `-e` router is not) + suggested pin table; no virtual-carry roadmap promise
- [x] AGENTS.md conventions/gotchas: one maintainer note that `codemode` is `-e builtin:codemode` from the allowlist (not a filesystem extension path / package carry), and that this package's orchestration/ask tools stay `model-only`
- [x] No assertion tests on README/AGENTS.md contents; docs match the behaviour shipped in 01–03
