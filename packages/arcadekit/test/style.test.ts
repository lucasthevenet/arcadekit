import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILDER_ENTRIES,
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

interface Declared {
  /** The builder's file, from src/. Its first folder is the entry whose README shows it. */
  readonly file: string;
  /** Whether its class is a service's key, which an app provides with its `layer`. */
  readonly service: boolean;
}

// Every declaration builder of the kit, by the way a game writes it. Adding one is adding a word
// to the kit's vocabulary: it also goes in DECLARATION_BUILDERS (tools/lint/declaration.ts), in
// the glossary and on its entry's page, and this file checks that it did.
const DECLARATIONS: Readonly<Record<string, Declared>> = {
  "Game.Event": { file: "game/event.ts", service: false },
  "Game.Command": { file: "game/command.ts", service: false },
  "Game.Rejection": { file: "game/rejection.ts", service: false },
  "Game.Simulation": { file: "game/simulation.ts", service: false },
  "Game.Engine": { file: "game/engine.ts", service: true },
  Content: { file: "content/content.ts", service: true },
  Asset: { file: "content/asset.ts", service: true },
};

const nounOf = (builder: string): string =>
  builder.split(".").at(-1) ?? builder;

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

const read = (file: string): string => {
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(repoDir, file)} is not a file: a table of this test names it`
    );
  }
  return readFileSync(file, "utf-8");
};

/** A source text without its comments, so prose about code is not read as code. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");

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
    String.raw`\bextends\s+${escaped(builder)}(?:<[\s\S]*?>\(\))?\(`,
    "u"
  );

/** The doc comments of a file. */
const docComments = (source: string): readonly string[] =>
  source.match(/\/\*\*[\s\S]*?\*\//gu) ?? [];

/** The `ts` examples of a markdown text or a doc comment, joined. */
const examples = (text: string): string =>
  [...text.matchAll(/^```ts\n(?<code>[\s\S]*?)^```/gmu)]
    .map((match) => match.groups?.code ?? "")
    .join("\n");

/** The body of an exported interface, or "" if the file has none by that name. */
const interfaceBody = (source: string, name: string): string =>
  new RegExp(
    String.raw`^export interface ${name}<[\s\S]*?\{\n(?<body>[\s\S]*?)^\}`,
    "mu"
  ).exec(source)?.groups?.body ?? "";

describe("the table of declarations", () => {
  it("names every builder in the kit's source, each with its kind", () => {
    // A builder's class says what it is with a `kind` static, and a builder returns a class.
    // Each `kind` under src/ is one builder; a file that returns a class and gives no kind is
    // one too, and fails here.
    const found = sourceFiles(srcDir).flatMap((file) => {
      const text = code(read(path.join(srcDir, file)));
      const kinds = [
        ...text.matchAll(
          /\bstatic (?:readonly )?kind\b[^=;]*=\s*"(?<kind>\w+)"/gu
        ),
      ].map((match) => `${file}: ${match.groups?.kind}`);
      return kinds.length === 0 && /(?:\breturn|=>)\s+class\b/u.test(text)
        ? [`${file}: no kind`]
        : kinds;
    });
    expect(
      found.toSorted(),
      `The kit's builders are not the ones DECLARATIONS lists. A \`kind\` static is how a builder's class says what it is: one builder for each kind, in the file the table names. See ${guide}.`
    ).toStrictEqual(
      [
        ...Object.entries(DECLARATIONS).map(
          ([builder, { file }]) => `${file}: ${nounOf(builder)}`
        ),
        ...OTHER_CLASS_FACTORIES.map((file) => `${file}: no kind`),
      ].toSorted()
    );
  });

  it("is the list lint holds a game's declarations to", () => {
    expect(
      DECLARATION_BUILDERS.toSorted(),
      "tools/lint/declaration.ts and DECLARATIONS list different builders"
    ).toStrictEqual(Object.keys(DECLARATIONS).toSorted());
  });

  it("names every noun an entry gives a builder", () => {
    // `export const Event: typeof makeEvent = makeEvent;` is how an entry imported as a namespace
    // names a builder. A second such line for one builder is a second word for the same part.
    const nouns = sourceFiles(srcDir).flatMap((file) =>
      [
        ...code(read(path.join(srcDir, file))).matchAll(
          /^export const (?<noun>\w+): typeof make\w* = make\w*;/gmu
        ),
      ].map((match) => `Game.${match.groups?.noun}`)
    );
    expect(nouns.toSorted()).toStrictEqual(
      Object.keys(DECLARATIONS)
        .filter((builder) => builder.startsWith("Game."))
        .toSorted()
    );
  });

  it("is exported by the entries lint reads a file's builders from", () => {
    const exportsMap = (
      JSON.parse(read(path.join(packageDir, "package.json"))) as {
        readonly exports: Readonly<Record<string, { readonly source: string }>>;
      }
    ).exports;
    const exportedBy = (written: "namespace" | "bare"): string =>
      Object.entries(BUILDER_ENTRIES)
        .filter(([, how]) => how === written)
        .map(([entry]) => {
          const source = exportsMap[entry.replace("arcadekit", ".")]?.source;
          return code(read(path.join(packageDir, source ?? entry)));
        })
        .join("\n");
    const missing = Object.keys(DECLARATIONS).filter(
      (builder) =>
        !new RegExp(String.raw`\b${nounOf(builder)}\b`, "u").test(
          exportedBy(builder.includes(".") ? "namespace" : "bare")
        )
    );
    expect(missing).toStrictEqual([]);
  });

  it("is in the lists a reader starts from", () => {
    const glossary =
      /^\*\*Declaration\*\*:.*$/mu.exec(
        read(path.join(repoDir, "CONTEXT.md"))
      )?.[0] ?? "";
    const agents = read(path.join(repoDir, "AGENTS.md"));
    const unlisted = Object.keys(DECLARATIONS).flatMap((builder) => [
      ...(glossary.includes(`\`${builder}\``)
        ? []
        : [`CONTEXT.md: ${builder}`]),
      ...(agents.includes(`\`${builder}\``) ? [] : [`AGENTS.md: ${builder}`]),
    ]);
    expect(
      unlisted,
      "The glossary's Declaration entry and AGENTS.md each list the kit's declarations"
    ).toStrictEqual([]);
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

