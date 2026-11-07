import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderCapture, scrubValues, structureOf } from "../../skills/ko-acceptance-validator/scripts/capture.mjs";

const SCRIPT = resolve(import.meta.dirname, "../../skills/ko-acceptance-validator/scripts/capture.mjs");
const run = promisify(execFile);

describe("scrubValues", () => {
  it("replaces every occurrence of each secret value", () => {
    expect(scrubValues("a=s3cret&b=s3cret", ["s3cret"])).toBe("a=[scrubbed]&b=[scrubbed]");
  });
  it("ignores an empty secret rather than matching everywhere", () => {
    expect(scrubValues("abc", [""])).toBe("abc");
  });
});

describe("structureOf", () => {
  it("replaces scalars with their type and keeps the keys", () => {
    expect(structureOf({ email: "a@b.c", n: 1, ok: true, none: null, nested: { x: "y" } })).toEqual({
      email: "string",
      n: "number",
      ok: "boolean",
      none: "null",
      nested: { x: "string" },
    });
  });
  it("keeps an empty list visibly empty and a list's first shape otherwise", () => {
    expect(structureOf([])).toEqual([]);
    expect(structureOf([{ id: 7 }, { id: 8 }])).toEqual([{ id: "number" }]);
  });
});

const base = {
  method: "POST",
  url: new URL("http://localhost:3000/api/orders?token=abc123&page=2"),
  requestHeaders: { "x-api-key": "k-123", accept: "application/json", authorization: "Bearer abc123" },
  requestBody: '{"email":"a@b.c"}',
  status: 200,
  responseHeaders: { "set-cookie": "sid=zzz", "content-type": "application/json", "x-trace": "abc123" },
  responseBody: '{"email":"a@b.c","owner":"abc123"}',
  secrets: ["abc123"],
};

describe("renderCapture on a local target", () => {
  const out = renderCapture({ ...base, remote: false });

  it("scrubs any header whose name looks like a credential", () => {
    expect(out).toContain("x-api-key: [scrubbed]");
    expect(out).toContain("authorization: [scrubbed]");
    expect(out).toContain("set-cookie: [scrubbed]");
    expect(out).not.toContain("k-123");
    expect(out).not.toContain("sid=zzz");
  });

  it("scrubs a named secret's value wherever it appears, URL and body included", () => {
    expect(out).not.toContain("abc123");
    expect(out).toContain("token=[scrubbed]");
    expect(out).toContain('"owner":"[scrubbed]"');
  });

  it("keeps ordinary headers and bodies, since a local app holds test data", () => {
    expect(out).toContain("content-type: application/json");
    expect(out).toContain('"email":"a@b.c"');
    expect(out).toContain("status 200");
  });
});

describe("renderCapture on a remote target", () => {
  const out = renderCapture({ ...base, remote: true });

  it("records method, path, status and header names only", () => {
    expect(out).toContain("POST /api/orders");
    expect(out).not.toContain("page=2");
    expect(out).toContain("status 200");
    expect(out).toContain("x-trace");
    expect(out).not.toContain("application/json\n");
  });

  it("records key names and value types, never values", () => {
    expect(out).toContain('"email": "string"');
    expect(out).not.toContain("a@b.c");
    expect(out).not.toContain("abc123");
  });

  it("marks a non-JSON body as omitted", () => {
    const html = renderCapture({ ...base, remote: true, responseBody: "<p>Jane Doe</p>" });
    expect(html).toContain("response body: omitted (not JSON)");
    expect(html).not.toContain("Jane");
  });
});

describe("the CLI against a loopback server", () => {
  let server;
  let target;
  let cwd;
  const hits = [];

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "acceptance-capture-"));
    server = createServer((req, res) => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://example.invalid/stolen" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: req.headers.authorization ?? null }));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    target = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(cwd, { recursive: true, force: true });
  });

  const cli = (args, env = {}) => run(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, ...env } });
  const std = (id) => ["--target", target, "--sha", "abcdef1234", "--scenario-id", id];

  it("sends a header from an env var without it reaching argv or the capture", async () => {
    const { stdout, stderr } = await cli([...std("auth-case"), "--url", "/api/me", "--method", "GET", "--header-env", "Authorization=API_TOKEN", "--secret-env", "API_TOKEN"], {
      API_TOKEN: "tok-999",
    });
    expect(hits.at(-1).auth).toBe("tok-999");
    expect(stdout).toContain("[scrubbed]");
    expect(stdout).not.toContain("tok-999");
    const file = join(cwd, ".tmp/acceptance/evidence/abcdef1/auth-case.txt");
    expect(stderr).toContain("auth-case.txt");
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain("status 200");
    expect(saved).not.toContain("tok-999");
  });

  it("writes the self-ignoring .gitignore before any evidence", () => {
    expect(readFileSync(join(cwd, ".tmp/acceptance/.gitignore"), "utf8")).toBe("*\n");
  });

  it("refuses a URL off the target origin, sending nothing", async () => {
    const before = hits.length;
    await expect(cli([...std("off-origin"), "--url", "http://example.invalid/x", "--method", "GET"])).rejects.toMatchObject({ code: 3 });
    await expect(cli([...std("scheme-relative"), "--url", "//example.invalid/x", "--method", "GET"])).rejects.toMatchObject({ code: 3 });
    expect(hits.length).toBe(before);
  });

  it("does not follow a redirect", async () => {
    const { stdout } = await cli([...std("redirect"), "--url", "/redirect", "--method", "GET"]);
    expect(stdout).toContain("status 302");
  });

  it("refuses a scenario id that could leave the evidence directory", async () => {
    await expect(cli(["--target", target, "--sha", "abcdef1234", "--scenario-id", "../../x", "--url", "/a", "--method", "GET"])).rejects.toMatchObject({ code: 2 });
  });

  it("names a missing env var and sends nothing", async () => {
    const before = hits.length;
    await expect(cli([...std("no-env"), "--url", "/a", "--method", "GET", "--header-env", "Authorization=NOT_SET_ANYWHERE"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("NOT_SET_ANYWHERE"),
    });
    expect(hits.length).toBe(before);
  });
});
