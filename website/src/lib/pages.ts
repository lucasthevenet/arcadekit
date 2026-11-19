// Which files are pages of the site, and where each one is served.
//
// - The site's own pages, under src/content/docs/: the landing page, the walkthrough, the concepts
//   and the guides, each at its path there (`guides/input.md` at `/guides/input`). They are
//   Starlight's own pages, with a frontmatter, and Starlight's loader reads them.
// - The reference: its index at `/reference`, and each package's page at `/reference/<package>`,
//   made from its `package.json` (reference.ts), with its description and its modules.
// - Each module of a package, at `/reference/<package>/<Module>`, made from its doc comments
//   (api.ts): `arcadekit/Sound` at `/reference/arcadekit/Sound`.
// The folders are read whole, so a new page or a new package is a page without a change here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ReferencePackage } from "./reference.ts";
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

/** A page the loader adds to the site, with its markdown made by the site's code. */
export interface LoadedPage extends SitePage {
  readonly title: string;
  /** Its description, the line under a shared link. Empty if it has none. */
  readonly description: string;
  /** Its markdown, which the page renders below the title Starlight writes. */
  readonly body: string;
}

/** A page of the docs: the walkthrough, a concept or a guide. */
export interface DocPage extends SitePage {
  /**
   * Its top folder under src/content/docs/, such as `guides`, or `""` for a file directly in it.
   */
  readonly section: string;
}

/** A package's page in the reference, made from its `package.json`. */
export interface PackagePage extends SitePage, ReferencePackage {
  /** Its name, as npm has it: `@arcadekit/three`. */
  readonly title: string;
}

const toPosix = (file: string) => file.split(path.sep).join("/");

const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

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

interface Manifest {
  readonly name: string;
  readonly description?: string;
  readonly exports?: Record<string, { readonly source?: string }>;
}

const manifestOf = (folder: string): Manifest =>
  JSON.parse(read(`${PACKAGES}/${folder}/package.json`)) as Manifest;

/** Its entries but its own, each a module: `./Sound` with its source. */
const entriesOf = (manifest: Manifest) =>
  Object.entries(manifest.exports ?? {})
    .filter(([key, entry]) => key !== "." && entry.source !== undefined)
    .map(([key, entry]) => ({
      name: key.replace(/^\.\//u, ""),
      source: String(entry.source).replace(/^\.\//u, ""),
    }));

/** Each package that exports a module, at `/reference/<folder>`. */
const packagePages = (): PackagePage[] =>
  readdirSync(path.join(REPO_ROOT, PACKAGES))
    .toSorted()
    .filter((folder) =>
      existsSync(path.join(REPO_ROOT, PACKAGES, folder, "package.json"))
    )
    .flatMap((folder) => {
      const manifest = manifestOf(folder);
      const modules = entriesOf(manifest).map((entry) => entry.name);

      if (modules.length === 0) {
        return [];
      }

      const slug = `${REFERENCE}/${folder}`;

      return [
        {
          file: `${PACKAGES}/${folder}/package.json`,
          slug,
          link: `/${slug}`,
          folder,
          name: manifest.name,
          title: manifest.name,
          description: manifest.description ?? "",
          modules,
        },
      ];
    });

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
  packages.flatMap((page) =>
    entriesOf(manifestOf(page.folder)).map(({ name, source }) => {
      const slug = `${REFERENCE}/${page.folder}/${name}`;

      return {
        file: `${PACKAGES}/${page.folder}/${source}`,
        slug,
        link: `/${slug}`,
        name,
        folder: page.folder,
        packageName: page.name,
      };
    })
  );

/** Every page of the site, found on disk. */
export const discoverPages = () => {
  const home: SitePage = { file: HOME, slug: "index", link: "/" };
  /** The pages of the Learn and Guides topics. */
  const docs: readonly DocPage[] = sitePages();
  const packages = packagePages();

  /** The reference's index, which lists the packages. */
  const reference: SitePage = {
    file: `${WEBSITE_DIR}/src/lib/reference.ts`,
    slug: REFERENCE,
    link: `/${REFERENCE}`,
  };

  const all: readonly SitePage[] = [home, ...docs, reference, ...packages];
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

  return { home, docs, reference, packages, modules, all };
};

export type SitePages = ReturnType<typeof discoverPages>;
