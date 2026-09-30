# 01: Wire allowlist `codemode` → `-e builtin:codemode`

**What to build:** When a restricted subagent loadout allowlist includes `codemode`, spawn and resume both produce child argv that loads pi's built-in codemode extension exactly once (`-e builtin:codemode`), so naming `codemode` in an agent allowlist is truthful. Allowlists without `codemode` stay exact (no builtin flag). Unrestricted / null-allowlist loadouts stay unrestricted (no injected codemode, no new restriction flags). No new loadout schema fields — presence of `codemode` in the existing allowlist string is enough to re-derive the flag on resume.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Shared sandbox argv builder treats `codemode` as a special allowlist token that contributes `-e builtin:codemode` once (idempotent if listed twice), outside package-path extension merge — not via filesystem tool-extension lookup
- [x] Ordinary non-codemode allowlists do not get `builtin:codemode`
- [x] Null / unrestricted allowlists still omit restriction flags and do not add codemode builtin
- [x] Unit tests at the existing `applySandboxToParts` seam lock the three cases above (duplicate `codemode` covered in the positive case); no surface/integration/LLM tests
- [x] No drive-by refactors; no `tool_search` / MCP / virtual-model carry work
