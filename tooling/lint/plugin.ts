// The Oxlint plugin `arcadekit`: the rules of what a file of a published package may import,
// contain or export. oxlint.config.ts turns them on for packages/*/src, and no-outside-state for
// the examples and benchmarks too.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseSync, visitorKeys } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  BindingIdentifier,
  ClassElement,
  ExportNamedDeclaration,
  ExportSpecifier,
  Function,
  Node,
  ParamPattern,
  Program,
} from "oxc-parser";
import type { RuleTester } from "oxlint/plugins-dev";

import { mayReach, packages } from "./entries.ts";
import type { EntryRule, PackageRules } from "./entries.ts";

type Rule = Parameters<RuleTester["run"]>[1];
type Visitor = ReturnType<NonNullable<Rule["create"]>>;
/** The node a visitor of `K` is given. */
type NodeOf<K extends string> = Parameters<NonNullable<Visitor[K]>>[0];
type ImportSource = NodeOf<"ImportExpression">["source"];
type Callee = NodeOf<"CallExpression">["callee"];

/** The package a file is a source of, and its path in that package. */
const sourceOf = (
  filename: string
): { readonly rules: PackageRules; readonly file: string } | undefined => {
  const match = /(?:^|\/)packages\/([^/]+)\/(src\/.+)$/u.exec(
    filename.replaceAll("\\", "/")
  );
  const rules = packages.find((one) => one.dir === match?.[1]);
  return match === null || rules === undefined
    ? undefined
    : { rules, file: match[2]! };
};

/** Where a relative specifier leads, from a file: "src/ecs/world.ts" and "../App" give "src/App". */
const resolve = (file: string, specifier: string): string => {
  const parts = file.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
};

const entryImports: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A source file imports only what the entry it is behind may import (tooling/lint/entries.ts).",
    },
  },
  create: (context) => {
    const source = sourceOf(context.filename);
    if (source === undefined) {
      return {};
    }
    const { rules, file } = source;
    const own: EntryRule = rules.ofFile(file);
    const check = (node: ImportSource): void => {
      if (node.type !== "Literal") {
        return;
      }
      const specifier = node.value;
      if (typeof specifier !== "string") {
        return;
      }
      if (specifier.startsWith(".")) {
        const target = resolve(file, specifier);
        if (!mayReach(own, rules.ofFile(target))) {
          context.report({
            node,
            message: `${file} must not import ${specifier} (${target}): ${own.says}.`,
          });
        }
      } else if (!own.may(specifier)) {
        context.report({
          node,
          message: `${file} must not import "${specifier}": ${own.says}.`,
        });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source !== null) {
          check(node.source);
        }
      },
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

/** What a page has and Node does not. */
const pageNames = new Set([
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "createImageBitmap",
  "AudioContext",
  "OfflineAudioContext",
  "navigator",
  "document",
  "window",
  "addEventListener",
]);

const noPage: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A source file behind an entry that runs outside a page names nothing only a page has.",
    },
  },
  create: (context) => {
    const source = sourceOf(context.filename);
    if (source === undefined || source.rules.ofFile(source.file).page) {
      return {};
    }
    const { file } = source;
    // Where one was found: `{ navigator }` is a key and a variable at once.
    const found = new Set<number>();
    return {
      // Every name in the file: a variable, a property, a key, a type.
      Identifier: (node) => {
        if (pageNames.has(node.name) && !found.has(node.start)) {
          found.add(node.start);
          context.report({
            node,
            message: `${file} must not name ${node.name}, which only a page has: it is behind an entry that runs in Node too. What only a page can use goes in src/browser/.`,
          });
        }
      },
    };
  },
};

/**
 * What compiles its argument: called, and constructed. What `each` hands out was once classes
 * made this way: see `makeAccessor`.
 */
const compilesCalled = new Set(["eval", "Function"]);
const compilesConstructed = new Set([
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]);

