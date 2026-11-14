// The API reference, generated from the kit's own source, so its text is the doc comments' and
// there is no second copy to keep right.
//
// The package's `exports` names each entry's public file. That file says what the entry exports:
// a namespace (`export * as Rng from "./rng"`) is a module with a page of its own, and every other
// export is the entry's own, on the entry's page (`Game.Event`, `Content`). A module's exports are
// read from its declarations as oxc writes them, as `tsc --declaration` would with
// `isolatedDeclarations`, which the kit is checked with: each export's signature, and its doc
// comment, written as Effect's are. They are grouped by the comment's `@category`, in the order
// of the doc-comments skill's list (.agents/skills/doc-comments/SKILL.md).
import { readFileSync } from "node:fs";
import path from "node:path";

import { isolatedDeclarationSync } from "rolldown/experimental";
import { parseSync } from "rolldown/utils";

/** The categories of an export's doc comment, in the order a page lists them. */
export const CATEGORIES = [
  "declarations",
  "models",
  "constructors",
  "guards",
  "getters",
  "mutations",
  "combinators",
  "math",
  "schemas",
  "services",
  "layers",
  "references",
  "errors",
  "utility types",
  "testing",
] as const;

/** An export's doc comment: its markdown, and the two tags the kit writes. */
export interface Doc {
  /** The comment's text without its tags: a summary, then "When to use", "Details", examples. */
  readonly body: string;
  readonly category: string | undefined;
  readonly since: string | undefined;
}

/** One name an entry or a module exports, with each declaration of it: a value, a type or both. */
export interface Export {
  readonly name: string;
  readonly parts: readonly {
    /** Its signature, as its declaration file has it: `const make: (seed: number) => Rng;`. */
    readonly signature: string;
    readonly doc: Doc | undefined;
  }[];
}

/** A namespace an entry exports: `Rng` of `arcadekit/core`, from `src/core/rng.ts`. */
export interface Module {
  /** Its name in the entry, such as `Rng`. */
  readonly name: string;
  /** Its source file, relative to the repository's root. */
  readonly file: string;
  /** Its module comment, without its tags. */
  readonly comment: string;
  readonly exports: readonly Export[];
}

/** An entry of the package, as its public file declares it. */
export interface Entry {
  /** Its import path after `arcadekit/`, such as `net/browser`. */
  readonly entry: string;
  /** Its public file, relative to the repository's root. */
  readonly file: string;
  /** The public file's module comment, without its tags. */
  readonly comment: string;
  /** Its namespaces, but those it re-exports from the entry above it. */
  readonly modules: readonly Module[];
  /** Its other exports, but those it re-exports from the entry above it. */
  readonly exports: readonly Export[];
  /** The entry above it whose exports it has too, as `arcadekit/game/browser` has `arcadekit/game`'s. */
  readonly extends: string | undefined;
}

/** The nodes of oxc's AST that this reads, by their ESTree fields. */
interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

