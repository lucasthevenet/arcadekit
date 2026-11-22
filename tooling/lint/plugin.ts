// The Oxlint plugin `arcadekit`: the rules of what a source file of a published package may
// import or contain. oxlint.config.ts turns them on for packages/*/src.
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

const noPlainError: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Outside the storage core, a source makes no plain Error: a mistake of the program is a class of arcadekit/Defect.",
    },
  },
  create: (context) => {
    const source = sourceOf(context.filename);
    // The storage core imports no package, Effect among them: its errors are its own.
    if (source === undefined || source.file.startsWith("src/ecs/")) {
      return {};
    }
    const check = (
      node: NodeOf<"CallExpression"> | NodeOf<"NewExpression">
    ): void => {
      if (node.callee.type === "Identifier" && node.callee.name === "Error") {
        context.report({
          node,
          message:
            "A plain Error says nothing of which mistake it is but its words. Throw a class of arcadekit/Defect (WrongPhase, InvalidDefinition, InvalidArgument, TakenOver, ScopeClosed, NotSynchronous), or Effect.die with one, whose tag and fields a test and a tool can match. A failure a correct program has to expect is a Data.TaggedError of its own, in the error channel.",
        });
      }
    };
    return { CallExpression: check, NewExpression: check };
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

export default {
  meta: { name: "arcadekit" },
  rules: {
    "entry-imports": entryImports,
    "no-page": noPage,
    "no-code-from-text": noCodeFromText,
    "no-plain-error": noPlainError,
    "top-level-classes": topLevelClasses,
  },
};
