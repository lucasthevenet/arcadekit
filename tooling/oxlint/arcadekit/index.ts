import { definePlugin } from "@oxlint/plugins";

import { entryImportsRule } from "./rules/entry-imports.ts";
import { noCodeFromTextRule } from "./rules/no-code-from-text.ts";
import { noPageRule } from "./rules/no-page.ts";

/**
 * arcadekit's own rules: what a source file of a published package may import
 * or contain. oxlint.config.ts turns them on for packages/*\/src.
 */
const arcadekitPlugin = definePlugin({
  meta: { name: "arcadekit" },
  rules: {
    "entry-imports": entryImportsRule,
    "no-code-from-text": noCodeFromTextRule,
    "no-page": noPageRule,
  },
});

export default arcadekitPlugin;
