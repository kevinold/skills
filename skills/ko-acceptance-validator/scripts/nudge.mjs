#!/usr/bin/env node
// usage: nudge.mjs event [--tool t] [--path p] [--command c] [--skill s] [--build-on <regex>]
//        nudge.mjs claude-code [--build-on <regex>]        (a PostToolUse payload on stdin)
//   Decide whether an agent's last action calls for a stage of this skill, and print a
//   one-paragraph reminder if so. Any harness with a post-tool hook can call `event` and
//   pass the output to its agent. Run it with cwd at the repo root.
//   Advisory: it never blocks. Every failure is silence and exit 0, because a broken
//   nudge must never stall an agent's work.
//
//   ponytail: the build reminder only fires where this checkout has run the spec stage,
//   so it stays quiet on repos and clones not using the skill. A fresh clone misses it.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ACCEPTANCE_DIR = ".tmp/acceptance";
const WRITE_TOOLS = ["write", "edit", "multiedit"];
const PLAN_FILE = /(^|\/)plans\/[^/]+\.md$/;
const DEFAULT_BUILD_ON = /\b(gh pr create|git push)\b/;

function buildPattern(buildOn) {
  try {
    return buildOn ? new RegExp(buildOn) : DEFAULT_BUILD_ON;
  } catch {
    return DEFAULT_BUILD_ON;
  }
}

/** What an action calls for: "plan", "build", or null. */
export function classify({ tool, path, command, skill }, { buildOn } = {}) {
  if (path && WRITE_TOOLS.includes(String(tool).toLowerCase()) && PLAN_FILE.test(path) && !/(^|\/)README\.md$/i.test(path)) return "plan";
  const text = [command, skill].filter(Boolean).join("\n");
  return text && buildPattern(buildOn).test(text) ? "build" : null;
}

const verdictFiles = (prefix) => {
  try {
    return readdirSync(ACCEPTANCE_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => join(ACCEPTANCE_DIR, f));
  } catch {
    return [];
  }
};

// A verdict newer than the plan, for this plan's .feature, means this version was already judged.
function planIsJudged(planPath) {
  const planTime = statSync(planPath).mtimeMs;
  const feature = `${basename(planPath, extname(planPath))}.feature`;
  return verdictFiles("spec-").some((file) => {
    const { artifact_path: artifact } = JSON.parse(readFileSync(file, "utf8"));
    return typeof artifact === "string" && basename(artifact) === feature && statSync(file).mtimeMs >= planTime;
  });
}

function planReminder(path) {
  if (!existsSync(path) || planIsJudged(path)) return "";
  return (
    `Acceptance check: the plan "${path}" was just written. If it is ready to implement, run the ko-acceptance-validator ` +
    `skill's spec stage on it before coding, which writes the plan's .feature scenarios and records a verdict. ` +
    `Advisory: it never blocks. Skip this if the plan is still a draft or the stage already ran for this version.`
  );
}

function buildReminder() {
  if (verdictFiles("spec-").length === 0) return "";
  const sha7 = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().slice(0, 7);
  if (existsSync(join(ACCEPTANCE_DIR, `posted-${sha7}.json`))) return "";
  return (
    `Acceptance check: this branch has a spec verdict, but no build verdict is posted for HEAD. Once the change is running, ` +
    `run the ko-acceptance-validator skill's build stage against it, which walks the .feature scenarios and posts the verdict. ` +
    `Advisory: it never blocks. Skip this if the build stage is already in progress.`
  );
}

function reminderFor(event, options) {
  const kind = classify(event, options);
  if (kind === "plan") return planReminder(event.path);
  if (kind === "build") return buildReminder();
  return "";
}

function main(argv) {
  const [mode, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      tool: { type: "string" },
      path: { type: "string" },
      command: { type: "string" },
      skill: { type: "string" },
      "build-on": { type: "string" },
    },
  });
  const options = { buildOn: values["build-on"] };

  if (mode === "event") {
    const text = reminderFor(values, options);
    if (text) process.stdout.write(`${text}\n`);
  } else if (mode === "claude-code") {
    const { tool_name: tool, tool_input: input = {} } = JSON.parse(readFileSync(0, "utf8"));
    const text = reminderFor({ tool, path: input.file_path, command: input.command, skill: input.skill }, options);
    if (text) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } })}\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    // fail open: see the header
  }
  process.exitCode = 0;
}
