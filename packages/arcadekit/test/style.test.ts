import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILDER_ENTRIES,
  DECLARATION_BUILDERS,
} from "../../../tools/lint/declaration";

// The part of the kit's style that takes more than one file to check (docs/code-style.md has all
// of it, with the reasons). What one file shows, such as the shape of a builder, is lint's:
// tools/lint/declaration.ts. This file has the lists a change to the kit's shape has to touch,
// so that the change is made on purpose:
//
// - DECLARATIONS: every declaration builder, checked for its docs and for a test that declares
//   one.
// - FACTORIES and NOT_YET_DECLARED: every exported `make…` and `create…` function. A new part a
//   game supplies is a declaration, so a new factory needs a reason.
// - Lint's own lists, DECLARATION_BUILDERS and BUILDER_ENTRIES, checked against the source.
// - The guide's links, so it keeps naming files that exist.
//
// It reads text and runs nothing, as test/entry-packages.test.ts does: a builder's behaviour is
// tested beside it, in src/. Each check fails with a message that says what to write.

const packageDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src");
const repoDir = path.resolve(packageDir, "../..");
const guide = "docs/code-style.md";

// The sections of the guide this file's messages send a reader to, each by its heading.
const SECTIONS = {
  kinds: "What kind of module is it",
  service: "A declaration with a service",
  register: "Register it",
} as const;

interface Declared {
  /** The builder's file, from src/. Its first folder is the entry whose README shows it. */
  readonly file: string;
  /** Whether its class is a service's key, which an app provides with its `layer`. */
  readonly service: boolean;
}

// Every declaration builder of the kit, by the way a game writes it. Adding one is adding a word
// to the kit's vocabulary: it also goes in DECLARATION_BUILDERS (tools/lint/declaration.ts), with
// its entry in BUILDER_ENTRIES there, in the glossary, in AGENTS.md and on its entry's page, and
// this file checks that it did.
const DECLARATIONS: Readonly<Record<string, Declared>> = {
  "Game.Event": { file: "game/event.ts", service: false },
  "Game.Command": { file: "game/command.ts", service: false },
  "Game.Rejection": { file: "game/rejection.ts", service: false },
  "Game.Simulation": { file: "game/simulation.ts", service: false },
  "Game.Engine": { file: "game/engine.ts", service: true },
  Content: { file: "content/content.ts", service: true },
  Asset: { file: "content/asset.ts", service: true },
  Coop: { file: "net/browser/coop.ts", service: true },
  Save: { file: "save/save.ts", service: true },
  Setting: { file: "save/setting.ts", service: true },
};

const nounOf = (builder: string): string =>
  builder.split(".").at(-1) ?? builder;

/**
 * A builder's noun as prose writes it, which is how the glossary heads its entry: `Cue table`
 * for a builder named `CueTable`. A noun of one word is unchanged.
 */
const asProse = (noun: string): string => {
  const [first = "", ...rest] = noun.split(/(?<=[a-z0-9])(?=[A-Z])/u);
  return [first, ...rest.map((word) => word.toLowerCase())].join(" ");
};

/** `builders`, as a sentence lists them: "`Content` and `Asset`". */
const listed = (builders: readonly string[]): string =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(
    builders.map((builder) => `\`${builder}\``)
  );

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

// The factories a game still calls to supply one of its parts, for want of a declaration. None
// is left: `makeSaveStore` went with `Save`, and `makeAudioSettingsStore` with `Setting`
// (ADR-0020). A name is listed here only until the change that adds its declaration, moves
// every caller and deletes the factory.
const NOT_YET_DECLARED: readonly string[] = [];

