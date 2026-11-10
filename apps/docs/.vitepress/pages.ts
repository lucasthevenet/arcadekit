// Which files of the repository are pages of the site, and where each one is served.
//
// The site has no markdown of its own beyond the landing page and the index of decisions. Every
// other page is a file that already exists for GitHub and npm, read where it is:
// - each entry's README, `packages/arcadekit/src/<entry>/README.md`, at `/<entry>`, so a page's
//   address is its import path (`arcadekit/net/worker` is `/net/worker`);
// - the glossary, `CONTEXT.md`, at `/glossary`;
// - each decision, `docs/adr/<name>.md`, at `/adr/<name>`.
// READMEs are found by walking `src/`, so a new entry's README is a page without a change here.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The repository's root: VitePress's `srcDir`, so pages are read in place. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const KIT_SRC = "packages/arcadekit/src";
const ADR_DIR = "docs/adr";
const GLOSSARY = "CONTEXT.md";
const HOME = "apps/docs/index.md";
const ADR_INDEX = "apps/docs/adr.md";

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

export interface AdrPage extends SitePage {
  /** The decision's number, such as `0018`. */
  readonly number: string;
  /** The file's first heading: the decision in a sentence. */
  readonly title: string;
  /** The `status` in the file's frontmatter, such as `accepted`. */
  readonly status: string;
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

/** The first paragraph after the title, cut at the end of a sentence if it is long. */
export const firstParagraph = (markdown: string): string => {
  const afterTitle = markdown.slice(markdown.search(/^# /mu));
  const [, ...blocks] = afterTitle.split(/\n{2,}/u);
  const paragraph = plainText(
    blocks.find((block) => /^[\p{L}`*[]/u.test(block)) ?? ""
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

const adrPages = (): AdrPage[] =>
  readdirSync(path.join(REPO_ROOT, ADR_DIR))
    .filter((name) => /^\d{4}-.+\.md$/u.test(name))
    .toSorted()
    .map((name) => {
      const file = `${ADR_DIR}/${name}`;
      const markdown = read(file);
      return {
        file,
        servedAs: `adr/${name}`,
        link: `/adr/${name.slice(0, -".md".length)}`,
        description: firstParagraph(markdown),
        number: name.slice(0, 4),
        title: firstHeading(markdown, file),
        status:
          /^status:\s*(?<status>.+)$/mu.exec(markdown)?.groups?.status ?? "",
      };
    });

/**
 * Fails if the top of the package's README is no longer a title, a blank line, one paragraph and
 * a blank line: the landing page includes the README by line number, after those four.
 */
const checkPackageReadmeTop = () => {
  const [title = "", afterTitle, paragraph = "", afterParagraph] = read(
    PACKAGE_README
  )
    .split("\n")
    .slice(0, PACKAGE_README_INCLUDED_FROM - 1);
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
};

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  checkPackageReadmeTop();
  const entries = entryPages();
  const adrs = adrPages();
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
  const adrIndex: SitePage = {
    file: ADR_INDEX,
    servedAs: "adr.md",
    link: "/adr",
    description: "",
  };
  const all: readonly SitePage[] = [
    home,
    ...entries,
    glossary,
    adrIndex,
    ...adrs,
  ];

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

  return { home, entries, glossary, adrIndex, adrs, all };
};

export type SitePages = ReturnType<typeof discoverPages>;

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
