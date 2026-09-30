import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../install.sh");

// Runs install.sh with a fake `npx` that records each call, and a file standing
// in for the terminal so the prompt path is testable without a real tty.
function run(args, { answer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "install-test-"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n`);
  chmodSync(join(dir, "npx"), 0o755);
  const tty = join(dir, "tty");
  if (answer !== undefined) writeFileSync(tty, `${answer}\n`);
  // /bin/bash is bash 3.2 on macOS, the oldest shell a user will run this with.
  const r = spawnSync(existsSync("/bin/bash") ? "/bin/bash" : "bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, KEVINOLD_SKILLS_TTY: answer === undefined ? join(dir, "missing") : tty },
  });
  let calls = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n"); } catch {}
  return { status: r.status, stdout: r.stdout, calls };
}

describe("install.sh", () => {
  it("installs claude-video after a yes at the prompt, with the same agents and scope", () => {
    const r = run(["-a", "claude-code", "codex", "-g"], { answer: "y" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      "-y skills add kevinold/skills -a claude-code codex -g",
      "-y skills add bradautomates/claude-video -a claude-code codex -g",
    ]);
  });

  it("treats an empty answer as yes", () => {
    expect(run([], { answer: "" }).calls).toHaveLength(2);
  });

  it("skips claude-video on no", () => {
    expect(run([], { answer: "n" }).calls).toEqual(["-y skills add kevinold/skills"]);
  });

  it("skips with a hint when there is no terminal to ask", () => {
    const r = run([]);
    expect(r.calls).toEqual(["-y skills add kevinold/skills"]);
    expect(r.stdout).toContain("--with-video");
  });

  it("honors --with-video and --no-video without prompting, and keeps them out of skills add", () => {
    expect(run(["--with-video"]).calls).toEqual(["-y skills add kevinold/skills", "-y skills add bradautomates/claude-video"]);
    expect(run(["--no-video"], { answer: "y" }).calls).toEqual(["-y skills add kevinold/skills"]);
  });

  it("does not offer claude-video when meeting-notes is not being installed", () => {
    expect(run(["-s", "multi-worker-pm"], { answer: "y" }).calls).toEqual(["-y skills add kevinold/skills -s multi-worker-pm"]);
    expect(run(["-s", "prfaq", "meeting-notes"], { answer: "y" }).calls).toHaveLength(2);
  });
});
