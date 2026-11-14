// Which files of the repository are pages of the site, and where each one is served.
//
// The site has one page of its own, the landing page (src/content/docs/index.mdx). Every other
// page is the repository's own text, read where it is (loader.ts):
// - each file under `docs/`, at its path there: `docs/guides/sprites.md` at `/guides/sprites`.
//   These are the guides, the concepts and the walkthrough, read on GitHub and here;
// - each entry of the package's `exports`, at `/reference/<entry>`, so a reference page's address
//   ends with its import path (`arcadekit/net/worker` is `/reference/net/worker`). Its page is its
//   README, `packages/arcadekit/src/<entry>/README.md`, which npm shows too, then the API of its
//   own exports (api.ts). An entry with no README has its public file's module comment instead;
// - each namespace an entry exports, at `/reference/<entry>/<file>`: `Rng` of `arcadekit/core`,
//   from `src/core/rng.ts`, at `/reference/core/rng`. Its page is its module comment and its API;
// - the glossary, `CONTEXT.md`, at `/glossary`.
// `docs/`, the READMEs and the package's `exports` are read whole, so a new page, entry or module
// is a page without a change here.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readApi, renderExports } from "./api.ts";
import type { Entry, Module } from "./api.ts";
import { REPO_ROOT, WEBSITE_DIR } from "./site.ts";

const KIT_DIR = "packages/arcadekit";
const KIT_MANIFEST = `${KIT_DIR}/package.json`;
const KIT_SRC = `${KIT_DIR}/src`;
const DOCS = "docs";
/** Where the entries' reference pages are served: an entry's page is this, then its import path. */
const REFERENCE = "reference";
const GLOSSARY = "CONTEXT.md";
const HOME = `${WEBSITE_DIR}/src/content/docs/index.mdx`;

/**
 * The package's README. It has no page of its own: the landing page includes it, after its title
 * and first paragraph (landing.ts).
 */
export const PACKAGE_README = "packages/arcadekit/README.md";

/** A page of the site. Paths are relative to the repository's root. */
export interface SitePage {
  /**
   * The file it is written in, such as `packages/arcadekit/src/net/worker/README.md`, or the
   * source file a reference page is read from. Its relative links are read from where it is.
   */
  readonly file: string;
  /** Every file a link to lands on this page: its own, and an entry's public file. */
  readonly files: readonly string[];
  /** Its id in Starlight's `docs` collection, which is its address without the slash: `net/worker`. */
  readonly slug: string;
  /** Its address on the site, such as `/net/worker`. */
  readonly link: string;
}

/** A page whose file is the repository's own markdown, written for GitHub. */
export interface RepositoryPage extends SitePage {
  /** The file's `# ` heading, its first line, such as `arcadekit/net/worker`. */
  readonly title: string;
  /** Its first paragraph as plain text, for the page's description. Empty if it has none. */
  readonly description: string;
  /** Its markdown after the title, which the page renders below the title Starlight writes. */
  readonly body: string;
}

/** A page of `docs/`: a guide, a concept or the walkthrough. */
export interface DocPage extends RepositoryPage {
  /** Its top folder under `docs/`, such as `guides`, or `""` for a file directly in it. */
  readonly section: string;
}

/** The reference page of an entry of the package. */
export interface EntryPage extends RepositoryPage {
  /** The entry's folder under `src/`, such as `net/worker`: its import path after `arcadekit/`. */
  readonly entry: string;
  /** Whether its page is its README, or else its public file's module comment. */
  readonly readme: boolean;
  /** How many exports its page documents: its own, not its modules'. */
  readonly exports: number;
}

/** The reference page of a namespace an entry exports. */
export interface ModulePage extends RepositoryPage {
  /** The entry that exports it, such as `core`. */
  readonly entry: string;
  /** Its name in the entry, such as `Rng`. */
  readonly module: string;
  /** How many exports its page documents. */
  readonly exports: number;
}

const toPosix = (file: string) => file.split(path.sep).join("/");

const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

const TITLE = /^# (?<title>.+)\n+/u;

/** A file's title, the `# ` heading on its first line, and its markdown after it. */
export const splitTitle = (
  markdown: string,
  file: string
): { readonly title: string; readonly body: string } => {
  const match = TITLE.exec(markdown);
  const title = match?.groups?.title?.trim();
  if (match === null || title === undefined) {
    throw new Error(
      `${file} must start with a "# " heading: it is its page's title`
    );
  }
  return { title, body: markdown.slice(match[0].length) };
};

