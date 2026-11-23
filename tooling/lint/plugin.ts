// The Oxlint plugin `arcadekit`: the rules of what a file of a published package may import or
// contain. oxlint.config.ts turns them on for packages/*/src, and no-outside-state for the
// examples and benchmarks too.
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
            message: `${file} must not name ${node.name}, which only a page has: it is behind an entry that runs in Node too. What only a page can use goes in src/Browser.ts.`,
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
 * code calls. The repository's tests record what systems did in arrays outside them, so
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

export default {
  meta: { name: "arcadekit" },
  rules: {
    "entry-imports": entryImports,
    "no-page": noPage,
    "no-code-from-text": noCodeFromText,
    "top-level-classes": topLevelClasses,
    "no-outside-state": noOutsideState,
  },
};
