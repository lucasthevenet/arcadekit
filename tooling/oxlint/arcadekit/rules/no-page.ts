import { defineRule } from "@oxlint/plugins";

import { sourceOf } from "../shared/source.ts";

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

/** What names the global object, whose `addEventListener` is the page's. */
const globalNames = new Set(["globalThis", "self"]);

export const noPageRule = defineRule({
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
      // Every EventTarget has `addEventListener`, in Node too: a socket's or
      // a channel's is not the page's, which is the global one.
      MemberExpression: (node) => {
        if (
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "addEventListener" &&
          !(
            node.object.type === "Identifier" &&
            globalNames.has(node.object.name)
          )
        ) {
          found.add(node.property.start);
        }
      },
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
});