/** The name a callee is called by: `eval` in `eval(text)` and in `globalThis.eval(text)`. */
const nameOf = (callee: Callee): string | undefined => {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
};

const noCodeFromText: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No source makes code from text, which a strict Content Security Policy forbids.",
    },
  },
  create: (context) => {
    const report = (
      node: NodeOf<"CallExpression"> | NodeOf<"NewExpression">,
      name: string
    ): void =>
      context.report({
        node,
        message: `${name} makes code from text, which a strict Content Security Policy forbids, so a game that sets one could not run. Write the code out, or build it from closures.`,
      });
    return {
      CallExpression: (node) => {
        const name = nameOf(node.callee);
        if (name !== undefined && compilesCalled.has(name)) {
          report(node, name);
        }
      },
      NewExpression: (node) => {
        const name = nameOf(node.callee);
        if (name !== undefined && compilesConstructed.has(name)) {
          report(node, `new ${name}`);
        }
      },
    };
  },
};

/** A node as far as finding what encloses it needs. */
interface Enclosing {
  readonly type: string;
  readonly parent?: Enclosing | null;
}

/** The kinds of node whose body runs each time it is called. */
const functionKinds = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const topLevelClasses: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "A class is declared at the top level of its module, not inside a function.",
    },
  },
  create: (context) => {
    const check = (node: NodeOf<"ClassDeclaration">): void => {
      let up: Enclosing | null | undefined = node.parent;
      for (; up !== null && up !== undefined; up = up.parent) {
        if (functionKinds.has(up.type)) {
          context.report({
            node,
            message: `${node.id ? `The class ${node.id.name}` : "This class"} is declared inside a function, which makes a new class each time it runs and hides it from the rest of the module. Declare it at the top level, and pass what it used from the function to its constructor.`,
          });
          return;
        }
      }
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};

type Context = Parameters<NonNullable<Rule["create"]>>[0];
type Scope = Context["sourceCode"]["scopeManager"]["scopes"][number];
type Reference = Scope["through"][number];
type TickCode = NodeOf<"CallExpression">["arguments"][number];

/** The calls whose last argument is code of the tick: `System.tick("Move", function* () { ... })`. */
const tickCallees = new Set([
  "System.tick",
  "State.onEnter",
  "State.onExit",
  "Action.handler",
]);

/** The methods that change their object: an array's, a map's, a set's. */
const changesItsObject = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

/**
 * The code of the tick a call is given: its last argument, or the `setup` of `Plugin.make`'s
 * options.
 */
const tickCodeOf = (node: NodeOf<"CallExpression">): TickCode | undefined => {
  const { callee } = node;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  ) {
    return undefined;
  }
  const name = `${callee.object.name}.${callee.property.name}`;
  if (tickCallees.has(name)) {
    return node.arguments.at(-1);
  }
  const options = node.arguments[1];
  if (name !== "Plugin.make" || options?.type !== "ObjectExpression") {
    return undefined;
  }
  for (const property of options.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "setup"
    ) {
      return property.value;
    }
  }
  return undefined;
};

const within = (
  node: { readonly start: number; readonly end: number },
  body: TickCode
): boolean => node.start >= body.start && node.end <= body.end;

/**
 * Whether the code of the tick changes what a name it did not declare names: `n++`,
 * `list.push(x)`, `delete cache.key`.
 */
const changes = (reference: Reference): boolean => {
  if (reference.resolved?.defs.some((def) => def.type === "ImportBinding")) {
    return false;
  }
  if (reference.isWrite()) {
    return !reference.init;
  }
  let top: Reference["identifier"] | NodeOf<"MemberExpression"> =
    reference.identifier;
  while (top.parent.type === "MemberExpression" && top.parent.object === top) {
    top = top.parent;
  }
  const { parent } = top;
  switch (parent.type) {
    case "AssignmentExpression":
      return parent.left === top;
    case "UpdateExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "CallExpression":
      return (
        parent.callee === top &&
        top.type === "MemberExpression" &&
        !top.computed &&
        top.property.type === "Identifier" &&
        changesItsObject.has(top.property.name)
      );
    default:
      return false;
  }
};

