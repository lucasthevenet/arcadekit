// An oxlint JS plugin (ESLint's plugin shape) for which entry of the arcadekit package may
// import which (ADR-0018). The entries were separate packages once, and their package.json
// files said what each could reach; now they are folders of one package, and this rule says it.
//
// Inside the package's src/, an import must be relative, and it must either stay in its own
// entry's folder or name another entry's public file (the `source` of one of the package's
// `exports`), and only an entry its own is allowed to import.
import path from "node:path";

interface Node {
  readonly type: string;
  readonly source?: { readonly type: string; readonly value?: unknown } | null;
}

interface Options {
  /** The package's name: importing it from inside itself is refused. */
  readonly packageName: string;
  /** The folder that holds one folder per entry, from the repository root. */
  readonly root: string;
  /** For each entry folder, the other entry folders it may import. */
  readonly allowed: Readonly<Record<string, readonly string[]>>;
  /** Each entry's public files, from `root`, without extension ("net/browser/index"). */
  readonly entryFiles: readonly string[];
}

interface RuleContext {
  readonly filename: string;
  readonly options: readonly Options[];
  readonly report: (descriptor: { node: Node; message: string }) => void;
}

const adr = "See docs/adr/0018-one-package-with-entries.md.";

const withoutExtension = (file: string): string =>
  file.replace(/\.(?:ts|tsx|js|mjs)$/u, "");

const allowed = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the direction of imports between the arcadekit package's entries.",
    },
    schema: [{ type: "object" }],
  },
  create: (context: RuleContext) => {
    const [options] = context.options;
    if (options === undefined) {
      return {};
    }
    const file = context.filename.split(path.sep).join("/");
    const marker = `${options.root}/`;
    const at = file.lastIndexOf(marker);
    if (at === -1) {
      return {};
    }
    const fromRoot = file.slice(at + marker.length);
    const [own] = fromRoot.split("/");
    if (own === undefined || !fromRoot.includes("/")) {
      return {};
    }
    const mayImport = options.allowed[own];
    const entryFiles = new Set(options.entryFiles);

    const check = (node: Node) => {
      const specifier = node.source?.value;
      if (typeof specifier !== "string") {
        return;
      }
      if (
        specifier === options.packageName ||
        specifier.startsWith(`${options.packageName}/`)
      ) {
        context.report({
          node,
          message: `"${specifier}": inside the package, import another entry by its relative path, so the source, the build and the published files all reach the same module. ${adr}`,
        });
        return;
      }
      if (!specifier.startsWith(".")) {
        return;
      }
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromRoot), specifier)
      );
      const [entry] = target.split("/");
      if (entry === own) {
        return;
      }
      if (
        target.startsWith("..") ||
        entry === undefined ||
        options.allowed[entry] === undefined
      ) {
        context.report({
          node,
          message: `"${specifier}" leaves the package's entries. ${adr}`,
        });
        return;
      }
      if (mayImport === undefined || !mayImport.includes(entry)) {
        const list =
          mayImport === undefined || mayImport.length === 0
            ? "no other entry"
            : mayImport.join(", ");
        context.report({
          node,
          message: `arcadekit/${own} may not import arcadekit/${entry}: it may import ${list}. ${adr}`,
        });
        return;
      }
      if (!entryFiles.has(withoutExtension(target))) {
        context.report({
          node,
          message: `"${specifier}" reaches inside arcadekit/${entry}. Import one of its public files (the sources of the package's exports), as a game would. ${adr}`,
        });
      }
    };

    return {
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportDeclaration: check,
      ImportExpression: check,
    };
  },
};

export default {
  meta: { name: "entry-direction" },
  rules: { allowed },
};
