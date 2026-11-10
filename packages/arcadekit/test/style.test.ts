import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DECLARATION_BUILDERS } from "../../../tools/lint/declaration";

// The part of the kit's style that can be checked by reading its source (docs/code-style.md has
// all of it, with the reasons). Three tables, each a list a change to the kit's shape has to
// touch, so that the change is made on purpose:
//
// - DECLARATIONS: every declaration builder, checked for the shape a declaration has, for its
//   docs and for a test that declares one.
// - FACTORIES and OLDER_FACTORIES: every exported `make…` and `create…` function. A new part a
//   game supplies is a declaration, so a new factory needs a reason.
// - The guide's own links, so it keeps naming files that exist.
//
// It reads text and runs nothing, as test/entry-packages.test.ts does: a builder's behaviour is
// tested beside it, in src/.

const packageDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src");
const repoDir = path.resolve(packageDir, "../..");
const guide = "docs/code-style.md";

interface Declared {
  /** The builder's file, from src/. Its first folder is the entry whose README shows it. */
  readonly file: string;
  /**
   * The static that holds the name a game declares it with: `tag` when that name is the `_tag`
   * of the class's values, `<noun>Name` otherwise. Never `name`, which a class already has and
   * a minifier changes.
   */
  readonly name: string;
}

// Every declaration builder of the kit, by the way a game writes it. Adding one is adding a word
// to the kit's vocabulary: it also goes in DECLARATION_BUILDERS (tools/lint/declaration.ts), in
// the glossary and on its entry's page, and this file checks that it did.
const DECLARATIONS: Readonly<Record<string, Declared>> = {
  "Game.Event": { file: "game/event.ts", name: "tag" },
  "Game.Command": { file: "game/command.ts", name: "tag" },
  "Game.Rejection": { file: "game/rejection.ts", name: "tag" },
  "Game.Simulation": { file: "game/simulation.ts", name: "simulationName" },
  "Game.Engine": { file: "game/engine.ts", name: "engineName" },
  Content: { file: "content/content.ts", name: "contentName" },
  Asset: { file: "content/asset.ts", name: "assetName" },
};

// The files that return a class and build no declaration.
const OTHER_CLASS_FACTORIES: readonly string[] = [
  // The Durable Object class Cloudflare makes, sized by the Worker's module.
  "net/worker/index.ts",
];

// The exported factories that stay: a primitive of the simulation, a plain module of rules
// behind an Effect shell, or what one implementation of a service is built from. None is a part
// each game supplies. Adding a name here is a design decision: say in the PR why the new thing
// is not a declaration.
const FACTORIES: readonly string[] = [
  "createIdentifiedPool",
  "createMemoryNetwork",
  "createPool",
  "createRoom",
  "createRoomState",
  "createSocketRoom",
  "makeAudioMixer",
  "makeBrowserAudio",
  "makeRng",
  "makeSpriteSheet",
];

// The factories of the older contract, which a game calls to supply one of its parts. Each goes
// when the games that call it have moved to a declaration (ADR-0020), so this list only gets
// shorter.
const OLDER_FACTORIES: readonly string[] = [
  "makeAudioSettingsStore",
  "makeContentLoader",
  "makeCoopClient",
  "makeEngineLoader",
  "makeGameEngine",
  "makeSaveStore",
];

const read = (file: string): string => readFileSync(file, "utf-8");

/** Every source file under `dir` that is not a test, from `dir`. */
const sourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .toSorted();

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A class that extends `builder`, as a game writes it: `extends Game.Event(`, or
 * `extends Asset<Sheet, SheetError>()(` for a builder that takes its types first.
 */
const declares = (builder: string): RegExp =>
  new RegExp(
    String.raw`\bextends\s+${escaped(builder)}(?:<[^()]*>\(\))?\(`,
    "u"
  );

/** The doc comments of a file. */
const docComments = (source: string): readonly string[] =>
  source.match(/\/\*\*[\s\S]*?\*\//gu) ?? [];

/** The `ts` examples of a markdown text or a doc comment, joined. */
const examples = (text: string): string =>
  [...text.matchAll(/```ts\n(?<code>[\s\S]*?)```/gu)]
    .map((match) => match.groups?.code ?? "")
    .join("\n");

/** The body of an exported interface, or "" if the file has none by that name. */
const interfaceBody = (source: string, name: string): string =>
  new RegExp(
    String.raw`^export interface ${name}<[\s\S]*?\{\n(?<body>[\s\S]*?)^\}`,
    "mu"
  ).exec(source)?.groups?.body ?? "";

describe("the table of declarations", () => {
  it("names every builder in the kit's source", () => {
    // A builder is a function that returns a class, and its class says what it is with a `kind`
    // static. Either one finds it, so a builder that left the other out is found, and fails below.
    const builders = sourceFiles(srcDir).filter((file) =>
      /(?:\breturn|=>)\s+class\b|\bstatic readonly kind = "/u.test(
        read(path.join(srcDir, file))
      )
    );
    expect(
      builders,
      `A file under src/ builds a declaration (it returns a class, or has a \`kind\` static) that DECLARATIONS doesn't list. See ${guide}.`
    ).toStrictEqual(
      [
        ...Object.values(DECLARATIONS).map(({ file }) => file),
        ...OTHER_CLASS_FACTORIES,
      ].toSorted()
    );
  });

  it("is the list lint holds a game's declarations to", () => {
    expect(
      DECLARATION_BUILDERS,
      "tools/lint/declaration.ts and DECLARATIONS list different builders"
    ).toStrictEqual(Object.keys(DECLARATIONS));
  });
});

