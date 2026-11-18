import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// What an agent is told to read: `AGENTS.md`, the skills and the roadmap. A
// session pays for every line of it, and a line that names what is gone
// misleads it, so each is held to a size and to what exists.

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SKILLS = ".agents/skills";

/** What every session reads may be this long, in bytes. */
const ALWAYS_READ = 6000;
/** What is read whole, a skill's file, may be this long. */
const READ_WHOLE = 12_000;
/** A skill's description is in every session too. */
const DESCRIPTION = 400;
/** A package's README says what the package is and where its docs are. */
const README = 2000;

/** Where a path that a file names may start: the root, and each package. */
const BASES = ["", "packages/arcadekit", "packages/three", "website"];

const read = (file: string): string =>
  readFileSync(path.join(ROOT, file), "utf-8");

const markdownUnder = (folder: string): string[] =>
  readdirSync(path.join(ROOT, folder), { recursive: true })
    .map((entry) => path.join(folder, String(entry)))
    .filter((file) => file.endsWith(".md"))
    .toSorted();

const skills = readdirSync(path.join(ROOT, SKILLS)).toSorted();
const files = [
  "AGENTS.md",
  "ROADMAP.md",
  ...markdownUnder("roadmap"),
  ...markdownUnder(SKILLS),
];

/** A file's prose: its text without the code it fences. */
const prose = (text: string): string =>
  text.replaceAll(/^ *```[^\n]*\n[\s\S]*?^ *```$/gmu, "");

/** The anchors GitHub gives a file's headings. */
const anchors = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const [, heading = ""] of prose(text).matchAll(/^#{1,6} +(.+)$/gmu)) {
    const anchor = heading
      .trim()
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
      .replaceAll(/\s/gu, "-");
    let unique = anchor;
    for (let n = 1; found.has(unique); n += 1) {
      unique = `${anchor}-${n}`;
    }
    found.add(unique);
  }
  return found;
};

/** The spans of inline code in a file's prose. */
const spans = (text: string): string[] =>
  [...prose(text).matchAll(/`([^`\n]+)`/gu)].map(([, span = ""]) => span);

const scriptsOf = (folder: string): Record<string, string> =>
  (
    JSON.parse(read(path.join(folder, "package.json"))) as {
      readonly scripts?: Record<string, string>;
    }
  ).scripts ?? {};

/** The folder of each package of the workspace, by the name `--filter` takes. */
const packages = new Map(
  ["packages/arcadekit", "packages/three", "website"].map((folder) => [
    (
      JSON.parse(read(path.join(folder, "package.json"))) as {
        readonly name: string;
      }
    ).name,
    folder,
  ])
);

describe("what every session reads", () => {
  it("is AGENTS.md, which CLAUDE.md imports and adds nothing to", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
  });

  it("is short: what one kind of work needs is in a skill, not in AGENTS.md", () => {
    expect(
      Buffer.byteLength(read("AGENTS.md")),
      "AGENTS.md is read by every session, whatever its task. Move what one kind of work needs into the skill for it."
    ).toBeLessThanOrEqual(ALWAYS_READ);
  });

  it("has each skill's name and description, which say when to load it and no more", () => {
    for (const skill of skills) {
      const text = read(path.join(SKILLS, skill, "SKILL.md"));
      const name = /^name: (.+)$/mu.exec(text)?.[1];
      const description = /^description: (.+)$/mu.exec(text)?.[1] ?? "";
      expect(name, skill).toBe(skill);
      expect(description, skill).toMatch(/\. Use when /u);
      expect(description.length, skill).toBeLessThanOrEqual(DESCRIPTION);
    }
  });

  it("finds the skills where Claude Code looks for them", () => {
    expect(realpathSync(path.join(ROOT, ".claude/skills"))).toBe(
      realpathSync(path.join(ROOT, SKILLS))
    );
  });
});

describe("a package's README", () => {
  it("is a description and links: what it would explain is on the site", () => {
    for (const folder of ["packages/arcadekit", "packages/three"]) {
      const text = read(path.join(folder, "README.md"));
      expect(
        Buffer.byteLength(text),
        `${folder}/README.md explains nothing. Say it on a page of website/src/content/docs/, or in a doc comment, and link to the site.`
      ).toBeLessThanOrEqual(README);
      expect(text, folder).toContain("https://arcadekit.dev");
    }
  });
});

describe("a skill", () => {
  it("is files short enough to be read whole, a branch of the work in each", () => {
    for (const file of markdownUnder(SKILLS)) {
      expect(
        Buffer.byteLength(read(file)),
        `${file} is read whole by whoever needs any of it. Give a part of it that other work does not need a file of its own.`
      ).toBeLessThanOrEqual(READ_WHOLE);
    }
  });

  it("reaches each of its files from its SKILL.md, which says when to read it", () => {
    for (const skill of skills) {
      const folder = path.join(SKILLS, skill);
      const entry = read(path.join(folder, "SKILL.md"));
      for (const file of markdownUnder(folder)) {
        const name = path.relative(folder, file);
        if (name !== "SKILL.md") {
          expect(entry, `${folder}/SKILL.md links to ${name}`).toContain(
            `](${name})`
          );
        }
      }
    }
  });
});

describe("what an agent is told to read", () => {
  it("links to files that exist, and to headings they have", () => {
    const dead: string[] = [];
    for (const file of files) {
      for (const [, link = ""] of prose(read(file)).matchAll(
        /\]\(([^)\s]+)\)/gu
      )) {
        if (/^[a-z]+:/u.test(link)) {
          continue;
        }
        const [target = "", fragment] = link.split("#");
        const to = path.join(path.dirname(file), target);
        if (!existsSync(path.join(ROOT, to))) {
          dead.push(`${file}: ${link}`);
        } else if (fragment !== undefined && !anchors(read(to)).has(fragment)) {
          dead.push(`${file}: ${link} (no such heading)`);
        }
      }
    }
    expect(dead).toStrictEqual([]);
  });

  it("names paths that exist", () => {
    const gone: string[] = [];
    for (const file of files) {
      for (const span of spans(read(file))) {
        const isPath =
          /^\.?[\w@-][\w.@-]*(?:\/[\w.@-]+)+\/?$/u.test(span) &&
          /\/$|\.(?:ts|tsx|mjs|json|md|mdx|sh|yml|css|astro)$/u.test(span);
        if (
          isPath &&
          !BASES.some((base) => existsSync(path.join(ROOT, base, span)))
        ) {
          gone.push(`${file}: ${span}`);
        }
      }
    }
    expect(gone).toStrictEqual([]);
  });

  it("names commands that exist", () => {
    const gone: string[] = [];
    for (const file of files) {
      for (const span of spans(read(file))) {
        for (const command of span.split("&&")) {
          const match =
            /^\s*pnpm(?: --filter (?<name>\S+))?(?: run)? (?<script>[a-z][\w:-]*)/u.exec(
              command
            );
          if (match?.groups === undefined) {
            continue;
          }
          const { name, script = "" } = match.groups;
          const folder = name === undefined ? "" : packages.get(name);
          if (folder === undefined || !(script in scriptsOf(folder))) {
            gone.push(`${file}: ${command.trim()}`);
          }
        }
      }
    }
    expect(gone).toStrictEqual([]);
  });

  it("names skills that exist", () => {
    for (const file of files) {
      for (const [, skill = ""] of read(file).matchAll(/`([\w-]+)` skill/gu)) {
        expect(skills, `${file} names the ${skill} skill`).toContain(skill);
      }
    }
  });
});