const read = (file: string): string => {
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(repoDir, file)} is not a file, and a table of this test names it. Write its path there as the file is now named.`
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
      `The kit's builders are not the ones DECLARATIONS lists. A \`kind\` static is how a builder's class says what it is: one builder for each kind, in the file the table names. Add a new builder to DECLARATIONS in this file, as a game writes it, with its file and whether its class is a service's key. See "${SECTIONS.register}" in ${guide}.`
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
      "DECLARATION_BUILDERS in tools/lint/declaration.ts and DECLARATIONS in this file list different builders. A builder goes in both, as a game writes it (`Game.Event`, `Content`): lint then holds every declaration made with it to the declaration rules, and this file checks its docs."
    ).toStrictEqual(Object.keys(DECLARATIONS).toSorted());
  });

  it("names every noun an entry gives a builder", () => {
    // `export const Event: typeof makeEvent = makeEvent;` is how an entry imported as a namespace
    // names a builder. A second such line for one builder is a second word for the same part.
    // The formatter breaks a long one after its `=`.
    const nouns = sourceFiles(srcDir).flatMap((file) =>
      [
        ...code(read(path.join(srcDir, file))).matchAll(
          /^export const (?<noun>\w+): typeof make\w* =\s+make\w*;/gmu
        ),
      ].map((match) => `Game.${match.groups?.noun}`)
    );
    expect(
      nouns.toSorted(),
      "The lines `export const <Noun>: typeof make<Noun> = make<Noun>;` under src/ are not the `Game.<Noun>` builders DECLARATIONS lists, one line each. Such a line is how an entry that a game imports as a namespace names a builder its file exports as `make`: only `arcadekit/game` and its `./browser` are imported that way, and each of their builders has one line, in the entry's public file. A builder a game writes bare has none: its own file exports it under its noun (`export const Content = ...`)."
    ).toStrictEqual(
      Object.keys(DECLARATIONS)
        .filter((builder) => builder.startsWith("Game."))
        .toSorted()
    );
  });

  it("is exported by an entry lint reads a file's builders from", () => {
    const exportsMap = (
      JSON.parse(read(path.join(packageDir, "package.json"))) as {
        readonly exports: Readonly<Record<string, { readonly source: string }>>;
      }
    ).exports;
    // The entry is one of the builder's own folder, so that a word another entry happens to
    // export is not taken for the builder.
    const missing = Object.entries(DECLARATIONS)
      .filter(([builder, { file }]) => {
        const written = builder.includes(".") ? "namespace" : "bare";
        const folder = `./src/${file.split("/", 1)[0]}/`;
        const named = new RegExp(String.raw`\b${nounOf(builder)}\b`, "u");
        return !Object.entries(BUILDER_ENTRIES).some(([entry, how]) => {
          const source = exportsMap[entry.replace("arcadekit", ".")]?.source;
          return (
            how === written &&
            source?.startsWith(folder) === true &&
            named.test(code(read(path.join(packageDir, source))))
          );
        });
      })
      .map(([builder]) => builder);
    expect(
      missing,
      `No entry in BUILDER_ENTRIES (tools/lint/declaration.ts) exports ${listed(missing)}, so lint holds no declaration made with it to the declaration rules, in a game's code or in the kit's own. Export the builder from its entry's public file, and list that entry in BUILDER_ENTRIES as a game imports it: "namespace" if a game writes its builders \`Game.<Noun>\`, "bare" if it writes them by their noun.`
    ).toStrictEqual([]);
  });

  it("is in the lists a reader starts from", () => {
    const glossary =
      /^\*\*Declaration\*\*:.*$/mu.exec(
        read(path.join(repoDir, "CONTEXT.md"))
      )?.[0] ?? "";
    // The one sentence, as the glossary's one entry: other lines of AGENTS.md name a builder too.
    const agents =
      /\bThey are\b.*?\.(?=\s|$)/mu.exec(
        read(path.join(repoDir, "AGENTS.md"))
      )?.[0] ?? "";
    const unlisted = Object.keys(DECLARATIONS).flatMap((builder) => [
      ...(glossary.includes(`\`${builder}\``)
        ? []
        : [`CONTEXT.md: ${builder}`]),
      ...(agents.includes(`\`${builder}\``) ? [] : [`AGENTS.md: ${builder}`]),
    ]);
    expect(
      unlisted,
      "The glossary's **Declaration** entry (CONTEXT.md) and the sentence of AGENTS.md that begins \"They are\" each list the kit's declarations. Add each builder below to the file named before it, in backticks, as a game writes it."
    ).toStrictEqual([]);
  });
});

