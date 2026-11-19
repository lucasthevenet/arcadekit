import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type Callee = ESTree.CallExpression["callee"];

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

export const noCodeFromTextRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "No source makes code from text, which a strict Content Security Policy forbids.",
    },
  },
  create: (context) => {
    const report = (
      node: ESTree.CallExpression | ESTree.NewExpression,
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
});
