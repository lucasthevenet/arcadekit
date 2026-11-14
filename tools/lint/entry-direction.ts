// An oxlint JS plugin (ESLint's plugin shape) for which entry of the arcadekit package may
// import which. The entries were separate packages once, and their package.json
// files said what each could reach; now they are folders of one package, and this rule says it.
//
// Inside the package's src/, an import must be relative, and it must either stay in its own
// entry's folder or name another entry's public file (the `source` of one of the package's
// `exports`), and only an entry its own is allowed to import. A dynamic import must name its
// module in a plain string, since neither this rule nor the import bans can read anything else.
//
// The entries' tests are in test/, each in the folder its entry has under src/
// (test/net/browser/coop.test.ts tests src/net/browser/). A test is held to the same rule as a
// file of its entry: it may import anything of its own entry, from src/ or from beside it in
// test/, and another entry only by a public file. A file of src/ may import nothing of test/.
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
  /** The folder of the entries' tests, from the repository root, with a folder per entry as `root`. */
  readonly tests?: string;
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

const skill = "See .agents/skills/entries/SKILL.md.";

const withoutExtension = (file: string): string =>
  file.replace(/\.(?:ts|tsx|js|mjs)$/u, "");

interface Place {
  /** The file's path from the repository root. */
  readonly at: string;
  /** The entry folder the file is in, under `root` or `tests`. */
  readonly own: string;
  /** The folders, from the repository root, whose files are the file's own entry's. */
  readonly ownFolders: readonly string[];
}

/** Where a file is: in an entry's folder of `root`, in one of `tests`, or in neither. */
const placeOf = (file: string, options: Options): Place | undefined => {
  for (const folder of [options.root, options.tests]) {
    if (folder === undefined) {
      continue;
    }
    const marker = `${folder}/`;
    const index = file.lastIndexOf(marker);
    if (index === -1) {
      continue;
    }
    const fromFolder = file.slice(index + marker.length);
    const [own] = fromFolder.split("/");
    if (own === undefined || !fromFolder.includes("/")) {
      return undefined;
    }
    return {
      at: file.slice(index),
      own,
      ownFolders:
        folder === options.root
          ? [`${options.root}/${own}`]
          : [`${options.root}/${own}`, `${folder}/${own}`],
    };
  }
  return undefined;
};

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
    const place = placeOf(context.filename.split(path.sep).join("/"), options);
    if (place === undefined) {
      return {};
    }
    const { at, own, ownFolders } = place;
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
          message: `"${specifier}": inside the package, import another entry by its relative path, so the source, the build and the published files all reach the same module. ${skill}`,
        });
        return;
      }
      if (!specifier.startsWith(".")) {
        return;
      }
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(at), specifier)
      );
      if (
        ownFolders.some(
          (folder) => target === folder || target.startsWith(`${folder}/`)
        )
      ) {
        return;
      }
      const fromRoot = target.startsWith(`${options.root}/`)
        ? target.slice(options.root.length + 1)
        : undefined;
      const [entry] = fromRoot?.split("/") ?? [];
      if (
        fromRoot === undefined ||
        entry === undefined ||
        options.allowed[entry] === undefined
      ) {
        context.report({
          node,
          message: `"${specifier}" leaves the package's entries. ${skill}`,
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
          message: `arcadekit/${own} may not import arcadekit/${entry}: it may import ${list}. ${skill}`,
        });
        return;
      }
      if (!entryFiles.has(withoutExtension(fromRoot))) {
        context.report({
          node,
          message: `"${specifier}" reaches inside arcadekit/${entry}. Import one of its public files (the sources of the package's exports), as a game would. ${skill}`,
        });
      }
    };

    // import(`x`) and import(name) would pass this rule, and no-restricted-imports too.
    const checkDynamic = (node: Node) => {
      if (
        node.source?.type !== "Literal" ||
        typeof node.source.value !== "string"
      ) {
        context.report({
          node,
          message: `A dynamic import inside the package names its module in a plain string ("..."), so the rules on what an entry may import can read it. ${skill}`,
        });
        return;
      }
      check(node);
    };

    return {
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportDeclaration: check,
      ImportExpression: checkDynamic,
    };
  },
};

export default {
  meta: { name: "entry-direction" },
  rules: { allowed },
};