/**
 * Code of the tick keeps what it changes in the world. It can't see what code of the tick is
 * given by name rather than written in the call, nor a function declared elsewhere that the
 * code calls. It leaves imports alone, since `HashMap.set(map, key, value)` changes nothing,
 * and so misses a `Map` a module exports. The repository's tests record what systems did in arrays outside them, so
 * oxlint.config.ts leaves test/ out.
 */
const noOutsideState: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The code of the tick (a system of the tick, a state's hook, an action's handler, a plugin's setup) changes nothing declared outside it.",
    },
  },
  create: (context) => ({
    CallExpression: (node) => {
      const body = tickCodeOf(node);
      if (body === undefined) {
        return;
      }
      for (const scope of context.sourceCode.scopeManager.scopes) {
        if (
          scope.upper === null ||
          !within(scope.block, body) ||
          within(scope.upper.block, body)
        ) {
          continue;
        }
        for (const reference of scope.through) {
          if (changes(reference)) {
            context.report({
              node: reference.identifier,
              message: `This changes ${reference.identifier.name}, which is declared outside the code of the tick it is in: a refused action doesn't undo it, and a save, a rewind or a replay doesn't hold it. Keep the state in the world, as a component or a singleton, or, for a cache rebuilt from the world, in a Field.transient field of a singleton.`,
            });
          }
        }
      }
    },
  }),
};

/** The types of an id: what only src/ecs/component.ts converts a number to, or an id from. */
const idTypes = new Set(["Entity", "Spawned", "EntityColumn"]);

/** Whether a type names an id's type anywhere in it: `Entity`, `Entity.Ref`, `Entity[]`, `Codec<Entity, number>`. */
const namesAnId = (node: unknown): boolean => {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const { type } = node as { readonly type?: unknown };
  if (type === "TSTypeReference") {
    let name = (node as NodeOf<"TSTypeReference">).typeName;
    while (name.type === "TSQualifiedName") {
      name = name.left;
    }
    if (name.type === "Identifier" && idTypes.has(name.name)) {
      return true;
    }
  }
  return Object.entries(node).some(
    ([key, child]) =>
      key !== "parent" &&
      (Array.isArray(child) ? child.some(namesAnId) : namesAnId(child))
  );
};