describe.each(Object.entries(DECLARATIONS))(
  "%s",
  (builder, { file, service }) => {
    const noun = nounOf(builder);
    // The entry's first folder under src/: where its README and its tests are, and what the key
    // of its service starts with.
    const entry = file.split("/", 1)[0] ?? "";
    // Read when a test runs, so a file that moved fails a test and not the whole file.
    const source = (): string => read(path.join(srcDir, file));
    const serviceRule = `See "${SECTIONS.service}" in ${guide}.`;

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
      // The term is the noun as prose writes it: `**Cue table**:` for a builder named CueTable.
      const term = asProse(noun);
      expect(
        new RegExp(String.raw`^\*\*${escaped(term)}\*\*:`, "mu").test(
          read(path.join(repoDir, "CONTEXT.md"))
        ),
        `CONTEXT.md has no entry that starts with \`**${term}**:\`. The glossary's term for a builder is its noun as prose writes it${term === noun ? "" : `, so \`${noun}\` is headed \`**${term}**:\`, with the identifier in backticks inside the entry`}. Add the entry: what the part is, and the words to avoid.`
      ).toBe(true);
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

    it.skipIf(service)("is no service's key, as the table says", () => {
      expect(
        source(),
        `${file} makes a service's key with \`Context.Service<...>\`, and DECLARATIONS says ${builder} has no service. Write \`service: true\` in the table: this file then checks its key, its identity and its \`layer\`.`
      ).not.toContain("Context.Service<");
    });

    // A declaration that is a service's key: its class is what an app provides and requires.
    describe.skipIf(!service)("as a service's key", () => {
      it("makes the key its class extends, as the table says", () => {
        expect(
          source(),
          `DECLARATIONS says the class of ${builder} is a service's key (\`service: true\`), and ${file} makes no key with \`Context.Service<...>()(...)\`. Make the key there and have the class extend it, or write \`service: false\` in the table. ${serviceRule}`
        ).toContain("Context.Service<");
      });

      // The key says where the service is from, and holds the declared name: the value the
      // service is made with, not only the type that names it.
      it("keys its service by its folder, its noun and the declared name", () => {
        expect(
          new RegExp(
            `\`arcadekit/${entry}/${noun}/${String.raw`\$\{\w+\}`}\` as ${noun}Id<`,
            "u"
          ).test(source()),
          `${file} makes no key \`arcadekit/${entry}/${noun}/\${name}\` as ${noun}Id<Name>. A declaration's service is keyed by the entry's folder, the builder's noun and the declared name, and the key's type is \`${noun}Id<Name>\`: write \`Context.Service<...>()(\`arcadekit/${entry}/${noun}/\${name}\` as ${noun}Id<Name>)\`. ${serviceRule}`
        ).toBe(true);
      });

      // The service's identity is the type of the class's own values, so the class names it:
      // Layer.Layer<MyEngine>. The formatter breaks the line inside the angle brackets or after
      // the `=`, by its length.
      it("names its service's identity after itself", () => {
        expect(
          new RegExp(
            String.raw`type ${noun}Service<[\s\S]*?>\s*=\s*Context\.ServiceClass\.Shape<`,
            "u"
          ).test(source()),
          `${file} has no \`type ${noun}Service<...> = Context.ServiceClass.Shape<${noun}Id<Name>, ...>\`. The service's identity is the type of the class's own values, named \`${noun}Service\`, so the class names what an Effect requires: \`Layer.Layer<My${noun}>\`. ${serviceRule}`
        ).toBe(true);
      });

      it("provides its service with a layer", () => {
        expect(
          /^\s*readonly layer: /mu.test(
            interfaceBody(source(), `${noun}Class`)
          ),
          `The interface ${noun}Class in ${file} has no \`readonly layer\`. An app provides the service with the class's \`layer\`: a Layer, or a function of what the app gives that returns one. ${serviceRule}`
        ).toBe(true);
      });
    });
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
      `The kit's exported make… and create… functions are not the ones FACTORIES and NOT_YET_DECLARED list. A new export named that way is read as a factory, and a part each game supplies is a declaration, not a factory: see "${SECTIONS.kinds}" in ${guide}. If it makes nothing a game supplies, name it for what it returns. Take a factory that is gone out of its list in this file: a name leaves NOT_YET_DECLARED with the change that adds its declaration, moves every caller and deletes the factory.`
    ).toStrictEqual([...FACTORIES, ...NOT_YET_DECLARED].toSorted());
  });
});

describe("the guide", () => {
  const text = read(path.join(repoDir, guide));

  it("links only to files that exist", () => {
    const prose = text.replaceAll(/```[\s\S]*?```/gu, "");
    // Code is not prose: `cases[tag](event)` is no link. A code span is read whole, so one that
    // is a link's label is passed over and the link after it is read.
    const targets = [
      ...prose.matchAll(/`[^`\n]*`|\]\((?<target>[^)#\s]+)(?:#[^)]*)?\)/gu),
    ]
      .map((match) => match.groups?.target)
      .filter(
        (target): target is string =>
          target !== undefined && !/^[a-z]+:/u.test(target)
      );
    // The guide names the files to copy: finding few links means this stopped reading them.
    expect(
      targets.length,
      `${guide} names the files to copy as links, and this test found ${targets.length} of them: it has stopped reading the guide's links. Fix how it finds one.`
    ).toBeGreaterThan(10);
    // A second, cruder count, to hold the reading above: the guide is in docs/, so its link to
    // a file of the repository starts `](../`, and one after an even number of backticks on
    // its line is outside a code span. Fewer read than counted is a link passed over.
    const written = prose
      .split("\n")
      .flatMap((line) =>
        [...line.matchAll(/\]\(\.\.\//gu)].map(({ index }) =>
          line.slice(0, index)
        )
      )
      .filter((before) => before.split("`").length % 2 === 1).length;
    expect(
      targets.length,
      `${guide} has ${written} links that start \`](../\`, and this test read ${targets.length} links to files: it passes over some, and would not see one that is dead. Fix how it finds a link.`
    ).toBeGreaterThanOrEqual(written);
    expect(
      targets.filter(
        (target) =>
          !existsSync(path.resolve(repoDir, path.dirname(guide), target))
      ),
      `${guide} links to files that don't exist. Write each link below as the file's path from docs/, as the file is now named.`
    ).toStrictEqual([]);
  });

  it("has the sections this file's messages name", () => {
    const headings = new Set(
      [...text.matchAll(/^#{2,3} (?<heading>.+)$/gmu)].map(
        (match) => match.groups?.heading ?? ""
      )
    );
    expect(
      Object.values(SECTIONS).filter((section) => !headings.has(section)),
      `${guide} has no section with each heading below, and a message of this file sends its reader there. Keep the heading, or change SECTIONS in this file with it.`
    ).toStrictEqual([]);
  });

  it("is where AGENTS.md sends whoever adds a module", () => {
    expect(
      read(path.join(repoDir, "AGENTS.md")),
      `AGENTS.md doesn't name ${guide}. Its "Adding to the kit" section sends whoever adds a module to the guide: keep the link there.`
    ).toContain(guide);
  });
});
