// The reference of each module, made from the packages' own doc comments, as Effect's API pages
// are made from Effect's: one page per module, with each thing it exports, its signature, its
// doc comment and a link to where it is written. There is no second copy of the text to keep
// right.
//
// It reads a package's built declarations, `dist/<Module>.d.ts`, which `pnpm build:packages`
// writes with the TypeScript compiler (tsdown): there every export has its signature written
// out, inferred or not, and its doc comment kept. A module's file names what it exports, which
// may be declared in a chunk the build shares between modules; this follows each name to its
// declaration, and the chunk's source map back to the line of the source that wrote it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "rolldown/utils";

/** The categories of the exports on a page, in the order the page lists them. */
export const KINDS = [
  "Values",
  "Classes",
  "Interfaces",
  "Types",
  "Namespaces",
] as const;
export type Kind = (typeof KINDS)[number];

/** One declaration of an exported name: a name can be both a value and a type. */
export interface Part {
  readonly kind: Kind;
  /** As the declarations have it, with no `declare`: `const clip: (name: string) => Clip;`. */
  readonly signature: string;
  /** Its doc comment as markdown, or `""`. */
  readonly doc: string;
  /** Its `@category`, if its doc comment gives one. */
  readonly category: string | undefined;
  /** Whether its doc comment says `@internal`: then no page lists it. */
  readonly internal: boolean;
  /** Where it is written: a file relative to the repository's root, and a line from 1. */
  readonly source: { readonly file: string; readonly line: number } | undefined;
}

export interface Export {
  readonly name: string;
  readonly parts: readonly Part[];
}

/** A module of a package, such as `Sound` of `arcadekit`, imported as `arcadekit/Sound`. */
export interface Module {
  readonly name: string;
  /** The package's name: `arcadekit`. */
  readonly packageName: string;
  /** Whether the package's own entry gives it too, as `import { Sound } from "arcadekit"`. */
  readonly inRoot: boolean;
  /** Its source file, relative to the repository's root. */
  readonly file: string;
  /** Its source file's first doc comment, as markdown, or `""`. */
  readonly comment: string;
  readonly exports: readonly Export[];
}

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

/** A declaration file, parsed, with what it imports, exports and declares. */
interface DeclarationFile {
  readonly file: string;
  readonly source: string;
  readonly comments: readonly Comment[];
  /** A local name to the file and the name it is imported from. */
  readonly imports: ReadonlyMap<string, { file: string; name: string }>;
  /** An exported name to the local name it exports. */
  readonly exports: ReadonlyMap<string, string>;
  /** A local name to its declarations. */
  readonly declarations: ReadonlyMap<string, readonly Node[]>;
  /** Each generated line's first mapping: the source and its line, from 0. */
  readonly lines: readonly SourcePosition[];
  /** The source files the map names, relative to the declaration file's folder. */
  readonly mapSources: readonly string[];
}

const nameOf = (node: unknown): string | undefined => {
  const named = node as { name?: unknown; value?: unknown } | null | undefined;
  if (typeof named?.name === "string") {
    return named.name;
  }
  return typeof named?.value === "string" ? named.value : undefined;
};

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Where a generated line comes from: a source's index in the map, and its line from 0. */
type SourcePosition =
  | { readonly source: number; readonly line: number }
  | undefined;

/** Where each generated line's first segment comes from, from a source map's `mappings`. */
export const sourceLines = (mappings: string): SourcePosition[] => {
  const lines: SourcePosition[] = [];
  let sourceLine = 0;
  let sourceIndex = 0;
  for (const line of mappings.split(";")) {
    let first: SourcePosition;
    for (const segment of line.split(",")) {
      if (segment === "") {
        continue;
      }
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      if (values.length >= 4) {
        sourceIndex += values[1] ?? 0;
        sourceLine += values[2] ?? 0;
        first ??= { source: sourceIndex, line: sourceLine };
      }
    }
    lines.push(first);
  }
  return lines;
};

const cache = new Map<string, DeclarationFile>();