const idCasts: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Only src/ecs/component.ts asserts that a value is an id, where an id and its number are converted.",
    },
  },
  create: (context) => {
    const check = (
      node: NodeOf<"TSAsExpression"> | NodeOf<"TSTypeAssertion">
    ): void => {
      if (namesAnId(node.typeAnnotation)) {
        context.report({
          node,
          message:
            "This asserts that a value is an entity's id, which the compiler then takes on trust: a number that is no id, or an id cut to 32 bits, would pass. A game keeps an id in a Field.entity or a relation, turns a stored one back with world.live, and reads its parts with entityIndex and entityGeneration. The storage core converts with idOf and entityOf from src/ecs/component.ts, the one place that may.",
        });
      }
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

/** An export whose doc comment says `@internal`, and whether a source of the packages uses it. */
interface Internal {
  readonly file: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** The statement that exports it, inside which it does not use itself. */
  readonly statement: Node;
  used: boolean;
}

/** A source file of a package, as no-internal-in-entries reads it. */
interface Source {
  readonly file: string;
  /** Its path in its package, such as "src/Action.ts". */
  readonly path: string;
  /** The entry the file is, such as "arcadekit/Action", if it is one. */
  readonly entry: string | undefined;
  readonly program: Program;
  /** What a name imported by name stands for: the file it is from, and its name there. */
  readonly imports: Map<
    string,
    { readonly file: string; readonly name: string }
  >;
  /** The file a namespace imported whole is. */
  readonly namespaces: Map<string, string>;
  readonly internals: Map<string, Internal[]>;
  /** The exports of a file outside internal/ that are not @internal: what a game sees. */
  readonly publics: ExportNamedDeclaration[];
  /** Whether the doc comment of a statement or a member says `@internal`. */
  readonly isInternalDoc: (node: Node) => boolean;
}

interface Problem {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

/** A package under packages/: its name, its folder, and its entries, by their source file. */
interface Workspace {
  readonly name: string;
  readonly dir: string;
  readonly entries: ReadonlyMap<string, string>;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/** Visits a node and every node under it, with the node it is under and the key it is at. */
const walk = (
  node: Node,
  visit: (node: Node, parent: Node | undefined, key: string) => void,
  parent?: Node,
  key = ""
): void => {
  visit(node, parent, key);
  for (const childKey of visitorKeys[node.type] ?? []) {
    const value: unknown = Reflect.get(node, childKey);
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) {
        walk(child, visit, node, childKey);
      }
    }
  }
};

/** Where an identifier names what is declared or exported, rather than refers to something. */
const namings = new Set([
  "ImportSpecifier.imported",
  "ImportSpecifier.local",
  "ImportDefaultSpecifier.local",
  "ImportNamespaceSpecifier.local",
  "ExportSpecifier.local",
  "ExportSpecifier.exported",
  "VariableDeclarator.id",
  "FunctionDeclaration.id",
  "FunctionExpression.id",
  "TSDeclareFunction.id",
  "ClassDeclaration.id",
  "ClassExpression.id",
  "TSInterfaceDeclaration.id",
  "TSTypeAliasDeclaration.id",
  "TSEnumDeclaration.id",
  "TSEnumMember.id",
  "TSModuleDeclaration.id",
  "TSTypeParameter.name",
  "FunctionDeclaration.params",
  "FunctionExpression.params",
  "ArrowFunctionExpression.params",
  "TSDeclareFunction.params",
  "TSEmptyBodyFunctionExpression.params",
  "TSMethodSignature.params",
  "TSCallSignatureDeclaration.params",
  "TSConstructSignatureDeclaration.params",
  "TSFunctionType.params",
  "TSConstructorType.params",
  "TSIndexSignature.parameters",
  "TSParameterProperty.parameter",
  "TSQualifiedName.right",
]);

/** Where an identifier is a key, unless it is computed. */
const keys = new Set([
  "MemberExpression.property",
  "Property.key",
  "PropertyDefinition.key",
  "AccessorProperty.key",
  "MethodDefinition.key",
  "TSPropertySignature.key",
  "TSMethodSignature.key",
]);

const refers = (parent: Node | undefined, key: string): boolean => {
  if (parent === undefined) {
    return true;
  }
  const at = `${parent.type}.${key}`;
  return (
    !namings.has(at) &&
    (!keys.has(at) || ("computed" in parent && parent.computed))
  );
};

const isInternalPath = (file: string): boolean =>
  /\/src\/(?:.*\/)?internal\//u.test(file);

const resolveFile = (base: string): string | undefined =>
  [base, `${base}.ts`, join(base, "index.ts")].find(
    (candidate) =>
      candidate.endsWith(".ts") &&
      !candidate.endsWith(".d.ts") &&
      existsSync(candidate)
  );

/** The source file a specifier leads to: relative to a file, or a subpath of a package. */
const resolveModule = (
  specifier: string,
  from: string,
  workspaces: readonly Workspace[]
): string | undefined => {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveFile(join(dirname(from), specifier));
  }
  const owner = workspaces.find(
    ({ name }) => specifier === name || specifier.startsWith(`${name}/`)
  );
  return (
    owner &&
    resolveFile(
      join(owner.dir, "src", specifier.slice(owner.name.length + 1) || "index")
    )
  );
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** A package's entries, from the `source` of each subpath of its `exports`. */
const workspaceOf = (dir: string): Workspace | undefined => {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  const json: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const name = field(json, "name");
  if (typeof name !== "string") {
    return undefined;
  }
  const entries = new Map<string, string>();
  for (const [subpath, conditions] of Object.entries(
    field(json, "exports") ?? {}
  )) {
    const source = field(conditions, "source");
    if (typeof source === "string") {
      entries.set(join(dir, source), `${name}${subpath.slice(1)}`);
    }
  }
  return { name, dir, entries };
};

const sourceFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
        .map((file) => join(dir, file))
    : [];

const nameOfSpecifier = (node: ExportSpecifier["local"]): string =>
  node.type === "Identifier" ? node.name : node.value;

/** The names a statement exports, by the identifiers that declare them. */
const declaredBy = (statement: ExportNamedDeclaration): BindingIdentifier[] => {
  const { declaration } = statement;
  if (declaration === null) {
    return [];
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((one) =>
      one.id.type === "Identifier" ? [one.id] : []
    );
  }
  return declaration.id?.type === "Identifier" ? [declaration.id] : [];
};

const readSource = (
  file: string,
  workspace: Workspace,
  workspaces: readonly Workspace[]
): Source => {
  const text = readFileSync(file, "utf8");
  const { program, comments } = parseSync(file, text);
  const isInternalDoc = (node: Node): boolean => {
    const doc = comments.findLast((comment) => comment.end <= node.start);
    return (
      doc?.type === "Block" &&
      doc.value.startsWith("*") &&
      /@internal\b/u.test(doc.value) &&
      text.slice(doc.end, node.start).trim() === ""
    );
  };
  const source: Source = {
    file,
    path: relative(workspace.dir, file),
    entry: workspace.entries.get(file),
    program,
    imports: new Map(),
    namespaces: new Map(),
    internals: new Map(),
    publics: [],
    isInternalDoc,
  };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      const from = resolveModule(statement.source.value, file, workspaces);
      for (const specifier of statement.specifiers) {
        if (from === undefined) {
          break;
        }
        if (specifier.type === "ImportNamespaceSpecifier") {
          source.namespaces.set(specifier.local.name, from);
        } else {
          source.imports.set(specifier.local.name, {
            file: from,
            name:
              specifier.type === "ImportDefaultSpecifier"
                ? "default"
                : nameOfSpecifier(specifier.imported),
          });
        }
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      if (!isInternalDoc(statement)) {
        if (!isInternalPath(file)) {
          source.publics.push(statement);
        }
        continue;
      }
      for (const name of declaredBy(statement)) {
        const all = source.internals.get(name.name) ?? [];
        all.push({
          file,
          name: name.name,
          start: name.start,
          end: name.end,
          statement,
          used: false,
        });
        source.internals.set(name.name, all);
      }
    }
  }
  return source;
};

/** The @internal exports of that name in a file. */
const internalsOf = (
  sources: ReadonlyMap<string, Source>,
  file: string | undefined,
  name: string
): readonly Internal[] =>
  (file === undefined ? undefined : sources.get(file)?.internals.get(name)) ??
  [];

/** The @internal exports an identifier of a file refers to: its own, or one it imported. */
const referredBy = (
  sources: ReadonlyMap<string, Source>,
  source: Source,
  name: string
): readonly Internal[] => {
  const imported = source.imports.get(name);
  return [
    ...(source.internals.get(name) ?? []),
    ...internalsOf(sources, imported?.file, imported?.name ?? ""),
  ];
};

/** The @internal exports a node refers to, with the identifier that names each. */
const referencesIn = (
  sources: ReadonlyMap<string, Source>,
  source: Source,
  node: Node,
  found: (internals: readonly Internal[], name: Node) => void
): void =>
  walk(node, (current, parent, key) => {
    if (
      current.type === "MemberExpression" &&
      !current.computed &&
      current.object.type === "Identifier" &&
      current.property.type === "Identifier"
    ) {
      found(
        internalsOf(
          sources,
          source.namespaces.get(current.object.name),
          current.property.name
        ),
        current.property
      );
    } else if (
      current.type === "TSQualifiedName" &&
      current.left.type === "Identifier"
    ) {
      found(
        internalsOf(
          sources,
          source.namespaces.get(current.left.name),
          current.right.name
        ),
        current.right
      );
    } else if (current.type === "Identifier" && refers(parent, key)) {
      found(referredBy(sources, source, current.name), current);
    }
  });

const typeOfParam = (param: ParamPattern): Node | null | undefined => {
  if (param.type === "TSParameterProperty") {
    return param.parameter.typeAnnotation;
  }
  return param.type === "AssignmentPattern"
    ? param.left.typeAnnotation
    : param.typeAnnotation;
};

/** The types a function shows: its type parameters, its parameters' types, what it returns. */
const signatureOf = (fn: Function | ArrowFunctionExpression): Node[] =>
  [fn.typeParameters, ...fn.params.map(typeOfParam), fn.returnType].filter(
    (node) => node !== null && node !== undefined
  );

/** The types a class member shows, unless it is @internal, private or protected. */
const memberSignature = (source: Source, member: ClassElement): Node[] => {
  if (
    source.isInternalDoc(member) ||
    ("accessibility" in member &&
      (member.accessibility === "private" ||
        member.accessibility === "protected"))
  ) {
    return [];
  }
  switch (member.type) {
    case "MethodDefinition":
    case "TSAbstractMethodDefinition":
      return signatureOf(member.value);
    case "PropertyDefinition":
    case "AccessorProperty":
    case "TSAbstractPropertyDefinition":
    case "TSAbstractAccessorProperty":
      return member.typeAnnotation ? [member.typeAnnotation] : [];
    case "TSIndexSignature":
      return [member];
    case "StaticBlock":
      return [];
    default: {
      const unhandled: never = member;
      return unhandled;
    }
  }
};

/** The types an export shows a game, in its signature. */
const publicTypes = (
  source: Source,
  statement: ExportNamedDeclaration
): Node[] => {
  const { declaration } = statement;
  switch (declaration?.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return signatureOf(declaration);
    case "VariableDeclaration":
      return declaration.declarations.flatMap((one) => [
        ...(one.id.typeAnnotation ? [one.id.typeAnnotation] : []),
        ...(one.init?.type === "ArrowFunctionExpression" ||
        one.init?.type === "FunctionExpression"
          ? signatureOf(one.init)
          : []),
      ]);
    case "TSTypeAliasDeclaration":
      return [declaration];
    case "TSInterfaceDeclaration":
      return [
        ...(declaration.typeParameters ? [declaration.typeParameters] : []),
        ...declaration.extends,
        ...declaration.body.body.filter(
          (member) => !source.isInternalDoc(member)
        ),
      ];
    case "ClassDeclaration":
      return [
        declaration.typeParameters,
        declaration.superClass,
        declaration.superTypeArguments,
        ...(declaration.implements ?? []),
        ...declaration.body.body.flatMap((member) =>
          memberSignature(source, member)
        ),
      ].filter((node) => node !== null && node !== undefined);
    default:
      return [];
  }
};

/** The problems of each file of the packages under `cwd`, found once per run. */
const analyses = new Map<string, ReadonlyMap<string, readonly Problem[]>>();

const analyze = (cwd: string): ReadonlyMap<string, readonly Problem[]> => {
  const known = analyses.get(cwd);
  if (known !== undefined) {
    return known;
  }
  const root = join(cwd, "packages");
  const workspaces = (existsSync(root) ? readdirSync(root) : []).flatMap(
    (folder) => workspaceOf(join(root, folder)) ?? []
  );
  const sources = new Map<string, Source>();
  for (const workspace of workspaces) {
    for (const file of sourceFiles(join(workspace.dir, "src"))) {
      sources.set(file, readSource(file, workspace, workspaces));
    }
  }
  const reexported = (
    source: Source,
    statement: ExportNamedDeclaration,
    specifier: ExportSpecifier
  ): readonly Internal[] => {
    const name = nameOfSpecifier(specifier.local);
    return statement.source === null
      ? referredBy(sources, source, name)
      : internalsOf(
          sources,
          resolveModule(statement.source.value, source.file, workspaces),
          name
        );
  };

  for (const source of sources.values()) {
    const use = (internals: readonly Internal[], name: Node): void => {
      for (const internal of internals) {
        if (
          internal.file !== source.file ||
          name.start < internal.statement.start ||
          name.end > internal.statement.end
        ) {
          internal.used = true;
        }
      }
    };
    walk(source.program, (node) => {
      if (node.type === "ExportNamedDeclaration") {
        for (const specifier of node.specifiers) {
          use(reexported(source, node, specifier), specifier);
        }
      } else if (
        node.type === "ImportExpression" &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const file = resolveModule(node.source.value, source.file, workspaces);
        for (const internals of (file === undefined
          ? undefined
          : sources.get(file)
        )?.internals.values() ?? []) {
          use(internals, node);
        }
      }
    });
    referencesIn(sources, source, source.program, use);
  }

  const problems = new Map<string, Problem[]>();
  const report = (file: string, problem: Problem): void => {
    problems.set(file, [...(problems.get(file) ?? []), problem]);
  };
  for (const source of sources.values()) {
    for (const statement of source.publics) {
      for (const specifier of statement.specifiers) {
        for (const internal of reexported(source, statement, specifier)) {
          report(source.file, {
            start: specifier.local.start,
            end: specifier.local.end,
            message: `${internal.name} is @internal, so a public module must not export it: a game could import it. Import it where it is used, or make it public and give it a doc comment.`,
          });
        }
      }
      for (const type of publicTypes(source, statement)) {
        referencesIn(sources, source, type, (internals, name) => {
          for (const internal of internals) {
            report(source.file, {
              start: name.start,
              end: name.end,
              message: `${internal.name} is @internal, but this public signature names it, so a game's types reach it. Make it a public export with a doc comment, or keep it out of the signature.`,
            });
          }
        });
      }
    }
    for (const internals of source.internals.values()) {
      for (const internal of internals) {
        if (source.entry !== undefined) {
          report(source.file, {
            start: internal.start,
            end: internal.end,
            message: `${internal.name} is @internal, but ${source.path} is an entry, ${source.entry}, so a game can import it. Move it to the module's file in internal/, or make it public and give it a doc comment.`,
          });
        }
        if (!internal.used) {
          report(source.file, {
            start: internal.start,
            end: internal.end,
            message: `${internal.name} is @internal, and no source of the packages uses it, so nothing needs it. Delete it, or, if a game needs it, make it public and give it a doc comment.`,
          });
        }
      }
    }
  }
  analyses.set(cwd, problems);
  return problems;
};

/**
 * What is @internal stays out of what a game imports, as Effect's `no-unused-internal` rule
 * keeps it (packages/tools/oxc in Effect's repository), ported here: Effect's package is
 * private. Beside its three problems, an @internal export in a public signature, one exported
 * again from a public module, and one no source uses, it refuses one declared in an entry.
 * It reads the sources of every package once a run, since what it finds in a file depends on
 * the others. A test is no source, so what only a test uses is unused.
 */
const noInternalInEntries: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "What is @internal is declared outside the entries, named by no public signature or export, and used by a source.",
    },
  },
  create: (context) => {
    const problems = analyze(context.cwd).get(context.filename) ?? [];
    return {
      Program: () => {
        for (const { start, end, message } of problems) {
          context.report({
            message,
            loc: {
              start: context.sourceCode.getLocFromIndex(start),
              end: context.sourceCode.getLocFromIndex(end),
            },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "arcadekit" },
  rules: {
    "entry-imports": entryImports,
    "no-page": noPage,
    "no-code-from-text": noCodeFromText,
    "top-level-classes": topLevelClasses,
    "no-outside-state": noOutsideState,
    "id-casts": idCasts,
    "no-internal-in-entries": noInternalInEntries,
  },
};