/** Markdown's inline marks removed: links keep their text, code and emphasis their content. */
const plainText = (markdown: string) =>
  markdown
    .replaceAll(/\[(?<text>[^\]]*)\]\([^)]*\)/gu, "$<text>")
    .replaceAll(/[`*]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

const DESCRIPTION_LENGTH = 200;

/**
 * How a block of prose starts: with a letter, with inline markdown, or with an issue number
 * (`#24 asked`). A heading starts with `# `, and a table, a list and a code block with their own
 * marks.
 */
const STARTS_PROSE = /^(?:[\p{L}`*[]|#\d)/u;

/** The first paragraph after the title, cut at the end of a sentence if it is long. */
export const firstParagraph = (markdown: string): string => {
  const afterTitle = markdown.slice(markdown.search(/^# /mu));
  const [, ...blocks] = afterTitle.split(/\n{2,}/u);
  const paragraph = plainText(
    blocks.find((block) => STARTS_PROSE.test(block)) ?? ""
  );
  if (paragraph.length <= DESCRIPTION_LENGTH) {
    return paragraph;
  }
  let description = "";
  for (const sentence of paragraph.match(/.+?\.(?:\s|$)/gu) ?? []) {
    if (
      description !== "" &&
      description.length + sentence.length > DESCRIPTION_LENGTH
    ) {
      break;
    }
    description += sentence;
  }
  return description.trim() || paragraph;
};

/** A file of the repository as a page, read from disk now. */
export const readPage = (file: string, slug: string): RepositoryPage => {
  const markdown = read(file);
  const { title, body } = splitTitle(markdown, file);
  return {
    file,
    files: [file],
    slug,
    link: `/${slug}`,
    title,
    description: firstParagraph(markdown),
    body,
  };
};

/** Every markdown file under a folder of the repository, however deep. */
const markdownUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { recursive: true })
    .map((file) => toPosix(String(file)))
    .filter((file) => file.endsWith(".md"))
    .toSorted();

const docPages = (): DocPage[] =>
  markdownUnder(DOCS).map((file) => {
    const slug = file.replace(/\.md$/u, "");
    const section = file.includes("/") ? (file.split("/", 1)[0] ?? "") : "";
    return { ...readPage(`${DOCS}/${file}`, slug), section };
  });

/** The package's entries, from its `exports`: `net/browser` to its public file. */
export const kitEntries = (): Record<string, string> => {
  const { exports } = JSON.parse(read(KIT_MANIFEST)) as {
    readonly exports: Readonly<Record<string, { readonly source?: string }>>;
  };
  // An entry is `./net/browser`. `.`, `./package.json` and a pattern are not.
  return Object.fromEntries(
    Object.entries(exports).flatMap(([subpath, conditions]) =>
      /^\.(?:\/[\w-]+)+$/u.test(subpath) && conditions.source !== undefined
        ? [[subpath.slice(2), conditions.source]]
        : []
    )
  );
};

/** The package's API: every entry, with its own exports and its modules' (api.ts). */
export const kitApi = (): Entry[] => readApi(REPO_ROOT, KIT_DIR, kitEntries());

/** A link from one file of the repository to another, as a page writes it. */
const linkFrom = (from: string, to: string) =>
  path.posix.relative(path.posix.dirname(from), to);

/**
 * What a module is, for a list of modules: its comment's first sentence, after the name it starts
 * with ("Co-op clients: one player's side of a co-op game, …").
 */
const summaryOf = (comment: string) => {
  const paragraph = firstParagraph(`# _\n\n${comment}`);
  const sentence = /^.+?\.(?=\s|$)/u.exec(paragraph)?.[0] ?? paragraph;
  return /^[^:`]+: (?<rest>.+)$/u.exec(sentence)?.groups?.rest ?? sentence;
};

/**
 * An entry's public file's comment, as its page's text: without the import path it starts with,
 * which is the page's title (`arcadekit/net/browser: lockstep over WebRTC…`).
 */
const entryComment = (api: Entry) => {
  const text = api.comment.replace(
    new RegExp(`^\`?arcadekit/${api.entry}\`?:\\s*`, "u"),
    ""
  );
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

/**
 * What the API adds to an entry's page: that it has its parent's exports too, its modules when
 * its README doesn't list them, and its own exports. `from` is the file the page is written in.
 */
const entryApi = (api: Entry, from: string, readme: boolean) => {
  const parts: string[] = [];
  if (api.extends !== undefined) {
    parts.push(
      `It has every export of [\`arcadekit/${api.extends}\`](${linkFrom(from, `${KIT_SRC}/${api.extends}/README.md`)}) too, which its page lists. These are its own.`
    );
  }
  if (!readme && api.modules.length > 0) {
    parts.push(
      "## Its modules",
      api.modules
        .map(
          (module) =>
            `- [\`${module.name}\`](${linkFrom(from, module.file)}): ${summaryOf(module.comment)}`
        )
        .join("\n")
    );
  }
  if (api.exports.length > 0) {
    parts.push(
      ...(readme ? ["## API"] : []),
      renderExports(api.exports, readme ? 3 : 2)
    );
  }
  return parts.join("\n\n");
};

const entryPage = (api: Entry, readmes: ReadonlySet<string>): EntryPage => {
  const slug = `${REFERENCE}/${api.entry}`;
  const readme = `${KIT_SRC}/${api.entry}/README.md`;
  if (readmes.has(readme)) {
    const page = readPage(readme, slug);
    return {
      ...page,
      files: [readme, api.file],
      body: [page.body.trim(), entryApi(api, readme, true)]
        .filter((part) => part !== "")
        .join("\n\n"),
      entry: api.entry,
      readme: true,
      exports: api.exports.length,
    };
  }
  return {
    file: api.file,
    files: [api.file],
    slug,
    link: `/${slug}`,
    title: `arcadekit/${api.entry}`,
    description: firstParagraph(`# _\n\n${entryComment(api)}`),
    body: [entryComment(api), entryApi(api, api.file, false)]
      .filter((part) => part !== "")
      .join("\n\n"),
    entry: api.entry,
    readme: false,
    exports: api.exports.length,
  };
};

const modulePage = (entry: string, module: Module): ModulePage => {
  const slug = `${REFERENCE}/${entry}/${path.posix.basename(module.file, ".ts")}`;
  return {
    file: module.file,
    files: [module.file],
    slug,
    link: `/${slug}`,
    title: module.name,
    description: firstParagraph(`# _\n\n${module.comment}`),
    body: [
      module.comment,
      `\`\`\`ts\nimport { ${module.name} } from "arcadekit/${entry}";\n\`\`\``,
      renderExports(module.exports, 2),
    ].join("\n\n"),
    entry,
    module: module.name,
    exports: module.exports.length,
  };
};

/** The reference: a page for each entry, and one for each of its modules. */
const referencePages = () => {
  const readmes = new Set(
    readdirSync(path.join(REPO_ROOT, KIT_SRC), { recursive: true })
      .map((file) => `${KIT_SRC}/${toPosix(String(file))}`)
      .filter((file) => file.endsWith("/README.md"))
  );
  const api = kitApi();
  const unknown = [...readmes].filter(
    (readme) =>
      !api.some((entry) => readme === `${KIT_SRC}/${entry.entry}/README.md`)
  );
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(", ")} is the README of no entry of the package's exports`
    );
  }
  return {
    entries: api.map((entry) => entryPage(entry, readmes)),
    modules: api.flatMap((entry) =>
      entry.modules.map((module) => modulePage(entry.entry, module))
    ),
  };
};

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  const home: SitePage = {
    file: HOME,
    files: [HOME],
    slug: "index",
    link: "/",
  };
  const docs = docPages();
  const { entries, modules } = referencePages();
  const glossary = readPage(GLOSSARY, "glossary");
  /** The pages read from the repository, which loader.ts adds to the site. */
  const repository: readonly RepositoryPage[] = [
    ...docs,
    ...entries,
    ...modules,
    glossary,
  ];
  const all: readonly SitePage[] = [home, ...repository];

  const files = new Map<string, string>();
  for (const page of all) {
    const taken = files.get(page.slug);
    if (taken !== undefined) {
      throw new Error(
        `${page.file} and ${taken} would both be served at ${page.link}`
      );
    }
    files.set(page.slug, page.file);
  }

  return { home, docs, entries, modules, glossary, repository, all };
};

export type SitePages = ReturnType<typeof discoverPages>;
