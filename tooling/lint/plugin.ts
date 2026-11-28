// The Oxlint plugin `arcadekit`: the rules of what a file of a published package may import,
// contain or export. oxlint.config.ts turns them on for packages/*/src, no-outside-state and
// no-empty-payload for the benchmarks and examples/ too, and no-run-in-tests for the tests of both.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { parseSync, visitorKeys } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  BindingIdentifier,
  ClassElement,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
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

const noExponent: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No source raises a number to a power with ** or **=, which each engine may round its own way, as it may Math.pow.",
    },
  },
  create: (context) => {
    const report = (
      node: NodeOf<"BinaryExpression"> | NodeOf<"AssignmentExpression">
    ): void =>
      context.report({
        node,
        message: `ECMAScript lets each engine round ${node.operator} its own way, as it does Math.pow, so peers on different engines that ran it in a tick would come apart. Multiply, which IEEE 754 rounds one way, and write a power of two out as its number, 4_294_967_296, or as 1 << n for an n under 31.`,
      });
    return {
      BinaryExpression: (node) => {
        if (node.operator === "**") {
          report(node);
        }
      },
      AssignmentExpression: (node) => {
        if (node.operator === "**=") {
          report(node);
        }
      },
    };
  },
};

/** What runs an Effect by hand, as `Effect.<name>`. */
const runsByHand = new Set([
  "runSync",
  "runSyncExit",
  "runSyncWith",
  "runSyncExitWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseWith",
  "runPromiseExitWith",
]);

const noRunInTests: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A test of a package is an Effect itself, with it.effect, and runs none by hand, nor does a helper of one.",
    },
  },
  create: (context) => ({
    MemberExpression: (node) => {
      if (
        !node.computed &&
        node.object.type === "Identifier" &&
        node.object.name === "Effect" &&
        node.property.type === "Identifier" &&
        runsByHand.has(node.property.name)
      ) {
        context.report({
          node,
          message: `Effect.${node.property.name} runs an Effect by hand. A test is an Effect itself: write it with it.effect from @effect/vitest, or it.live where it waits in real time, and yield* the effect in it. A helper of a test returns the effect for the test to yield*.`,
        });
      }
    },
  }),
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

/** The calls whose last argument is the code of a system between ticks: `System.frame("Draw", function* () { ... })`. */
const betweenCallees = new Set(["System.frame", "System.input"]);

/** The code of a frame or an input system a call is given: its last argument. */
const betweenCodeOf = (
  node: NodeOf<"CallExpression">
): TickCode | undefined => {
  const { callee } = node;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier" ||
    !betweenCallees.has(`${callee.object.name}.${callee.property.name}`)
  ) {
    return undefined;
  }
  return node.arguments.at(-1);
};

/** The references of a body to names it did not declare. */
const throughOf = (context: Context, body: TickCode): Reference[] =>
  context.sourceCode.scopeManager.scopes.flatMap((scope) =>
    scope.upper === null ||
    !within(scope.block, body) ||
    within(scope.upper.block, body)
      ? []
      : scope.through
  );

/** What a module makes its own state with, called with `new`. */
const stateConstructors = new Set(["Object", "Array", "Map", "Set"]);

/**
 * Whether a variable is declared at the top of its module and made there as an object, an
 * array, a `Map` or a `Set`: `const state = { count: 0 }`, `let seen = new Set<number>()`.
 */
const madeByTheModule = (variable: Reference["resolved"]): boolean =>
  variable?.scope.type === "module" &&
  variable.defs.some((def) => {
    if (def.node.type !== "VariableDeclarator" || def.node.id !== def.name) {
      return false;
    }
    let made = def.node.init;
    while (
      made?.type === "TSAsExpression" ||
      made?.type === "TSSatisfiesExpression"
    ) {
      made = made.expression;
    }
    return (
      made?.type === "ObjectExpression" ||
      made?.type === "ArrayExpression" ||
      (made?.type === "NewExpression" &&
        made.callee.type === "Identifier" &&
        stateConstructors.has(made.callee.name))
    );
  });