interface Comment {
  readonly type: "Line" | "Block";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface Parsed {
  readonly body: readonly Node[];
  readonly comments: readonly Comment[];
}

const parse = (file: string, source: string, lang: "ts" | "dts"): Parsed => {
  const result = parseSync(file, source, { lang });
  if (result.errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${result.errors[0]?.message}`);
  }
  return {
    body: result.program.body as unknown as readonly Node[],
    comments: result.comments as unknown as readonly Comment[],
  };
};

const nameOf = (node: unknown): string | undefined => {
  const named = node as { name?: unknown; value?: unknown } | null | undefined;
  if (typeof named?.name === "string") {
    return named.name;
  }
  return typeof named?.value === "string" ? named.value : undefined;
};

const nodes = (value: unknown): readonly Node[] =>
  Array.isArray(value) ? (value as Node[]) : [];

/** The names a declaration declares: one, or a `const`'s each. */
const declaredNames = (declaration: Node): string[] => {
  if (declaration.type === "VariableDeclaration") {
    return nodes(declaration.declarations).flatMap((declarator) => {
      const name = nameOf(declarator.id);
      return name === undefined ? [] : [name];
    });
  }
  const name = nameOf(declaration.id);
  return name === undefined ? [] : [name];
};

/** A `/** … *\/` comment's text: each line without its ` * `. */
const commentText = (value: string): string =>
  value
    .replace(/^\*/u, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();

/** A doc comment's text without its tags, and the two tags the kit writes. */
export const parseDoc = (text: string): Doc => {
  const tag = (name: string) =>
    new RegExp(`^@${name}\\s+(?<value>.+)$`, "mu")
      .exec(text)
      ?.groups?.value?.trim();
  return {
    body: text
      .split("\n")
      .filter((line) => !line.startsWith("@"))
      .join("\n")
      .trim(),
    category: tag("category"),
    since: tag("since"),
  };
};

/** The doc comment right above a node, with nothing but white space between. */
const docAbove = (
  node: Node,
  comments: readonly Comment[],
  source: string
): Doc | undefined => {
  const comment = comments.findLast((candidate) => candidate.end <= node.start);
  if (
    comment === undefined ||
    comment.type !== "Block" ||
    !comment.value.startsWith("*") ||
    source.slice(comment.end, node.start).trim() !== ""
  ) {
    return undefined;
  }
  return parseDoc(commentText(comment.value));
};

/**
 * A file's module comment, without its tags: its first `/** … *\/` comment, or the `//` lines it
 * starts with.
 */
const moduleComment = (parsed: Parsed, source: string): string => {
  const [first] = parsed.comments;
  if (first === undefined || source.slice(0, first.start).trim() !== "") {
    return "";
  }
  if (first.type === "Block") {
    return parseDoc(commentText(first.value)).body;
  }
  const lines: string[] = [];
  let end = 0;
  for (const comment of parsed.comments) {
    if (
      comment.type !== "Line" ||
      source.slice(end, comment.start).trim() !== ""
    ) {
      break;
    }
    lines.push(comment.value.replace(/^ /u, ""));
    ({ end } = comment);
  }
  return lines.join("\n").trim();
};

/** Where an export of a file is declared: a namespace's file, or a declaration by its name. */
type Target =
  | { readonly kind: "namespace"; readonly file: string }
  | {
      readonly kind: "declaration";
      readonly file: string;
      readonly name: string;
    };

/** An export's identity, the same however many entries export it. */
const identity = (target: Target) =>
  target.kind === "namespace"
    ? `namespace:${target.file}`
    : `declaration:${target.file}#${target.name}`;

/**
 * Reads the kit's API: every entry's exports, and its modules'. Paths are relative to the
 * repository's root, and `entries` is the package's `exports` (`./net/browser` to its `source`).
 */
export const readApi = (
  repoRoot: string,
  packageDir: string,
  entries: Readonly<Record<string, string>>
): Entry[] => {
  const sources = new Map<string, string>();
  const read = (file: string) => {
    let source = sources.get(file);
    if (source === undefined) {
      source = readFileSync(path.join(repoRoot, file), "utf-8");
      sources.set(file, source);
    }
    return source;
  };
  /** The file a relative import names. A package's (`effect`) is no file of the kit's. */
  const resolve = (from: string, specifier: string) => {
    const base = path.posix.join(path.posix.dirname(from), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      try {
        read(candidate);
        return candidate;
      } catch {
        // Not this one.
      }
    }
    throw new Error(`${from} imports ${specifier}, which is no file`);
  };

  /** What a file exports, by name, and where each is declared. */
  const exportsCache = new Map<string, Map<string, Target>>();
  /** A name of another file, followed to where it is declared. */
  const follow = (from: string, name: string): Target =>
    exportsOf(from).get(name) ?? { kind: "declaration", file: from, name };
  const exportsOf = (file: string): Map<string, Target> => {
    const cached = exportsCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parse(file, read(file), "ts");
    const imports = new Map<string, { file: string; name: string }>();
    for (const node of parsed.body) {
      const importPath = String(nameOf(node.source));
      if (node.type !== "ImportDeclaration" || !importPath.startsWith(".")) {
        continue;
      }
      const from = resolve(file, importPath);
      for (const specifier of nodes(node.specifiers)) {
        const local = nameOf(specifier.local);
        const imported = nameOf(specifier.imported);
        if (local !== undefined && imported !== undefined) {
          imports.set(local, { file: from, name: imported });
        }
      }
    }
    const found = new Map<string, Target>();
    for (const node of parsed.body) {
      if (node.type === "ExportAllDeclaration") {
        const from = resolve(file, String(nameOf(node.source)));
        const exported = nameOf(node.exported);
        if (exported === undefined) {
          for (const [name, target] of exportsOf(from)) {
            found.set(name, target);
          }
        } else {
          found.set(exported, { kind: "namespace", file: from });
        }
      } else if (node.type === "ExportNamedDeclaration") {
        const declaration = node.declaration as Node | null;
        if (declaration) {
          for (const name of declaredNames(declaration)) {
            found.set(name, { kind: "declaration", file, name });
          }
          continue;
        }
        const from =
          node.source === null
            ? undefined
            : resolve(file, String(nameOf(node.source)));
        for (const specifier of nodes(node.specifiers)) {
          const local = String(nameOf(specifier.local));
          const exported = String(nameOf(specifier.exported));
          const imported = imports.get(local);
          let target: Target = { kind: "declaration", file, name: local };
          if (from !== undefined) {
            target = follow(from, local);
          } else if (imported !== undefined) {
            target = follow(imported.file, imported.name);
          }
          found.set(exported, target);
        }
      }
    }
    exportsCache.set(file, found);
    return found;
  };

  /** A file's declarations as its declaration file has them, by name. */
  const declarationsCache = new Map<
    string,
    Map<string, Export["parts"][number][]>
  >();
  const declarationsOf = (file: string) => {
    const cached = declarationsCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const emitted = isolatedDeclarationSync(file, read(file), {});
    if (emitted.errors.length > 0) {
      throw new Error(
        `${file} has no declaration file: ${emitted.errors[0]?.message}`
      );
    }
    const dts = emitted.code.replaceAll("\t", "  ");
    const parsed = parse(`${file}.d.ts`, dts, "dts");
    const imports = new Map<string, { file: string; name: string }>();
    const found = new Map<string, Export["parts"][number][]>();
    const add = (name: string, node: Node, declaration: Node) => {
      const signature = dts
        .slice(declaration.start, declaration.end)
        .replace(/^declare /u, "")
        .trim();
      const parts = found.get(name) ?? [];
      parts.push({ signature, doc: docAbove(node, parsed.comments, dts) });
      found.set(name, parts);
    };
    for (const node of parsed.body) {
      if (node.type === "ImportDeclaration") {
        const importPath = String(nameOf(node.source));
        if (!importPath.startsWith(".")) {
          continue;
        }
        const from = resolve(file, importPath);
        for (const specifier of nodes(node.specifiers)) {
          const local = nameOf(specifier.local);
          const imported = nameOf(specifier.imported);
          if (local !== undefined && imported !== undefined) {
            imports.set(local, { file: from, name: imported });
          }
        }
        continue;
      }
      const declaration =
        node.type === "ExportNamedDeclaration"
          ? (node.declaration as Node | null)
          : node;
      if (declaration && declaration.type !== "ExportNamedDeclaration") {
        for (const name of declaredNames(declaration)) {
          add(name, node, declaration);
        }
      }
    }
    // A const that is another file's declaration under a new name (`const Event: typeof
    // makeEvent`) shows that declaration's signature, under its own name and doc comment.
    for (const [name, parts] of found) {
      found.set(
        name,
        parts.map((part) => {
          const alias = /^const \w+: typeof (?<local>\w+);$/u.exec(
            part.signature
          )?.groups?.local;
          const imported = alias === undefined ? undefined : imports.get(alias);
          const original =
            imported === undefined
              ? undefined
              : declarationsOf(imported.file).get(imported.name)?.[0];
          return original === undefined
            ? part
            : {
                ...part,
                signature: original.signature.replace(
                  new RegExp(`^(const|function) ${imported?.name}\\b`, "u"),
                  `$1 ${name}`
                ),
              };
        })
      );
    }
    declarationsCache.set(file, found);
    return found;
  };

  const exportOf = (name: string, target: Target): Export => {
    if (target.kind === "namespace") {
      throw new Error(`${name} is a namespace`);
    }
    const parts = declarationsOf(target.file).get(target.name);
    if (parts === undefined) {
      throw new Error(`${target.file} declares no ${target.name}`);
    }
    return { name, parts };
  };

  const moduleOf = (name: string, file: string): Module => {
    const source = read(file);
    return {
      name,
      file,
      comment: moduleComment(parse(file, source, "ts"), source),
      exports: [...exportsOf(file)]
        .filter(([, target]) => target.kind === "declaration")
        .map(([exported, target]) => exportOf(exported, target))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    };
  };

  const publicFiles = new Map(
    Object.entries(entries).map(([entry, source]) => [
      entry,
      path.posix.normalize(path.posix.join(packageDir, source)),
    ])
  );
  return [...publicFiles].map(([entry, file]) => {
    // The entry above it, if it re-exports that entry's exports: `game` for `game/browser`.
    let parent = path.posix.dirname(entry);
    while (parent !== "." && !publicFiles.has(parent)) {
      parent = path.posix.dirname(parent);
    }
    const inherited = new Set(
      parent === "."
        ? []
        : [...exportsOf(publicFiles.get(parent) ?? "").values()].map(identity)
    );
    const own = [...exportsOf(file)].filter(
      ([, target]) => !inherited.has(identity(target))
    );
    const source = read(file);
    return {
      entry,
      file,
      comment: moduleComment(parse(file, source, "ts"), source),
      modules: own
        .filter(([, target]) => target.kind === "namespace")
        .map(([name, target]) => moduleOf(name, target.file))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
      exports: own
        .filter(([, target]) => target.kind === "declaration")
        .map(([name, target]) => exportOf(name, target))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
      extends: own.length < exportsOf(file).size ? parent : undefined,
    };
  });
};

const CATEGORY_RANK = new Map<string, number>(
  CATEGORIES.map((category, index) => [category, index])
);

/** Where a category is listed: its place in the skill's list, or after them all. */
const rankOf = (category: string) =>
  CATEGORY_RANK.get(category) ?? CATEGORIES.length;

/** A category's heading: `utility types` is "Utility types". */
const categoryTitle = (category: string) =>
  `${category.charAt(0).toUpperCase()}${category.slice(1)}`;

/** The category an export is listed under: its value's, or its first part's. */
const categoryOf = (item: Export) =>
  item.parts.find((part) => part.doc?.category !== undefined)?.doc?.category ??
  "other";

/**
 * Exports as markdown, under a heading for each category, then one for each export: its
 * signature, its doc comment, and the version that added it. `depth` is the level of the
 * category's heading, 2 for `##`.
 */
export const renderExports = (
  exports: readonly Export[],
  depth = 2
): string => {
  const groups = new Map<string, Export[]>();
  for (const item of exports) {
    const category = categoryOf(item);
    groups.set(category, [...(groups.get(category) ?? []), item]);
  }
  const heading = "#".repeat(depth);
  return [...groups]
    .toSorted(([a], [b]) => rankOf(a) - rankOf(b) || a.localeCompare(b))
    .map(([category, items]) =>
      [
        `${heading} ${categoryTitle(category)}`,
        ...items.map((item) =>
          [
            `${heading}# ${item.name}`,
            ...item.parts.flatMap((part) => [
              `\`\`\`ts\n${part.signature}\n\`\`\``,
              ...(part.doc?.body ? [part.doc.body] : []),
              ...(part.doc?.since ? [`Since ${part.doc.since}.`] : []),
            ]),
          ].join("\n\n")
        ),
      ].join("\n\n")
    )
    .join("\n\n");
};
