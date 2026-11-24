import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { docMarkdown, readModule, renderModule, sourceLines } from "./api.ts";
import { REPO_ROOT } from "./site.ts";

describe("a doc comment as markdown", () => {
  it("makes a block of the lines indented under a blank line", () => {
    const { body } = docMarkdown(
      '*\n * Plays a cue.\n *\n *   Sound.on(Scored, "coin")\n *     .pipe(x)\n *\n * Then more.\n '
    );
    expect(body).toBe(
      'Plays a cue.\n\n```ts\nSound.on(Scored, "coin")\n  .pipe(x)\n```\n\nThen more.'
    );
  });

  it("leaves a list's continued line in its item", () => {
    const { body } = docMarkdown("*\n * - one,\n *   still one\n * - two\n ");
    expect(body).toBe("- one,\n  still one\n- two");
  });

  it("takes a @category out of the text", () => {
    expect(
      docMarkdown("*\n * Makes one.\n *\n * @category constructors\n ")
    ).toStrictEqual({
      body: "Makes one.",
      category: "constructors",
      internal: false,
    });
  });

  it("marks what is @internal, and lists the parameters", () => {
    expect(
      docMarkdown("*\n * Holds it.\n * @param N its name\n * @internal\n ")
    ).toStrictEqual({
      body: "Holds it.\n\n- `N`: its name",
      category: undefined,
      internal: true,
    });
  });
});

describe("a source map's lines", () => {
  it("gives each line's first segment's source and line", () => {
    // Line 0 maps to source 0 line 2; line 1 to source 1 line 3; line 2 has nothing.
    expect(sourceLines("AAEA;ACCA;")).toStrictEqual([
      { source: 0, line: 2 },
      { source: 1, line: 3 },
      undefined,
    ]);
  });
});

const built = existsSync(
  path.join(REPO_ROOT, "packages/arcadekit/dist/Sound.d.ts")
);

// Read from the packages' built declarations, which CI's tests run before building.
describe.runIf(built)("a module's page", () => {
  const readSound = () =>
    readModule(
      REPO_ROOT,
      "packages/arcadekit",
      "arcadekit",
      "Sound",
      "packages/arcadekit/src/Sound.ts"
    );

  it("lists what the module exports, each with its signature and its comment", () => {
    const clip = readSound().exports.find((item) => item.name === "clip");
    expect(clip?.parts[0]?.signature).toBe(
      "const clip: (name: string, data?: unknown) => Clip;"
    );
    expect(clip?.parts[0]?.doc).toContain("Makes a clip by hand");
  });

  it("links each export to the line of the source that writes it", () => {
    const clip = readSound().exports.find((item) => item.name === "clip");
    expect(clip?.parts[0]?.source?.file).toBe(
      "packages/arcadekit/src/Sound.ts"
    );
    expect(clip?.parts[0]?.source?.line).toBeGreaterThan(1);
  });

  it("follows a name the build declares in a chunk shared with other modules", () => {
    const event = readModule(
      REPO_ROOT,
      "packages/arcadekit",
      "arcadekit",
      "Event",
      "packages/arcadekit/src/Event.ts"
    );
    const define = event.exports.find((item) => item.name === "define");
    expect(define?.parts[0]?.source?.file).toBe(
      "packages/arcadekit/src/Event.ts"
    );
  });

  it("lists the exports an entry gives from its files file by file, each in the order it is written", () => {
    const written = readModule(
      REPO_ROOT,
      "packages/arcadekit",
      "arcadekit",
      "ecs",
      "packages/arcadekit/src/ecs/index.ts"
    ).exports.map((item) => item.parts[0]?.source);
    const files = written.map((source) => source?.file);
    // Each file's exports together: once another file's start, none follows.
    expect(files.filter((file, i) => file !== files[i - 1])).toStrictEqual([
      ...new Set(files),
    ]);
    expect(new Set(files).size).toBeGreaterThan(1);
    for (const file of new Set(files)) {
      const lines = written
        .filter((source) => source?.file === file)
        .map((source) => source!.line);
      expect(lines).toStrictEqual(lines.toSorted((a, b) => a - b));
    }
  });

  const signatureOf = (name: string, exported: string, file = `${name}.ts`) =>
    readModule(
      REPO_ROOT,
      "packages/arcadekit",
      "arcadekit",
      name,
      `packages/arcadekit/src/${file}`
    )
      .exports.find((item) => item.name === exported)
      ?.parts.map((part) => part.signature)
      .join("\n") ?? "";

  it("leaves private and @internal members out of a class, with their comments", () => {
    const bus = signatureOf("Event", "EventBus");
    expect(bus).toContain("emit<P>(def: EventDef<P>, payload: P): void;");
    expect(bus).not.toMatch(/private|#private|@internal|_emit|reader|settled/u);
    const world = signatureOf("ecs", "World", "ecs/index.ts");
    expect(world).toContain("class World");
    expect(world).not.toMatch(/private|@internal|_recTable|_reserve/u);
  });

  it("leaves @internal members out of an interface", () => {
    const player = signatureOf("Sound", "PlayerShape");
    expect(player).toContain("readonly play:");
    expect(player).not.toMatch(/_flush|@internal/u);
  });

  it("shows the members of a class that a base factory makes", () => {
    const actions = signatureOf("Action", "Actions");
    expect(actions).not.toContain("Actions_base");
    expect(actions).toContain("readonly enqueue:");
    expect(actions).toContain(
      "readonly handles: (action: AnyActionDef) => boolean;"
    );
  });

  it("starts with the module's comment and how to import it", () => {
    const page = renderModule(readSound(), "https://github.com/o/r", "main");
    expect(page.startsWith("Sound plays named cues")).toBe(true);
    expect(page).toContain('import * as Sound from "arcadekit/Sound"');
    expect(page).toContain("## Constructors\n\n### clip");
  });

  it("lists the categories in their order", () => {
    const page = renderModule(readSound(), "https://github.com/o/r", "main");
    const at = (heading: string) => page.indexOf(`\n## ${heading}\n`);
    expect(at("Constructors")).toBeGreaterThan(-1);
    expect(at("Constructors")).toBeLessThan(at("Models"));
    expect(at("Models")).toBeLessThan(at("Services"));
    expect(at("Services")).toBeLessThan(at("Testing"));
  });

  it("links each export to where it is written", () => {
    const page = renderModule(readSound(), "https://github.com/o/r", "main");
    expect(page).toContain(
      "https://github.com/o/r/blob/main/packages/arcadekit/src/Sound.ts#L"
    );
  });
});