/**
 * Code of the tick keeps what it changes in the world, and a frame or an input system keeps
 * what it sets between frames in a `System.local`. It can't see what code is given by name
 * rather than written in the call, nor a function declared elsewhere that the code calls. It
 * leaves imports alone, since `HashMap.set(map, key, value)` changes nothing, and so misses a
 * `Map` a module exports. A frame system draws by changing objects outside it, a canvas or a
 * camera, so of its code only two changes are refused: setting a variable declared outside it,
 * and changing an object, an array, a `Map` or a `Set` its module makes at the top, as
 * `state.count += 1` and `seen.add(id)` do. Syntax can't tell whether any other object is
 * state or what the system draws on, so one that a function or a class makes, or that is
 * handed to the system, is let through. The repository's tests record what systems did in
 * arrays outside them, so oxlint.config.ts leaves test/ out.
 */
const noOutsideState: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The code of the tick (a system of the tick, a state's hook, an action's handler, a plugin's setup) changes nothing declared outside it, and a frame or an input system sets no variable declared outside it and changes no object, array, Map or Set its module makes at the top.",
    },
  },
  create: (context) => ({
    CallExpression: (node) => {
      const tick = tickCodeOf(node);
      if (tick !== undefined) {
        for (const reference of throughOf(context, tick)) {
          if (changes(reference)) {
            context.report({
              node: reference.identifier,
              message: `This changes ${reference.identifier.name}, which is declared outside the code of the tick it is in: a refused action doesn't undo it, and a save, a rewind or a replay doesn't hold it. Keep the state in the world, as a component or a singleton, or, for a cache rebuilt from the world, in a Field.transient field of a singleton.`,
            });
          }
        }
        return;
      }
      const between = betweenCodeOf(node);
      if (between === undefined) {
        return;
      }
      for (const reference of throughOf(context, between)) {
        if (
          !changes(reference) ||
          !(reference.isWrite() || madeByTheModule(reference.resolved))
        ) {
          continue;
        }
        const { name } = reference.identifier;
        context.report({
          node: reference.identifier,
          message: reference.isWrite()
            ? `This sets ${name}, a variable declared outside the frame or input system it is in: every app of the game shares it, and closing an app doesn't let go of it. Keep what a frame or an input system keeps from one frame to the next in a System.local, of which each app has its own: const Kept = System.local(() => ({ ${name}: ... })), then (yield* Kept).${name} in the system.`
            : `This changes ${name}, an object its module makes once, from a frame or an input system: every app of the game shares it, and closing an app doesn't let go of it. Make it in a System.local, of which each app has its own: const Kept = System.local(() => ...), the dots being what makes ${name} now, then const ${name} = yield* Kept in the system. What code outside the app reads, such as what it draws on, is given to the app as a service instead.`,
        });
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
            "This asserts that a value is an entity's id, which the compiler then takes on trust: a number that is no id, or an id cut to 32 bits, would pass. A game keeps an id in a Field.entity or a relation, turns a stored one back with world.live, and reads its parts with entityIndex and entityGeneration. The storage core converts with idOf and entityOf from src/ecs/component.ts, the one place that may. A value whose type is taken from what it starts as is given its type instead: View.define<readonly Entity[]>(name, []).",
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

/** A source file of a package, as no-unused-internal reads it. */
interface Source {
  readonly file: string;
  /** Its path in its package, such as "src/Action.ts". */
  readonly path: string;
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
  readonly publics: (
    | ExportNamedDeclaration
    | ExportAllDeclaration
    | ExportDefaultDeclaration
  )[];
  /** Whether the doc comment of a statement or a member says `@internal`. */
  readonly isInternalDoc: (node: Node) => boolean;
}

interface Problem {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

/** A package under packages/: its name, its folder, and the source file of each of its entries. */
interface Workspace {
  readonly name: string;
  readonly dir: string;
  readonly entries: ReadonlySet<string>;
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

/** A package, by the name its package.json gives it, and its entries by their `source` condition. */
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
  const exported = field(json, "exports");
  const entries = new Set(
    (typeof exported === "object" && exported !== null
      ? Object.values(exported)
      : []
    ).flatMap((target) => {
      const source = field(target, "source");
      return typeof source === "string" ? [join(dir, source)] : [];
    })
  );
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
    } else if (
      statement.type === "ExportAllDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ) {
      if (!isInternalPath(file)) {
        source.publics.push(statement);
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

/** The members a public declaration shows, with the name of each. */
const membersOf = (
  statement: ExportNamedDeclaration
): readonly { readonly node: Node; readonly name: string }[] => {
  const { declaration } = statement;
  const members: readonly Node[] =
    declaration?.type === "TSInterfaceDeclaration" ||
    declaration?.type === "ClassDeclaration"
      ? declaration.body.body
      : declaration?.type === "TSTypeAliasDeclaration" &&
          declaration.typeAnnotation.type === "TSTypeLiteral"
        ? declaration.typeAnnotation.members
        : [];
  return members.flatMap((node) => {
    const key = field(node, "key");
    const name =
      field(key, "type") === "Identifier"
        ? field(key, "name")
        : field(key, "value");
    return typeof name === "string" ? [{ node, name }] : [];
  });
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

/**
 * The problems of each file of the packages under `cwd`, with the sources and their times of
 * change they were found in: found again once a source changes, as in an editor.
 */
const analyses = new Map<
  string,
  {
    readonly stamp: string;
    readonly problems: ReadonlyMap<string, readonly Problem[]>;
  }
>();

const analyze = (cwd: string): ReadonlyMap<string, readonly Problem[]> => {
  const root = join(cwd, "packages");
  const workspaces = (existsSync(root) ? readdirSync(root) : []).flatMap(
    (folder) => workspaceOf(join(root, folder)) ?? []
  );
  const files = workspaces.flatMap((workspace) =>
    sourceFiles(join(workspace.dir, "src")).map((file) => ({
      file,
      workspace,
    }))
  );
  const stamp = files
    .map(({ file }) => `${file}@${statSync(file).mtimeMs}`)
    .join("\n");
  const known = analyses.get(cwd);
  if (known?.stamp === stamp) {
    return known.problems;
  }
  const sources = new Map<string, Source>();
  for (const { file, workspace } of files) {
    sources.set(file, readSource(file, workspace, workspaces));
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

  /** The source an `export *` or a dynamic import leads to. */
  const sourceAt = (source: Source, specifier: string): Source | undefined => {
    const file = resolveModule(specifier, source.file, workspaces);
    return file === undefined ? undefined : sources.get(file);
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
        (node.type === "ImportExpression" ||
          node.type === "ExportAllDeclaration") &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        for (const internals of sourceAt(
          source,
          node.source.value
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
  const entryFiles = new Set(
    workspaces.flatMap((workspace) => [...workspace.entries])
  );
  for (const source of sources.values()) {
    if (entryFiles.has(source.file)) {
      for (const internals of source.internals.values()) {
        for (const internal of internals) {
          report(source.file, {
            start: internal.start,
            end: internal.end,
            message: `${internal.name} is @internal, but ${source.path} is an entry, which a game imports: an entry's own file exports only what a game uses. Move it to the internal/ folder beside the module and import it from there, or make it public and give it a doc comment.`,
          });
        }
      }
      for (const statement of source.publics) {
        if (statement.type !== "ExportNamedDeclaration") {
          continue;
        }
        for (const { node, name } of membersOf(statement)) {
          if (
            source.isInternalDoc(node) &&
            !(
              "accessibility" in node &&
              (node.accessibility === "private" ||
                node.accessibility === "protected")
            )
          ) {
            report(source.file, {
              start: node.start,
              end: node.end,
              message: `${name} is @internal, but it is a member of a public export of the entry ${source.path}, so a game that holds one can call it. Keep it off the public type, in a WeakMap of the module or on an object of an internal/ file, or make it public and say what it does.`,
            });
          }
        }
      }
    }
    const reexporting = (internal: Internal, name: Node): void =>
      report(source.file, {
        start: name.start,
        end: name.end,
        message: `${internal.name} is @internal, so a public module must not export it: a game could import it. Import it where it is used, or make it public and give it a doc comment.`,
      });
    for (const statement of source.publics) {
      if (statement.type === "ExportAllDeclaration") {
        const all = sourceAt(source, statement.source.value);
        // A public module's @internal exports go where it goes, as in Effect's barrels:
        // `export * as Schema from "./Schema"`. Only a file of internal/ is refused.
        if (
          all !== undefined &&
          all.internals.size > 0 &&
          isInternalPath(all.file)
        ) {
          report(source.file, {
            start: statement.source.start,
            end: statement.source.end,
            message: `${all.path} has @internal exports, so a public module must not export all of it: a game could import what is internal. Export its public names one by one.`,
          });
        }
        continue;
      }
      if (statement.type === "ExportDefaultDeclaration") {
        if (statement.declaration.type === "Identifier") {
          for (const internal of referredBy(
            sources,
            source,
            statement.declaration.name
          )) {
            reexporting(internal, statement.declaration);
          }
        }
        continue;
      }
      for (const specifier of statement.specifiers) {
        for (const internal of reexported(source, statement, specifier)) {
          reexporting(internal, specifier.local);
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
  analyses.set(cwd, { stamp, problems });
  return problems;
};

/**
 * What is @internal stays out of what a game imports, as Effect's `no-unused-internal` rule
 * keeps it (packages/tools/oxc in Effect's repository), ported here: Effect's package is
 * private: an @internal export a public signature names, one a public module exports again, and
 * one no source uses. Beyond Effect's, an entry's own file, which a package.json names by its
 * `source` condition, declares no @internal export and no @internal member of a public export:
 * what a game sees after `State.` or on what a system yields is what it may use.
 * It reads the sources of every package, again whenever one has changed, since what it finds
 * in a file depends on the others. A test is no source, so what only a test uses is unused.
 * Like Effect's, it reads a signature that is written out: an export made by a call, such as
 * `wrap((q: Hidden) => q)` or `Effect.fn(...)`, can name an @internal type unseen.
 */
const noUnusedInternal: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "What is @internal is named by no public signature or export, is declared in no entry's file, and is used by a source.",
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

/** The words of a name in PascalCase: "SceneShape" is Scene and Shape, "Transform2d" one word. */
const wordsOf = (name: string): readonly string[] =>
  name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/gu) ?? [];

/** Whether the words of `name` hold the words of `module`, one after another. */
const repeats = (name: string, module: string): boolean => {
  const words = wordsOf(name);
  const own = wordsOf(module);
  return (
    name !== module &&
    own.length > 0 &&
    words.some((_, i) => own.every((word, j) => words[i + j] === word))
  );
};

/**
 * The namespace a game reads each export of a module after, by the module's file: its own
 * name, unless another module of its package gives the export again by name, as `Three` gives
 * what `Scene` and `Renderer` export.
 */
const namespaces = new Map<
  string,
  {
    readonly stamp: string;
    readonly readAs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  }
>();

const readAsOf = (
  cwd: string
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const root = join(cwd, "packages");
  const modules = (existsSync(root) ? readdirSync(root) : [])
    .flatMap((folder) => workspaceOf(join(root, folder)) ?? [])
    .flatMap((workspace) => [...workspace.entries])
    .filter((file) => existsSync(file) && /^[A-Z]/u.test(basename(file)));
  const stamp = modules
    .map((file) => `${file}@${statSync(file).mtimeMs}`)
    .join("\n");
  const known = namespaces.get(cwd);
  if (known?.stamp === stamp) {
    return known.readAs;
  }
  const readAs = new Map<string, Map<string, string>>();
  for (const file of modules) {
    const { program } = parseSync(file, readFileSync(file, "utf8"));
    for (const statement of program.body) {
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.source === null
      ) {
        continue;
      }
      const from = resolveFile(join(dirname(file), statement.source.value));
      if (from === undefined) {
        continue;
      }
      const names = readAs.get(from) ?? new Map<string, string>();
      for (const specifier of statement.specifiers) {
        names.set(nameOfSpecifier(specifier.local), basename(file, ".ts"));
      }
      readAs.set(from, names);
    }
  }
  namespaces.set(cwd, { stamp, readAs });
  return readAs;
};

/** The tag of a class that extends `Data.TaggedError("Tag")` or `Schema.TaggedError<C>()("Tag", ...)`. */
const tagOf = (superClass: unknown): string | undefined => {
  let call: unknown = superClass;
  while (field(call, "type") === "CallExpression") {
    const callee = field(call, "callee");
    const named =
      field(callee, "type") === "MemberExpression"
        ? field(field(callee, "property"), "name")
        : field(callee, "type") === "CallExpression"
          ? field(field(field(callee, "callee"), "property"), "name")
          : undefined;
    const first: unknown = (
      field(call, "arguments") as unknown[] | undefined
    )?.[0];
    if (
      typeof named === "string" &&
      /^Tagged(?:Error|ErrorClass)$/u.test(named) &&
      field(first, "type") === "Literal" &&
      typeof field(first, "value") === "string"
    ) {
      return field(first, "value") as string;
    }
    call = callee;
  }
  return undefined;
};

/**
 * The names of a module's types and errors, as modules.md says them: a type is named for what
 * it is after the namespace a game reads it after, which it does not repeat, and an error's tag
 * is that namespace and its class together.
 */
const names: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A module's types do not repeat its name, and an error's tag is its module's name and its class's.",
    },
  },
  create: (context) => {
    const file = context.filename;
    const module = basename(file, ".ts");
    const dir = /^(.*\/packages\/[^/]+)\/src\//u.exec(file)?.[1];
    const workspace = dir === undefined ? undefined : workspaceOf(dir);
    if (
      workspace === undefined ||
      !workspace.entries.has(file) ||
      !/^[A-Z]/u.test(module)
    ) {
      return {};
    }
    const readAs = readAsOf(context.cwd).get(file);
    return {
      ExportNamedDeclaration: (node) => {
        const { declaration } = node;
        if (
          declaration?.type !== "TSInterfaceDeclaration" &&
          declaration?.type !== "TSTypeAliasDeclaration" &&
          declaration?.type !== "ClassDeclaration"
        ) {
          return;
        }
        const id = declaration.id;
        if (id?.type !== "Identifier") {
          return;
        }
        const name = id.name;
        const namespace = readAs?.get(name) ?? module;
        if (repeats(name, namespace)) {
          context.report({
            node: id,
            message: `${name} repeats ${namespace}, the namespace a game reads it after: ${namespace}.${name}. Name it for what it is after the namespace, and the module's main type ${namespace}.${namespace}, as modules.md says.`,
          });
        }
        if (declaration.type !== "ClassDeclaration") {
          return;
        }
        const tag = tagOf(declaration.superClass);
        const wanted = `${namespace}${name}`;
        if (tag !== undefined && tag !== wanted) {
          context.report({
            node: id,
            message: `${name}'s tag is "${tag}". An error's tag is its namespace and its class together, "${wanted}": Effect.catchTag takes the tag, so two errors of one bare tag from two modules would be caught as one.`,
          });
        }
      },
    };
  },
};

/** `Action.define` for `Action.define(...)`: the name of a call to a member of a namespace. */
const dottedName = (callee: Callee): string | undefined =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.object.type === "Identifier" &&
  callee.property.type === "Identifier"
    ? `${callee.object.name}.${callee.property.name}`
    : undefined;

/** What each definer defines with no payload, and how a game then issues it, with none. */
const withNone = new Map([
  [
    "Action.define",
    'Action.define("duel/Pass"), dispatched as app.dispatch(Pass)',
  ],
  ["Event.define", 'Event.define("game/Started"), emitted as emit()'],
]);

const noEmptyPayload: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "An action or an event with no payload is defined with no schema, not with Schema.Struct({}).",
    },
  },
  create: (context) => ({
    CallExpression: (node) => {
      const name = dottedName(node.callee);
      const none = name === undefined ? undefined : withNone.get(name);
      const [, second] = node.arguments;
      const options =
        name === "Action.define" && second?.type === "ObjectExpression"
          ? second
          : undefined;
      const payload =
        name === "Action.define"
          ? options?.properties
              .filter((property) => property.type === "Property")
              .find(
                (property) =>
                  property.key.type === "Identifier" &&
                  property.key.name === "payload"
              )?.value
          : second;
      if (
        none === undefined ||
        payload?.type !== "CallExpression" ||
        dottedName(payload.callee) !== "Schema.Struct" ||
        payload.arguments.length !== 1 ||
        payload.arguments[0]?.type !== "ObjectExpression" ||
        payload.arguments[0].properties.length > 0
      ) {
        return;
      }
      context.report({
        node: payload,
        message: `Schema.Struct({}) is a payload with nothing in it, which every call must still give as {}. ${
          options === undefined || options.properties.length === 1
            ? `Give no schema: ${none}.`
            : `Leave out the payload: Action.define("duel/Pass", { error }), dispatched as app.dispatch(Pass).`
        }`,
      });
    },
  }),
};

export default {
  meta: { name: "arcadekit" },
  rules: {
    "entry-imports": entryImports,
    "no-page": noPage,
    "no-code-from-text": noCodeFromText,
    "no-exponent": noExponent,
    "no-run-in-tests": noRunInTests,
    "top-level-classes": topLevelClasses,
    "no-outside-state": noOutsideState,
    "id-casts": idCasts,
    "no-unused-internal": noUnusedInternal,
    names,
    "no-empty-payload": noEmptyPayload,
  },
};
