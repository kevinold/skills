import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every skill in this repo is named `ko-<name>` so it never collides with a
// hand-made or third-party skill of the same name in an agent's skills dir.
const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), "../skills");
const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

const frontmatterName = (src) => src.match(/^---\n[\s\S]*?^name:\s*(\S+)\s*$[\s\S]*?^---$/m)?.[1];

describe("skill names carry the ko- prefix", () => {
  it("finds the skills", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it.each(dirs)("%s is ko-prefixed and its frontmatter name matches", (dir) => {
    expect(dir).toMatch(/^ko-[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(frontmatterName(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"))).toBe(dir);
  });

  it("reads the frontmatter name and rejects a mismatch", () => {
    expect(frontmatterName("---\nname: ko-x\ndescription: y\n---\nbody")).toBe("ko-x");
    expect(frontmatterName("---\nname: x\n---\n")).not.toBe("ko-x");
  });
});
