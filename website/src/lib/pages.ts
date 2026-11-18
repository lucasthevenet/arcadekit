// Which files are pages of the site, and where each one is served.
//
// - The site's own pages, under src/content/docs/: the landing page, the walkthrough, the concepts
//   and the guides, each at its path there (`guides/input.md` at `/guides/input`). They are
//   Starlight's own pages, with a frontmatter, and Starlight's loader reads them.
// - Each package's README, read where it is (loader.ts), at `/reference/<package>`:
//   `packages/arcadekit/README.md` at `/reference/arcadekit`. It is a package's overview, and npm
//   shows it too.
// - Each module of a package, at `/reference/<package>/<Module>`, made from its doc comments
//   (api.ts): `arcadekit/Sound` at `/reference/arcadekit/Sound`.
// The folders are read whole, so a new page or a new package is a page without a change here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, WEBSITE_DIR } from "./site.ts";

/** The site's own pages, relative to the repository's root. */
const SITE_DOCS = `${WEBSITE_DIR}/src/content/docs`;
const PACKAGES = "packages";
/** Where the packages' pages are served: a package's page is this, then its folder's name. */
const REFERENCE = "reference";
const HOME = `${WEBSITE_DIR}/src/content/docs/index.mdx`;

/** A page of the site. Paths are relative to the repository's root. */
export interface SitePage {
  /** The file it is written in, such as `website/src/content/docs/guides/input.md`. Its relative links are read from where it is. */
  readonly file: string;
  /** Its id in Starlight's `docs` collection, which is its address without the slash: `guides/input`. */
  readonly slug: string;
  /** Its address on the site, such as `/guides/input`. */
  readonly link: string;
}

/** A page whose file is the repository's own markdown, written for GitHub. */
export interface RepositoryPage extends SitePage {
  /** The file's `# ` heading, its first line, such as `Input`. */
  readonly title: string;
  /** Its first paragraph as plain text, for the page's description. Empty if it has none. */
  readonly description: string;
  /** Its markdown after the title, which the page renders below the title Starlight writes. */
  readonly body: string;
}

/** A page of the docs: the walkthrough, a concept or a guide. */
export interface DocPage extends SitePage {
  /**
   * Its top folder under src/content/docs/, such as `guides`, or `""` for a file directly in it.
   */
  readonly section: string;
}

/** The README of a package of the repository, such as `@arcadekit/three`. */
export interface PackagePage extends RepositoryPage {
  /** Its folder under `packages/`, such as `three`. */
  readonly folder: string;
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

/** Every markdown file under a folder of the repository, however deep. */
const markdownUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { recursive: true })
    .map((file) => toPosix(String(file)))
    .filter((file) => file.endsWith(".md"))
    .toSorted();

/** The site's own pages but the landing page: the walkthrough, the concepts and the guides. */
const sitePages = (): DocPage[] =>
  markdownUnder(SITE_DOCS).map((file) => {
    const slug = file.replace(/\.md$/u, "");
    const section = file.includes("/") ? (file.split("/", 1)[0] ?? "") : "";
    return { file: `${SITE_DOCS}/${file}`, slug, link: `/${slug}`, section };
  });

/** Each package's README, at `/reference/<folder>`. */
const packagePages = (): PackagePage[] =>
  readdirSync(path.join(REPO_ROOT, PACKAGES))
    .toSorted()
    .filter((folder) =>
      existsSync(path.join(REPO_ROOT, PACKAGES, folder, "README.md"))
    )
    .map((folder) => ({
      ...readPage(`${PACKAGES}/${folder}/README.md`, `${REFERENCE}/${folder}`),
      folder,
    }));

/** A module of a package, whose page is made from its doc comments (api.ts). */
export interface ModulePage extends SitePage {
  /** The module's name, as a game imports it: `Sound`. */
  readonly name: string;
  /** Its package's folder under `packages/`, such as `arcadekit`, and the package's name. */
  readonly folder: string;
  readonly packageName: string;
}

/**
 * Each module of each package, at `/reference/<folder>/<Module>`: every entry its `package.json`
 * exports but the package's own. `file` is the module's source, which its edit link opens.
 */
const modulePages = (packages: readonly PackagePage[]): ModulePage[] =>
  packages.flatMap((page) => {
    const manifest = JSON.parse(
      read(`${PACKAGES}/${page.folder}/package.json`)
    ) as {
      readonly name: string;
      readonly exports?: Record<string, { readonly source?: string }>;
    };
    return Object.entries(manifest.exports ?? {})
      .filter(([key, entry]) => key !== "." && entry.source !== undefined)
      .map(([key, entry]) => {
        const name = key.replace(/^\.\//u, "");
        const slug = `${REFERENCE}/${page.folder}/${name}`;
        return {
          file: `${PACKAGES}/${page.folder}/${String(entry.source).replace(/^\.\//u, "")}`,
          slug,
          link: `/${slug}`,
          name,
          folder: page.folder,
          packageName: manifest.name,
        };
      });
  });

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  const home: SitePage = { file: HOME, slug: "index", link: "/" };
  /** The pages of the Learn and Guides topics. */
  const docs: readonly DocPage[] = sitePages();
  const packages = packagePages();
  /** The pages read from the repository, which loader.ts adds to the site. */
  const repository: readonly RepositoryPage[] = packages;
  const all: readonly SitePage[] = [home, ...docs, ...packages];
  /** The modules' pages, made from their doc comments by the loader. */
  const modules = modulePages(packages);

  const files = new Map<string, string>();
  for (const page of [...all, ...modules]) {
    const taken = files.get(page.slug);
    if (taken !== undefined) {
      throw new Error(
        `${page.file} and ${taken} would both be served at ${page.link}`
      );
    }
    files.set(page.slug, page.file);
  }

  return { home, docs, packages, modules, repository, all };
};

export type SitePages = ReturnType<typeof discoverPages>;
