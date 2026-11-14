// Which files of the repository are pages of the site, and where each one is served.
//
// The site has no markdown of its own beyond the landing page. Every other page is a file that
// already exists for GitHub and npm, read where it is:
// - each entry's README, `packages/arcadekit/src/<entry>/README.md`, at `/<entry>`, so a page's
//   address is its import path (`arcadekit/net/worker` is `/net/worker`);
// - the glossary, `CONTEXT.md`, at `/glossary`.
// READMEs are found by walking `src/`, so a new entry's README is a page without a change here.
// An entry with no README has no page: its address goes to the page of the folder above it
// (`/net/browser` to `/net`), until it gets a README.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The repository's root: VitePress's `srcDir`, so pages are read in place. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const KIT_MANIFEST = "packages/arcadekit/package.json";
const KIT_SRC = "packages/arcadekit/src";
const GLOSSARY = "CONTEXT.md";
const HOME = "apps/docs/index.md";

/**
 * The package's README. It has no page of its own: the landing page includes it, from line
 * {@link PACKAGE_README_INCLUDED_FROM} on.
 */
export const PACKAGE_README = "packages/arcadekit/README.md";

/**
 * The line of the package's README the landing page includes it from (`{5,}` in index.md): the
 * one after its title and its first paragraph, which the landing page's own top replaces.
 */
const PACKAGE_README_INCLUDED_FROM = 5;

/** The heading of the package's README that the landing page's "Get started" button goes to. */
const PACKAGE_README_INSTALL = "## Install";

/** A file of the repository served as a page. Paths are relative to the repository's root. */
export interface SitePage {
  /** The markdown file, such as `packages/arcadekit/src/net/worker/README.md`. */
  readonly file: string;
  /** The file VitePress serves it as, such as `net/worker.md`. */
  readonly servedAs: string;
  /** Its address on the site, such as `/net/worker`. */
  readonly link: string;
  /** Its first paragraph as plain text, for the page's description. Empty if it has none. */
  readonly description: string;
}

export interface EntryPage extends SitePage {
  /** The entry's folder under `src/`, such as `net/worker`: its import path after `arcadekit/`. */
  readonly entry: string;
  /** The README's first heading, such as `arcadekit/net/worker`. */
  readonly title: string;
}

const toPosix = (file: string) => file.split(path.sep).join("/");

const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** The text of a markdown file's first `# ` heading. */
const firstHeading = (markdown: string, file: string): string => {
  const heading = /^# (?<title>.+)$/mu.exec(markdown)?.groups?.title;
  if (heading === undefined) {
    throw new Error(`${file} has no "# " heading to use as its page title`);
  }
  return heading.trim();
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

/** Every `README.md` under a folder of the repository, however deep, but not the folder's own. */
const readmesUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { recursive: true })
    .map((file) => toPosix(String(file)))
    .filter((file) => file.endsWith("/README.md"))
    .toSorted();

const entryPages = (): EntryPage[] =>
  readmesUnder(KIT_SRC).map((readme) => {
    const entry = path.posix.dirname(readme);
    const file = `${KIT_SRC}/${readme}`;
    const markdown = read(file);
    return {
      file,
      servedAs: `${entry}.md`,
      link: `/${entry}`,
      description: firstParagraph(markdown),
      entry,
      title: firstHeading(markdown, file),
    };
  });

/**
 * Fails if the package's README no longer has what the landing page takes from it:
 * - its top is a title, a blank line, one paragraph and a blank line, since the landing page
 *   includes the README by line number, after those four;
 * - it has an "Install" heading, where the landing page's "Get started" button goes (`#install`).
 */
const checkPackageReadme = () => {
  const lines = read(PACKAGE_README).split("\n");
  const [title = "", afterTitle, paragraph = "", afterParagraph] = lines.slice(
    0,
    PACKAGE_README_INCLUDED_FROM - 1
  );
  if (
    !title.startsWith("# ") ||
    afterTitle !== "" ||
    paragraph === "" ||
    paragraph.startsWith("#") ||
    afterParagraph !== ""
  ) {
    throw new Error(
      `${HOME} includes ${PACKAGE_README} from line ${PACKAGE_README_INCLUDED_FROM} on, after its title and its first paragraph. The README no longer starts that way: change the range in ${HOME} and PACKAGE_README_INCLUDED_FROM in apps/docs/.vitepress/pages.ts.`
    );
  }
  if (!lines.includes(PACKAGE_README_INSTALL)) {
    throw new Error(
      `The "Get started" button of ${HOME} goes to #install, the "${PACKAGE_README_INSTALL}" heading of ${PACKAGE_README}. The README no longer has that heading: change the button's link in ${HOME} and PACKAGE_README_INSTALL in apps/docs/.vitepress/pages.ts.`
    );
  }
};

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  checkPackageReadme();
  const entries = entryPages();
  const home: SitePage = {
    file: HOME,
    servedAs: "index.md",
    link: "/",
    description: "",
  };
  const glossary: SitePage = {
    file: GLOSSARY,
    servedAs: "glossary.md",
    link: "/glossary",
    description: firstParagraph(read(GLOSSARY)),
  };
  const all: readonly SitePage[] = [home, ...entries, glossary];

  const sources = new Map<string, string>();
  for (const page of all) {
    const taken = sources.get(page.servedAs);
    if (taken !== undefined) {
      throw new Error(
        `${page.file} and ${taken} would both be served at ${page.link}`
      );
    }
    sources.set(page.servedAs, page.file);
  }

  return { home, entries, glossary, all };
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

// VitePress finds its pages with the same walk: every `.md` under `srcDir`, skipping
// `node_modules`, `dist` and anything whose name starts with a dot.
const markdownFilesUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap(
    (item) => {
      const file = dir === "" ? item.name : `${dir}/${item.name}`;
      if (item.name.startsWith(".")) {
        return [];
      }
      if (item.isDirectory()) {
        return item.name === "node_modules" || item.name === "dist"
          ? []
          : markdownFilesUnder(file);
      }
      return item.name.endsWith(".md") ? [file] : [];
    }
  );

/** A path as a glob that matches only itself. */
const escapeGlob = (file: string) =>
  file.replaceAll(/[\\*?[\]{}()!+@]/gu, String.raw`\$&`);

/**
 * Every markdown file of the repository that is not a page, for VitePress's `srcExclude`.
 * VitePress would otherwise serve each one, since its source folder is the whole repository.
 */
export const markdownThatIsNotAPage = (pages: SitePages): string[] => {
  const served = new Set(pages.all.map((page) => page.file));
  return markdownFilesUnder("")
    .filter((file) => !served.has(file))
    .map(escapeGlob);
};