const readDeclarations = (file: string): DeclarationFile => {
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const source = readFileSync(file, "utf-8");
  const result = parseSync(file, source, { lang: "dts" });
  if (result.errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${result.errors[0]?.message}`);
  }
  const body = result.program.body as unknown as readonly Node[];
  const imports = new Map<string, { file: string; name: string }>();
  const exports = new Map<string, string>();
  const declarations = new Map<string, Node[]>();
  const declare = (name: string | undefined, node: Node) => {
    if (name !== undefined) {
      declarations.set(name, [...(declarations.get(name) ?? []), node]);
    }
  };
  const declareNode = (node: Node) => {
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations as Node[]) {
        declare(nameOf(declarator.id), node);
      }
    } else if (node.type !== "TSModuleDeclaration" || !isExportList(node)) {
      declare(nameOf(node.id), node);
    }
  };
  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      const from = path.resolve(
        path.dirname(file),
        String((node.source as Node).value).replace(/\.js$/u, ".d.ts")
      );
      for (const specifier of (node.specifiers as Node[]) ?? []) {
        const local = nameOf(specifier.local);
        if (local !== undefined && from.endsWith(".d.ts")) {
          imports.set(local, {
            file: from,
            name: nameOf(specifier.imported) ?? "default",
          });
        }
      }
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const declaration = node.declaration as Node;
        declareNode(declaration);
        for (const name of namesOf(declaration)) {
          exports.set(name, name);
        }
      }
      for (const specifier of (node.specifiers as Node[]) ?? []) {
        const local = nameOf(specifier.local);
        const exported = nameOf(specifier.exported);
        if (local !== undefined && exported !== undefined) {
          exports.set(exported, local);
        }
      }
    } else {
      declareNode(node);
    }
  }
  let lines: SourcePosition[] = [];
  let mapSources: string[] = [];
  if (existsSync(`${file}.map`)) {
    const map = JSON.parse(readFileSync(`${file}.map`, "utf-8")) as {
      sources: string[];
      mappings: string;
    };
    lines = sourceLines(map.mappings);
    mapSources = map.sources;
  }
  const parsed: DeclarationFile = {
    file,
    source,
    comments: result.comments as unknown as readonly Comment[],
    imports,
    exports,
    declarations,
    lines,
    mapSources,
  };
  cache.set(file, parsed);
  return parsed;
};

/** The names a declaration declares: one, or a `const`'s each. */
const namesOf = (node: Node): string[] =>
  node.type === "VariableDeclaration"
    ? (node.declarations as Node[]).flatMap((d) => nameOf(d.id) ?? [])
    : [nameOf(node.id) ?? []].flat();

/** A namespace the build writes to list a module's exports, which declares nothing. */
const isExportList = (node: Node) => {
  const body = node.body as Node | null;
  const statements = (body?.body as Node[] | undefined) ?? [];
  return (
    statements.length > 0 &&
    statements.every(
      (statement) =>
        statement.type === "ExportNamedDeclaration" && !statement.declaration
    )
  );
};

const kindOf = (node: Node): Kind => {
  switch (node.type) {
    case "ClassDeclaration":
      return "Classes";
    case "TSInterfaceDeclaration":
      return "Interfaces";
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      return "Types";
    case "TSModuleDeclaration":
      return "Namespaces";
    default:
      return "Values";
  }
};

/** A `/** … *\/` comment's lines, each without its ` * `. */
const commentLines = (value: string): string[] =>
  value
    .replace(/^\*/u, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim()
    .split("\n");

/**
 * A doc comment as markdown. The comments are written for an editor's tooltip, with examples as
 * lines indented under a blank line; here each such run of lines is a `ts` block.
 */
export const docMarkdown = (
  value: string
): { body: string; category: string | undefined; internal: boolean } => {
  const lines = commentLines(value);
  let category: string | undefined;
  let internal = false;
  const params: string[] = [];
  const out: string[] = [];
  let code: string[] | undefined;
  const flush = () => {
    if (code === undefined) {
      return;
    }
    while (code.length > 0 && code.at(-1)?.trim() === "") {
      code.pop();
    }
    const indent = Math.min(
      ...code
        .filter((line) => line.trim() !== "")
        .map((line) => line.length - line.trimStart().length)
    );
    out.push("```ts", ...code.map((line) => line.slice(indent)), "```", "");
    code = undefined;
  };
  for (const [index, line] of lines.entries()) {
    const tag = /^@(?<name>\w+)\s*(?<rest>.*)$/u.exec(line);
    if (tag?.groups !== undefined) {
      flush();
      const rest = (tag.groups.rest ?? "").trim();
      if (tag.groups.name === "category") {
        category = rest;
      } else if (tag.groups.name === "internal") {
        internal = true;
      } else if (
        tag.groups.name === "param" ||
        tag.groups.name === "typeParam"
      ) {
        const param = /^(?<name>\S+)\s*(?<text>.*)$/u.exec(rest);
        params.push(
          `- \`${param?.groups?.name ?? rest}\`: ${param?.groups?.text ?? ""}`
        );
      }
      continue;
    }
    if (params.length > 0 && /^\s+\S/u.test(line) && code === undefined) {
      params[params.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const indented = /^ {2,}\S/u.test(line);
    if (code !== undefined) {
      if (indented || line.trim() === "") {
        code.push(line);
        continue;
      }
      flush();
    }
    if (indented && (index === 0 || lines[index - 1]?.trim() === "")) {
      code = [line];
      continue;
    }
    out.push(line);
  }
  flush();
  const body = out.join("\n").trim();
  return {
    body: [body, params.join("\n")].filter((part) => part !== "").join("\n\n"),
    category,
    internal,
  };
};

/** The doc comment right above a node, with nothing but white space between. */
const docAbove = (parsed: DeclarationFile, node: Node): string => {
  const comment = parsed.comments
    .filter((c) => c.type === "Block" && c.end <= node.start)
    .at(-1);
  if (
    comment === undefined ||
    !comment.value.startsWith("*") ||
    // A declaration that exports itself starts after its `export`.
    !/^\s*(?:export\s+)?$/u.test(parsed.source.slice(comment.end, node.start))
  ) {
    return "";
  }
  return comment.value;
};

const isNode = (value: unknown): value is Node =>
  typeof (value as Node | null)?.type === "string";

const childrenOf = (node: Node): Node[] =>
  Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(isNode);

/** The members of a class, an interface or an object type, or `undefined` for any other node. */
const membersOf = (node: Node): readonly Node[] | undefined => {
  switch (node.type) {
    case "ClassBody":
    case "TSInterfaceBody":
      return node.body as Node[];
    case "TSTypeLiteral":
      return node.members as Node[];
    default:
      return undefined;
  }
};

/**
 * The members a page leaves out: the private ones and those marked `@internal`, with any other
 * member of the same name, such as an internal getter's setter or an internal method's overloads.
 */
const hiddenOf = (parsed: DeclarationFile, members: readonly Node[]) => {
  const internal = new Set(
    members
      .filter((member) => docMarkdown(docAbove(parsed, member)).internal)
      .map((member) => nameOf(member.key))
  );
  return members.filter(
    (member) =>
      member.accessibility === "private" ||
      (member.key as Node | undefined)?.type === "PrivateIdentifier" ||
      internal.has(nameOf(member.key))
  );
};

/**
 * Where a hidden member is written: from its doc comment to its end, with the lines it is alone
 * on.
 */
const spanOf = (parsed: DeclarationFile, member: Node) => {
  const doc = docAbove(parsed, member);
  let start =
    doc === ""
      ? member.start
      : parsed.source.lastIndexOf(`/*${doc}`, member.start);
  let end = member.end;
  const lineStart = parsed.source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = parsed.source.indexOf("\n", end);
  if (
    /^\s*$/u.test(parsed.source.slice(lineStart, start)) &&
    /^\s*$/u.test(parsed.source.slice(end, lineEnd))
  ) {
    start = lineStart;
    end = lineEnd + 1;
  }
  return { start, end, text: "" };
};

/**
 * The superclass of a class that a factory makes, such as `Context.Service`: the build names it
 * `<Class>_base`, declared as a constant of the factory's type, which holds the class's members.
 */
const factoryBaseOf = (parsed: DeclarationFile, node: Node) => {
  const superClass = node.superClass as Node | null | undefined;
  const base = parsed.declarations
    .get(nameOf(superClass) ?? "")
    ?.find((declaration) => declaration.type === "VariableDeclaration");
  const type = (
    ((base?.declarations as Node[] | undefined)?.[0]?.id as Node | undefined)
      ?.typeAnnotation as Node | undefined
  )?.typeAnnotation as Node | undefined;
  return superClass && type?.type === "TSTypeReference"
    ? { start: superClass.start, end: superClass.end, type }
    : undefined;
};

/** A node's text without its hidden members, and with a factory's type for its `_base`. */
const textOf = (parsed: DeclarationFile, node: Node): string => {
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (current: Node) => {
    const members = membersOf(current);
    const hidden = members === undefined ? [] : hiddenOf(parsed, members);
    edits.push(...hidden.map((member) => spanOf(parsed, member)));
    if (current.type === "ClassDeclaration") {
      const base = factoryBaseOf(parsed, current);
      if (base !== undefined) {
        edits.push({ ...base, text: textOf(parsed, base.type) });
      }
    }
    for (const child of childrenOf(current)) {
      if (!hidden.includes(child) && child !== current.superClass) {
        visit(child);
      }
    }
  };
  visit(node);
  let text = "";
  let at = node.start;
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    text += parsed.source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return text + parsed.source.slice(at, node.end);
};

/**
 * A declaration as a page shows it: without `declare`, private or `@internal` members, or the
 * build's `$1` on names, and with the members a factory gives a class.
 */
const signatureOf = (parsed: DeclarationFile, node: Node) =>
  textOf(parsed, node)
    .replace(/^declare /u, "")
    .replaceAll(/\b([A-Za-z_]\w*)\$\d+\b/gu, "$1");

const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length - 1;

/** Follows an exported name to the file and the local name that declare it. */
const resolve = (
  file: string,
  exported: string,
  seen = 0
): { parsed: DeclarationFile; local: string } | undefined => {
  const parsed = readDeclarations(file);
  const local = parsed.exports.get(exported);
  if (local === undefined || seen > 10) {
    return undefined;
  }
  return follow(parsed, local, seen);
};

const follow = (
  parsed: DeclarationFile,
  local: string,
  seen: number
): { parsed: DeclarationFile; local: string } | undefined => {
  if (parsed.declarations.has(local)) {
    return { parsed, local };
  }
  const imported = parsed.imports.get(local);
  return imported === undefined
    ? undefined
    : resolve(imported.file, imported.name, seen + 1);
};

/**
 * A module of a package: what its built declarations export, each with its declarations. `root`
 * is the repository's root and `folder` the package's, such as `packages/arcadekit`.
 */
export const readModule = (
  root: string,
  folder: string,
  packageName: string,
  name: string,
  sourceFile: string
): Module => {
  const entry = path.join(root, folder, "dist", `${name}.d.ts`);
  if (!existsSync(entry)) {
    throw new Error(
      `${path.relative(root, entry)} is missing: the reference is read from the packages' built declarations. Run \`pnpm build:packages\` first.`
    );
  }
  const parsed = readDeclarations(entry);
  // An entry that gives the exports of files of its own lists them in the order it imports
  // those files, and each file's in the order they are written.
  const files = [
    entry,
    ...new Set([...parsed.imports.values()].map((one) => one.file)),
  ];
  const exports: { readonly item: Export; readonly file: number }[] = [];
  for (const exported of parsed.exports.keys()) {
    const found = resolve(entry, exported);
    if (found === undefined) {
      continue;
    }
    const nodes = found.parsed.declarations.get(found.local) ?? [];
    const parts = nodes.map((node): Part => {
      const { body, category, internal } = docMarkdown(
        docAbove(found.parsed, node)
      );
      const position =
        found.parsed.lines[lineOf(found.parsed.source, node.start)];
      const mapped =
        position === undefined
          ? undefined
          : found.parsed.mapSources[position.source];
      const source =
        position === undefined || mapped === undefined
          ? undefined
          : {
              file: path
                .relative(
                  root,
                  path.resolve(path.dirname(found.parsed.file), mapped)
                )
                .split(path.sep)
                .join("/"),
              line: position.line + 1,
            };
      return {
        kind: kindOf(node),
        signature: signatureOf(found.parsed, node),
        doc: body,
        category,
        internal,
        source,
      };
    });
    if (parts.length > 0 && !parts.some((part) => part.internal)) {
      exports.push({
        item: { name: exported, parts },
        file: files.indexOf(found.parsed.file),
      });
    }
  }
  const sourceText = readFileSync(path.join(root, sourceFile), "utf-8");
  const first = /^\s*\/\*\*(?<value>[\s\S]*?)\*\//u.exec(sourceText);
  const comment =
    first?.groups === undefined
      ? ""
      : docMarkdown(`*${first.groups.value}`).body;
  const index = path.join(root, folder, "src", "index.ts");
  const inRoot =
    existsSync(index) &&
    readFileSync(index, "utf-8").includes(`export * as ${name} from`);
  return {
    name,
    packageName,
    inRoot,
    file: sourceFile,
    comment,
    exports: exports
      .toSorted(
        (a, b) =>
          a.file - b.file ||
          (a.item.parts[0]?.source?.line ?? 0) -
            (b.item.parts[0]?.source?.line ?? 0)
      )
      .map(({ item }) => item),
  };
};

/** The heading an export is listed under: its `@category`, or the kind of its first declaration. */
export const categoryOf = (item: Export): string =>
  item.parts.find((part) => part.category !== undefined)?.category ??
  item.parts[0]?.kind ??
  "Values";

/**
 * The categories the packages' doc comments use, in the order a page lists them: what a game
 * makes and is made of first, then what runs it, then what it rarely needs.
 */
export const CATEGORIES = [
  "Constructors",
  "Models",
  "Components",
  "Fields",
  "Actions",
  "Events",
  "Views",
  "Systems",
  "Combinators",
  "Conditions",
  "Plugins",
  "Services",
  "Layers",
  "Running",
  "Hosting",
  "Guards",
  "Codecs",
  "Schemas",
  "Migrations",
  "Constants",
  "Utilities",
  "Errors",
  "Options",
  "Testing",
  "Type-level",
] as const;

/**
 * Where a category is listed: those of `CATEGORIES` in its order, then any other, then the
 * kinds an export with no `@category` falls under.
 */
const rank = (category: string) => {
  const known = (CATEGORIES as readonly string[]).indexOf(category);
  if (known !== -1) return known;
  const kind = (KINDS as readonly string[]).indexOf(category);
  return kind === -1 ? CATEGORIES.length : CATEGORIES.length + 1 + kind;
};

/**
 * An export: its doc comments, then its declarations in one block, as overloads are written,
 * then where the first is written.
 */
const renderExport = (item: Export, repoUrl: string, branch: string) => {
  const docs = [...new Set(item.parts.map((part) => part.doc))].filter(
    (doc) => doc !== ""
  );
  const source = item.parts.find((part) => part.source !== undefined)?.source;
  return [
    `### ${item.name}`,
    ...docs,
    `\`\`\`ts\n${item.parts.map((part) => part.signature).join("\n")}\n\`\`\``,
    ...(source === undefined
      ? []
      : [`[Source](${repoUrl}/blob/${branch}/${source.file}#L${source.line})`]),
  ].join("\n\n");
};

/**
 * A module's page: its comment, then its exports under a heading for each category, each with
 * its doc comment, its signature and where it is written.
 */
export const renderModule = (
  module: Module,
  repoUrl: string,
  branch: string
): string => {
  const groups = new Map<string, Export[]>();
  for (const item of module.exports) {
    const category = categoryOf(item);
    groups.set(category, [...(groups.get(category) ?? []), item]);
  }
  const sections = [...groups]
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([category, items]) =>
      [
        `## ${category}`,
        ...items.map((item) => renderExport(item, repoUrl, branch)),
      ].join("\n\n")
    );
  return [
    ...(module.comment === "" ? [] : [module.comment]),
    [
      "```ts",
      ...(module.inRoot
        ? [`import { ${module.name} } from "${module.packageName}"`, "// or"]
        : []),
      `import * as ${module.name} from "${module.packageName}/${module.name}"`,
      "```",
    ].join("\n"),
    ...sections,
  ].join("\n\n");
};
