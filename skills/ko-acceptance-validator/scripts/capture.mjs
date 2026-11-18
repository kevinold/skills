#!/usr/bin/env node
// usage: capture.mjs --target <origin> --sha <sha> --scenario-id <id> --url <path> --method <verb>
//                    [--header-env Name=ENV_VAR]... [--secret-env ENV_VAR]... [--body-file <path>] [--test-record <id>]
//   Make one API call for a scenario and save it as evidence, so the rules about
//   secrets are code rather than care. Credentials are named by env var and read
//   here, so their values never reach argv. Nothing is sent off the target's origin
//   and no redirect is followed. On a deployed target, which can show real data, the
//   saved file keeps structure only and a write is refused unless its path names the
//   --test-record; stdout carries the live response for the judge to read.
//   Exit codes: 0 called  2 bad usage  3 refused  4 the call failed
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ACCEPTANCE_DIR, ensureAcceptanceDir, isRemoteTarget } from "./verdict.mjs";

const SCRUBBED = "[scrubbed]";
const CREDENTIAL_HEADER = /auth|cookie|token|key|secret/i;
const SCENARIO_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/; // a key shaped otherwise may itself be a value, such as an email
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

export function scrubValues(text, secrets) {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join(SCRUBBED), String(text));
}

/** The JSON's keys, with each scalar replaced by its type. A list shows its first element's shape. */
export function structureOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [structureOf(value[0])] : [];
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [FIELD_NAME.test(k) ? k : "<key>", structureOf(v)]));
  return typeof value;
}

function bodyStructure(label, body) {
  if (!body) return [`${label}: empty`];
  try {
    return [`${label} structure:`, JSON.stringify(structureOf(JSON.parse(body)), null, 2)];
  } catch {
    return [`${label}: omitted (not JSON)`];
  }
}

const headerLines = (headers, secrets) =>
  Object.entries(headers).map(([name, value]) => `${name}: ${CREDENTIAL_HEADER.test(name) ? SCRUBBED : scrubValues(value, secrets)}`);

/** The text saved as evidence. A remote capture holds names and types, never values, and no path, which can hold a value. */
export function renderCapture({ method, url, requestHeaders, requestBody, status, responseHeaders, responseBody, secrets, remote }) {
  if (remote) {
    const saved = [
      method,
      `request headers: ${Object.keys(requestHeaders).join(", ")}`,
      ...bodyStructure("request body", requestBody),
      `status ${status}`,
      `response headers: ${Object.keys(responseHeaders).join(", ")}`,
      ...bodyStructure("response body", responseBody),
      "",
    ].join("\n");
    return scrubValues(saved, secrets);
  }
  return [
    scrubValues(`${method} ${url.pathname}${url.search}`, secrets),
    ...headerLines(requestHeaders, secrets),
    ...(requestBody ? ["", scrubValues(requestBody, secrets), ""] : []),
    `status ${status}`,
    ...headerLines(responseHeaders, secrets),
    "",
    scrubValues(responseBody, secrets),
    "",
  ].join("\n");
}

async function main() {
  const usage = (message) => {
    process.stderr.write(`${message}\n`);
    return 2;
  };
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        target: { type: "string" },
        sha: { type: "string" },
        "scenario-id": { type: "string" },
        url: { type: "string" },
        method: { type: "string" },
        "header-env": { type: "string", multiple: true, default: [] },
        "secret-env": { type: "string", multiple: true, default: [] },
        "body-file": { type: "string" },
        "test-record": { type: "string" },
      },
    }));
  } catch (e) {
    return usage(e.message);
  }

  const { target, sha, url: rawUrl, method } = values;
  const scenarioId = values["scenario-id"];
  if (!target || !sha || !scenarioId || !rawUrl || !method) return usage("usage: capture.mjs --target <origin> --sha <sha> --scenario-id <id> --url <path> --method <verb>");
  if (!SCENARIO_ID.test(scenarioId)) return usage(`--scenario-id must be a slug, got "${scenarioId}"`);

  let targetUrl;
  let url;
  try {
    targetUrl = new URL(target);
    url = new URL(rawUrl, targetUrl);
  } catch {
    return usage(`--target and --url must parse as URLs, got "${target}" and "${rawUrl}"`);
  }
  if (!["http:", "https:"].includes(targetUrl.protocol)) return usage(`--target must be http(s), got "${target}"`);
  if (url.origin !== targetUrl.origin) {
    process.stderr.write(`refused: ${url.origin} is not the target's origin ${targetUrl.origin}\n`);
    return 3;
  }

  const remote = isRemoteTarget(target);
  const verb = method.toUpperCase();
  const testRecord = values["test-record"];
  if (remote && !READ_METHODS.includes(verb) && !(testRecord && url.pathname.split("/").includes(testRecord))) {
    process.stderr.write(`refused: ${verb} on a deployed target needs a URL path naming the --test-record\n`);
    return 3;
  }

  try {
    ensureAcceptanceDir();
  } catch (e) {
    return usage(e.message);
  }

  const secrets = [];
  for (const name of values["secret-env"]) {
    if (!process.env[name]) return usage(`--secret-env ${name} is not set`);
    secrets.push(process.env[name]);
  }
  const headers = {};
  for (const pair of values["header-env"]) {
    const [header, envVar] = pair.split("=");
    if (!header || !envVar) return usage(`--header-env must be Name=ENV_VAR, got "${pair}"`);
    if (!process.env[envVar]) return usage(`--header-env ${envVar} is not set`);
    headers[header] = process.env[envVar];
    secrets.push(process.env[envVar]);
  }
  const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : undefined;

  let response;
  let responseBody;
  try {
    response = await fetch(url, { method: verb, headers, body, redirect: "manual" });
    responseBody = await response.text();
  } catch (e) {
    process.stderr.write(`the call failed: ${scrubValues(e.message, secrets)}\n`);
    return 4;
  }

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const saved = renderCapture({
    method: verb,
    url,
    requestHeaders: headers,
    requestBody: body,
    status: response.status,
    responseHeaders,
    responseBody,
    secrets,
    remote,
  });

  const file = join(ACCEPTANCE_DIR, "evidence", sha.slice(0, 7), `${scenarioId}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, saved);
  process.stderr.write(`evidence: ${file}\n`);
  process.stdout.write(scrubValues(`status ${response.status}\n${responseBody}\n`, secrets));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
