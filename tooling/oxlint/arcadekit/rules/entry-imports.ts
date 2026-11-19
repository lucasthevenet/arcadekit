import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { mayReach } from "../shared/entries.ts";
import type { EntryRule } from "../shared/entries.ts";
import { resolve, sourceOf } from "../shared/source.ts";

type ImportSource = ESTree.ImportExpression["source"];

export const entryImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "A source file imports only what the entry it is behind may import (shared/entries.ts).",
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
});
