// Which files of the repository are pages of the site, and where each one is served.
//
// The site has one page of its own, the landing page (src/content/docs/index.mdx). Every other
// page is a file that already exists for GitHub and npm, read where it is (loader.ts):
// - each entry's README, `packages/arcadekit/src/<entry>/README.md`, at `/<entry>`, so a page's
//   address is its import path (`arcadekit/net/worker` is `/net/worker`);
// - the glossary, `CONTEXT.md`, at `/glossary`.
// READMEs are found by walking `src/`, so a new entry's README is a page without a change here.
// An entry with no README has no page: its address goes to the page of the folder above it
// (`/net/browser` to `/net`), until it gets a README.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, WEBSITE_DIR } from "./site.ts";

const KIT_MANIFEST = "packages/arcadekit/package.json";
const KIT_SRC = "packages/arcadekit/src";
const GLOSSARY = "CONTEXT.md";
const HOME = `${WEBSITE_DIR}/src/content/docs/index.mdx`;

/**
 * The package's README. It has no page of its own: the landing page includes it, after its title
 * and first paragraph (landing.ts).
 */
export const PACKAGE_README = "packages/arcadekit/README.md";

/** A page of the site. Paths are relative to the repository's root. */
export interface SitePage {
  /** The markdown file, such as `packages/arcadekit/src/net/worker/README.md`. */
  readonly file: string;
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

export interface EntryPage extends RepositoryPage {
  /** The entry's folder under `src/`, such as `net/worker`: its import path after `arcadekit/`. */
  readonly entry: string;
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
    slug,
    link: `/${slug}`,
    title,
    description: firstParagraph(markdown),
    body,
  };
};

/** Every `README.md` under a folder of the repository, however deep, but not the folder's own. */
const readmesUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { recursive: true })
    .map((file) => toPosix(String(file)))
    .filter((file) => file.endsWith("/README.md"))
    .toSorted();

const entryPages = (): EntryPage[] =>
  readmesUnder(KIT_SRC).map((readme) => {
    const entry = path.posix.dirname(readme);
    return { ...readPage(`${KIT_SRC}/${readme}`, entry), entry };
  });

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  const home: SitePage = { file: HOME, slug: "index", link: "/" };
  const entries = entryPages();
  const glossary = readPage(GLOSSARY, "glossary");
  /** The pages read from the repository's own markdown, which loader.ts adds to the site. */
  const repository: readonly RepositoryPage[] = [...entries, glossary];
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

  return { home, entries, glossary, repository, all };
};

export type SitePages = ReturnType<typeof discoverPages>;

/** An address with no page of its own, and the page that answers for it. */
export interface Redirect {
  readonly from: string;
  readonly to: string;
}

/**
 * Where the address of each entry with no README goes. A page's address is its import path, so
 * a reader may type `/net/browser` for `arcadekit/net/browser`, which `src/net/README.md`
 * documents: it goes to `/net`, the page of the nearest folder above that has one, or to the
 * landing page, which lists every entry. The entries are the package's `exports`, so an entry
 * that gets a README of its own stops being redirected.
 */
export const entryRedirects = (pages: SitePages): Redirect[] => {
  const { exports } = JSON.parse(read(KIT_MANIFEST)) as {
    readonly exports: Readonly<Record<string, unknown>>;
  };
  const links = new Set(pages.entries.map((page) => page.link));
  const redirects: Redirect[] = [];
  for (const subpath of Object.keys(exports)) {
    // An entry is `./net/browser`. `.`, `./package.json` and a pattern are not.
    const from = subpath.slice(1);
    if (!/^(?:\/[\w-]+)+$/u.test(from) || links.has(from)) {
      continue;
    }
    let to = path.posix.dirname(from);
    while (to !== "/" && !links.has(to)) {
      to = path.posix.dirname(to);
    }
    redirects.push({ from, to });
  }
  return redirects;
};