describe.each(Object.entries(DECLARATIONS))("%s", (builder, { file, name }) => {
  const noun = builder.split(".").at(-1) ?? builder;
  const entry = file.split("/", 1)[0] ?? "";
  const source = read(path.join(srcDir, file));

  it("takes its name as a literal, so two declarations never share a type", () => {
    expect(source).toMatch(/<\s*const (?:Name|Tag) extends string\b/u);
  });

  it("returns a class that says its kind and its name", () => {
    expect(source).toContain(`static readonly kind = "${noun}" as const;`);
    expect(source).toMatch(
      new RegExp(String.raw`static readonly ${name}: (?:Name|Tag) = \w+;`, "u")
    );
  });

  it(`has its public type written out, as ${noun}Class`, () => {
    const body = interfaceBody(source, `${noun}Class`);
    expect(body).toContain(`readonly kind: "${noun}";`);
    expect(body).toMatch(
      new RegExp(String.raw`readonly ${name}: (?:Name|Tag);`, "u")
    );
  });

  it("shows itself declared in its own doc comment", () => {
    const shown = docComments(source).some((comment) =>
      declares(builder).test(examples(comment.replaceAll(/^\s*\* ?/gmu, "")))
    );
    expect(
      shown,
      `${file} has no doc comment with a \`ts\` example of \`class X extends ${builder}(...)\``
    ).toBe(true);
  });

  it("is shown on its entry's page", () => {
    const readme = `${entry}/README.md`;
    expect(
      declares(builder).test(examples(read(path.join(srcDir, readme)))),
      `src/${readme} has no \`ts\` example of \`class X extends ${builder}(...)\``
    ).toBe(true);
  });

  it("is a term of the glossary", () => {
    expect(
      read(path.join(repoDir, "CONTEXT.md")),
      `CONTEXT.md has no entry that starts with **${noun}**:`
    ).toMatch(new RegExp(String.raw`^\*\*${noun}\*\*:`, "mu"));
  });

  it("is declared by a test of its entry", () => {
    const tests = readdirSync(path.join(srcDir, entry), {
      recursive: true,
      encoding: "utf-8",
    }).filter((test) => test.endsWith(".test.ts"));
    const declared = tests.some((test) =>
      declares(builder).test(read(path.join(srcDir, entry, test)))
    );
    expect(
      declared,
      `no test under src/${entry}/ declares a \`class X extends ${builder}(...)\``
    ).toBe(true);
  });

  // A declaration that is a service's key: its class is what an app provides and requires.
  it.skipIf(!source.includes("Context.Service<"))(
    "names its service after itself, and provides it with a layer",
    () => {
      // The key says where the service is from, and holds the declared name.
      expect(source).toContain(`\`arcadekit/${entry}/${noun}/\${name}\``);
      // The service's identity is the type of the class's own values, so the class names it:
      // Layer.Layer<MyEngine>.
      expect(source).toContain("Context.ServiceClass.Shape<");
      expect(interfaceBody(source, `${noun}Class`)).toMatch(
        /^\s*readonly layer: /mu
      );
    }
  );
});

describe("the exported factories", () => {
  it("are the ones listed", () => {
    const exported = sourceFiles(srcDir).flatMap((file) =>
      [
        ...read(path.join(srcDir, file)).matchAll(
          /^export (?:const|function|async function) (?<name>(?:make|create)[A-Z]\w*)/gmu
        ),
      ].map((match) => match.groups?.name ?? "")
    );
    expect(
      exported.toSorted(),
      `The kit's exported make… and create… functions changed. A part each game supplies is a declaration, not a factory: see "What kind of module is it" in ${guide}.`
    ).toStrictEqual([...FACTORIES, ...OLDER_FACTORIES].toSorted());
  });
});

describe("the guide", () => {
  const text = read(path.join(repoDir, guide));

  it("links only to files that exist", () => {
    const dead = [...text.matchAll(/\]\((?<target>[^)#\s]+)(?:#[^)]*)?\)/gu)]
      .map((match) => match.groups?.target ?? "")
      .filter((target) => !/^[a-z]+:/u.test(target))
      .filter(
        (target) =>
          !existsSync(path.resolve(repoDir, path.dirname(guide), target))
      );
    expect(dead).toStrictEqual([]);
  });

  it("is where AGENTS.md sends whoever adds a module", () => {
    expect(read(path.join(repoDir, "AGENTS.md"))).toContain(guide);
  });
});
