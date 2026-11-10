import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DECLARATION_BUILDERS,
  OLDER_CONTRACT,
} from "../../../tools/lint/declaration";

// The part of the kit's style that takes more than one file to check (docs/code-style.md has all
// of it, with the reasons). What one file shows, such as the shape of a builder, is lint's:
// tools/lint/declaration.ts. This file has the lists a change to the kit's shape has to touch,
// so that the change is made on purpose:
//
// - DECLARATIONS: every declaration builder, checked for its docs and for a test that declares
//   one.
// - FACTORIES and OLDER_FACTORIES: every exported `make…` and `create…` function. A new part a
//   game supplies is a declaration, so a new factory needs a reason.
// - Lint's own lists, DECLARATION_BUILDERS and OLDER_CONTRACT, checked against the source.
// - The guide's links, so it keeps naming files that exist.
//
// It reads text and runs nothing, as test/entry-packages.test.ts does: a builder's behaviour is
// tested beside it, in src/.

const packageDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src");
const repoDir = path.resolve(packageDir, "../..");
const guide = "docs/code-style.md";

// Every declaration builder of the kit, by the way a game writes it, with its file from src/.
// The file's first folder is the entry whose README shows it. Adding one is adding a word to the
// kit's vocabulary: it also goes in DECLARATION_BUILDERS (tools/lint/declaration.ts), in the
// glossary and on its entry's page, and this file checks that it did.
const DECLARATIONS: Readonly<Record<string, string>> = {
  "Game.Event": "game/event.ts",
  "Game.Command": "game/command.ts",
  "Game.Rejection": "game/rejection.ts",
  "Game.Simulation": "game/simulation.ts",
  "Game.Engine": "game/engine.ts",
  Content: "content/content.ts",
  Asset: "content/asset.ts",
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

// Those of them with no declaration to use in their place yet, so lint can't refuse them
// (OLDER_CONTRACT in tools/lint/declaration.ts): a save, the audio settings and the Co-op client
// are still to move (ADR-0020). A name leaves this list for OLDER_CONTRACT with the change that
// adds its declaration.
const NOT_YET_DECLARED: readonly string[] = [
  "makeAudioSettingsStore",
  "makeCoopClient",
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
      [...Object.values(DECLARATIONS), ...OTHER_CLASS_FACTORIES].toSorted()
    );
  });

  it("is the list lint holds a game's declarations to", () => {
    expect(
      DECLARATION_BUILDERS,
      "tools/lint/declaration.ts and DECLARATIONS list different builders"
    ).toStrictEqual(Object.keys(DECLARATIONS));
  });
});

describe("the older contract lint keeps new code off", () => {
  // Each entry's public file, where a game's import of a name resolves.
  const entryFiles = Object.values(
    (
      JSON.parse(read(path.join(packageDir, "package.json"))) as {
        readonly exports: Readonly<Record<string, { readonly source: string }>>;
      }
    ).exports
  ).map(({ source }) => read(path.join(packageDir, source)));

  it("names only what the kit still exports", () => {
    // A name whose export has gone is a line to delete from OLDER_CONTRACT.
    const gone = Object.keys(OLDER_CONTRACT).filter(
      (name) =>
        !entryFiles.some((text) =>
          new RegExp(String.raw`\b${name}\b`, "u").test(text)
        )
    );
    expect(gone).toStrictEqual([]);
  });

  it("names every factory of the older contract that has a declaration", () => {
    // The older factories lint doesn't name are the ones with no declaration to use yet.
    expect(
      OLDER_FACTORIES.filter((name) => !Object.hasOwn(OLDER_CONTRACT, name))
    ).toStrictEqual(NOT_YET_DECLARED);
  });
});

describe.each(Object.entries(DECLARATIONS))("%s", (builder, file) => {
  const noun = builder.split(".").at(-1) ?? builder;
  const entry = file.split("/", 1)[0] ?? "";
  const source = read(path.join(srcDir, file));

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