describe.each(Object.entries(DECLARATIONS))(
  "%s",
  (builder, { file, service }) => {
    const noun = nounOf(builder);
    const entry = file.split("/", 1)[0] ?? "";
    // Read when a test runs, so a file that moved fails a test and not the whole file.
    const source = (): string => read(path.join(srcDir, file));

    it("shows itself declared in its own doc comment", () => {
      const shown = docComments(source()).some((comment) =>
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
        declares(builder).test(code(read(path.join(srcDir, entry, test))))
      );
      expect(
        declared,
        `no test under src/${entry}/ declares a \`class X extends ${builder}(...)\``
      ).toBe(true);
    });

    it(`${service ? "is" : "is not"} a service's key, as the table says`, () => {
      expect(source().includes("Context.Service<")).toBe(service);
    });

    // A declaration that is a service's key: its class is what an app provides and requires.
    it.skipIf(!service)(
      "names its service after itself, and provides it with a layer",
      () => {
        // The key says where the service is from, and holds the declared name: the value the
        // service is made with, not only the type that names it.
        expect(source()).toMatch(
          new RegExp(
            `\`arcadekit/${entry}/${noun}/${String.raw`\$\{\w+\}`}\` as ${noun}Id<`,
            "u"
          )
        );
        // The service's identity is the type of the class's own values, so the class names it:
        // Layer.Layer<MyEngine>.
        expect(source()).toMatch(
          new RegExp(
            String.raw`type ${noun}Service<[\s\S]*?> = Context\.ServiceClass\.Shape<`,
            "u"
          )
        );
        expect(interfaceBody(source(), `${noun}Class`)).toMatch(
          /^\s*readonly layer: /mu
        );
      }
    );
  }
);

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
      `The kit's exported make… and create… functions changed. An export named that way is read as a factory, and a part each game supplies is a declaration, not a factory: see "What kind of module is it" in ${guide}. If it makes nothing a game supplies, name it for what it returns.`
    ).toStrictEqual([...FACTORIES, ...OLDER_FACTORIES].toSorted());
  });
});

describe("the guide", () => {
  const text = read(path.join(repoDir, guide));

  it("links only to files that exist", () => {
    // Code is not prose: `cases[tag](event)` is no link.
    const prose = text.replaceAll(/```[\s\S]*?```|`[^`\n]*`(?!\])/gu, "");
    const targets = [
      ...prose.matchAll(/\]\((?<target>[^)#\s]+)(?:#[^)]*)?\)/gu),
    ]
      .map((match) => match.groups?.target ?? "")
      .filter((target) => !/^[a-z]+:/u.test(target));
    // The guide names the files to copy: finding few links means this stopped reading them.
    expect(targets.length).toBeGreaterThan(10);
    expect(
      targets.filter(
        (target) =>
          !existsSync(path.resolve(repoDir, path.dirname(guide), target))
      )
    ).toStrictEqual([]);
  });

  it("is where AGENTS.md sends whoever adds a module", () => {
    expect(read(path.join(repoDir, "AGENTS.md"))).toContain(guide);
  });
});
