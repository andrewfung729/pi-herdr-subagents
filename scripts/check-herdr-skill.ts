import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERDR_MIN_VERSION,
  HERDR_REVIEW_VERSION,
  HERDR_TESTED_VERSION,
} from "../pi-extension/subagents/herdr.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = resolve(projectRoot, "skills", "herdr", "SKILL.md");
const compatibilityOverlay = [
  `compatibility: "Requires HERDR_ENV=1 and Herdr CLI >=${HERDR_MIN_VERSION}; tested with ${HERDR_TESTED_VERSION}. Re-check compatibility at ${HERDR_REVIEW_VERSION}."`,
  "metadata:",
  `  herdrdev-tested-version: "${HERDR_TESTED_VERSION}"`,
  `  herdrdev-source-tag: "v${HERDR_TESTED_VERSION}"`,
  "",
].join("\n");

const bundledSkill = readFileSync(skillPath, "utf8");
if (!bundledSkill.includes(compatibilityOverlay)) {
  throw new Error(`Expected compatibility metadata is missing or stale in ${skillPath}`);
}

const versionOutput = execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim();
const installedVersion = versionOutput.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
if (installedVersion !== HERDR_TESTED_VERSION) {
  throw new Error(
    `Skill sync requires Herdr ${HERDR_TESTED_VERSION}; found ${installedVersion ?? versionOutput}. ` +
      "Pin the tested release in CI or update the compatibility constants and metadata deliberately.",
  );
}

const authoritativeSkill = execFileSync("herdr", ["--skill"], { encoding: "utf8" });
const normalizedBundledSkill = bundledSkill.replace(compatibilityOverlay, "");
if (normalizedBundledSkill !== authoritativeSkill) {
  const bundledLines = normalizedBundledSkill.split("\n");
  const authoritativeLines = authoritativeSkill.split("\n");
  const differenceIndex = bundledLines.findIndex(
    (line, index) => line !== authoritativeLines[index],
  );
  const lineNumber = differenceIndex === -1 ? Math.min(bundledLines.length, authoritativeLines.length) : differenceIndex + 1;
  throw new Error(
    `Bundled skill differs from \`herdr --skill\` for Herdr ${HERDR_TESTED_VERSION} at line ${lineNumber}.`,
  );
}

console.log(`Bundled Herdr skill matches Herdr ${HERDR_TESTED_VERSION}.`);
