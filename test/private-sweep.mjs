// Sweeps shared by the repo-level guards. This file lives outside the skill folders so consumers never install it.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// --- Private-literal sweep ----------------------------------------------------
//
// Names from the private repos these skills were extracted from: orgs, products,
// people, seed tenants, vendors, hosts, internal tags. Stored only as SHA-256 of
// the lowercased token — base64 or plaintext would publish the very names the
// guard keeps out of this public repo.
export const PRIVATE = new Set([
  "796472345404ddcac9393b32f02481244ebbe03a2f6b52f903d4d1c2123eb662",
  "be17d9686c8bfa2e37988b4e9a87e25a2078f1edaea071b56ad59d73ab31220a",
  "2b277f396c330786c75b8596ba0bd0c9794fe136eb1d9522f84042d6c48d4aed",
  "8a7feb4abff5cc24d4e8c8971133606b7e84f4d1076ed0b5c65d69379f1f11bb",
  "91b6da07adf530f8a9710301b4fd94c3828058e4942a68e48627dc28c6688778",
  "80b1f269955ba50701d2070eb6b43fddaed7b3bdda9ed7afb5e0c1a483e425cc",
  "4455138c4b5ea68d9a4e99694c50b9a51b292350fabd5e9aec450213f79b578f",
  "ee163e0b6b0749d28782eeb94c8f197339da2b62b9ad6791bdf598e3670fe16d",
  "adc17a68f3fc0f46483c8f815fae86d74409fc27c0829b4d9ed6cdc0e3b3fdfa",
  "4626cd1a3e6d10aa8a50bf96dfea04637f3993c723a7d42ec0a77892572f7d6b",
  "f0bacd14b144f4a253b13c5972479678b8b5e138b4f3cd65b150d675a1207e5a",
  "dcd519d47e3e6ecc3e9623cd0ecc6ff5d78b01ffbb00b953a47b93d691db7f20",
  "23504ac853a0404ad6ca67f7494eb3008ad7d2b24c09cc3793c6b2095fd66c78",
  "cea6111b56f82e1e38f87e7d891e6798879cf82f1eb88134981e305e61211a1f",
  "436daa0647b28d2fe38c71bc48657b415ee0c8ebebd060642fea5c7b83641913",
  "246f2e285d6413c1b32093e3a04751e0b86654c8d23ad34305096ac402fd1660",
  "af6db6cf20f30a7ad7fae60c1917c306c5033c213dee0a49013ac67d34235ebe",
  "b3604a27dcf304c8a8f916573ec79aaf60065476b99573c453ad834988f4ad56",
  "61548bf1da865037dc424e3dbcea3e703edbf2fa87b0c7a85f1cc1cb547fdb58",
  "f26ebb8c857cb112ae370dd8ae3331f1fa8a5f5331216824948430625ccc0741",
  "7f1282974437f511dacee4013a0814bf7cbab38dd07040a4b4a82cebd50d134e",
  "e23e111961d315b688651c65239408ea9af5e1db0da94dc075f32bb9e8280450",
  "14cdf7df4611a6f9342dd0c29a5675109a360b15d3295f9e1fbf6d7d9a9e2228",
  "2d15769d0f047e8d061608373004d89c147e13c4e3241c35b640b8145f934f3b",
  "e972c55ef0fae6fd36f07cddb3fbc712698f5ea8b6dfaa2fa5fcca8c78af76f3",
  "460e4626ea68653e1bf63672f444d8821c7402a09514a57a4fc0268b8e4b5622",
]);

export const sha = (s) => createHash("sha256").update(s).digest("hex");

// Every 1-, 2- and 3-word window of a line, lowercased and split on non-alphanumerics.
export const ngrams = (line) => {
  const w = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
};

// `name:lineNo` for every line of `src` that `pred` matches.
export const lineHits = (name, src, pred) => src.split("\n").flatMap((l, i) => (pred(l) ? [`${name}:${i + 1}`] : []));

export const sweepPrivate = (name, src, hashes = PRIVATE) =>
  lineHits(name, src, (l) => ngrams(l).some((g) => hashes.has(sha(g))));

// --- No absolute paths ---------------------------------------------------------

const ABSOLUTE = /\/Users\/|\/home\/[a-z]|file:\/\/\/|[A-Z]:\\Users\\/;
export const absoluteHits = (name, src) => lineHits(name, src, (l) => ABSOLUTE.test(l));

// --- Links resolve inside the skill -------------------------------------------
//
// Markdown links and HTML hrefs outside code and comments. External URLs are
// skipped; `<...>` placeholder targets are template slots and are exempt.

const stripCode = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

export function linkProblems(file, src, skillDir) {
  const body = stripCode(src);
  const targets = [
    ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  ];
  const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const problems = [];
  for (const t of targets) {
    if (/^(https?:|mailto:)/.test(t) || /[<>]/.test(t)) continue;
    if (t.startsWith("#")) {
      if (file.endsWith(".html") && !ids.has(t.slice(1))) problems.push(`${t} has no matching id`);
      continue;
    }
    const target = resolve(dirname(file), t.split("#")[0]);
    if (relative(skillDir, target).startsWith("..")) problems.push(`${t} leaves the skill`);
    else if (!existsSync(target)) problems.push(`${t} does not exist`);
  }
  return problems;
}
