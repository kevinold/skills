import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPAWN = join(HERE, "spawn-worker.sh");

// OS temp, NOT under .claude/worktrees (see close-lane.test.mjs for why).
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "pm-spawn-worker-test-")));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let seq = 0;
const scratch = (name) => join(SCRATCH, `${seq++}-${name}`);

// A stub-bin dir whose `herdr` shadows the real one on PATH and logs every call.
const stubBin = (herdrBody) => {
  const dir = mkdtempSync(join(SCRATCH, "bin-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "herdr"), `#!/usr/bin/env bash\nprintf '%s\\n' "herdr $*" >>"${log}"\n${herdrBody}\n`, { mode: 0o755 });
  return { log, env: { ...process.env, SPINE_PRIMARY: "", PATH: `${dir}:${process.env.PATH}` } };
};

const primaryRoot = () => {
  const root = scratch("primary");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
};

// herdr stub: `agent start` answers `start`; `agent list` reports w1 in `cwd`.
const herdrStub = ({ start = `{"result":{"agent":{"name":"w1","agent_status":"idle"}}}`, list }) =>
  [
    `case "$1 $2" in`,
    `  "agent start") printf '%s\\n' '${start}' ;;`,
    `  "agent list") printf '%s\\n' '${list}' ;;`,
    `  *) true ;;`,
    `esac`,
  ].join("\n");

const listAt = (cwd) => JSON.stringify({ result: { agents: [{ name: "w1", agent_status: "idle", pane_id: "w1:p2", cwd }] } });

const spawn = (args, env) => spawnSync("bash", [SPAWN, ...args], { encoding: "utf8", cwd: SCRATCH, env, timeout: 20_000 });

describe("spawn-worker.sh starts the agent in a pre-created pane", () => {
  it("refuses without --pane: exit 2, usage, no herdr calls", () => {
    const primary = primaryRoot();
    const { log, env } = stubBin(herdrStub({ list: listAt(primary) }));
    const r = spawn(["w1", "--primary", primary], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--pane/);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("starts the agent in the given pane and never splits one", () => {
    const primary = primaryRoot();
    const { log, env } = stubBin(herdrStub({ list: listAt(primary) }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/herdr agent start w1 --kind claude --pane w1:p2 --timeout 90000/);
    expect(calls).not.toMatch(/pane split/);
    expect(r.stdout).toMatch(/pane=w1:p2/);
  });

  it("starts the config workerKind (codex) instead of the claude default", () => {
    const primary = primaryRoot();
    writeFileSync(join(primary, ".multi-worker-pm.json"), JSON.stringify({ workerKind: "codex" }));
    const { log, env } = stubBin(herdrStub({ list: listAt(primary) }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toMatch(/herdr agent start w1 --kind codex --pane w1:p2/);
  });

  it("accepts --pane=<id>", () => {
    const primary = primaryRoot();
    const { log, env } = stubBin(herdrStub({ list: listAt(primary) }));
    const r = spawn(["w1", "--pane=w1:p2", "--primary", primary], env);
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toMatch(/--pane w1:p2/);
  });

  it("exits 3 with the dialog hint on agent_not_ready", () => {
    const primary = primaryRoot();
    const { env } = stubBin(herdrStub({ start: `{"error":"agent_not_ready"}`, list: listAt(primary) }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/herdr agent read w1/);
  });

  it("exits 4 with no herdr calls when the primary is unset", () => {
    const { log, env } = stubBin(herdrStub({ list: listAt("/nowhere") }));
    const r = spawn(["w1", "--pane", "w1:p2"], env);
    expect(r.status).toBe(4);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("exits 4 naming both paths when the agent started outside the primary", () => {
    const primary = primaryRoot();
    const elsewhere = scratch("elsewhere");
    mkdirSync(elsewhere);
    const { env } = stubBin(herdrStub({ list: listAt(elsewhere) }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(primary);
    expect(r.stderr).toContain(elsewhere);
  });

  it("exits 7 (herdr drift), never a silent success, when agent list is malformed after start", () => {
    const primary = primaryRoot();
    const { env } = stubBin(herdrStub({ list: "not json" }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(7);
  });

  it("exits 7 when the roster does not list the just-started agent", () => {
    const primary = primaryRoot();
    const { env } = stubBin(herdrStub({ list: JSON.stringify({ result: { agents: [] } }) }));
    const r = spawn(["w1", "--pane", "w1:p2", "--primary", primary], env);
    expect(r.status).toBe(7);
    expect(r.stderr).toMatch(/cwd of agent w1/);
  });
});
