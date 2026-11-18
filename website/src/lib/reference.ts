// The reference's index and each package's page, made from the packages' manifests as Effect's
// API reference is (effect.website/docs/v4/api): the index lists the packages under their
// category, each with how many modules it has and its description, and a package's page lists
// its modules. A module's own page is made from its doc comments (api.ts).

/** A package as the reference lists it, from its `package.json`. */
export interface ReferencePackage {
  /** Its folder under `packages/`, such as `three`. */
  readonly folder: string;
  /** Its name on npm, such as `@arcadekit/three`. */
  readonly name: string;
  readonly description: string;
  /** Its modules, each an entry of its `exports` but its own: `Gltf`, `Three`. */
  readonly modules: readonly string[];
}

/** The heading each package is listed under in the index, by its folder, in this order. */
export const PACKAGE_CATEGORIES: Readonly<Record<string, string>> = {
  arcadekit: "Core",
  three: "Rendering",
};

const OTHER = "Other";

/** The heading a package is listed under in the index. */
export const packageCategory = (folder: string): string =>
  PACKAGE_CATEGORIES[folder] ?? OTHER;

const RANK = [...new Set(Object.values(PACKAGE_CATEGORIES)), OTHER];

/** Where a package's page is served. */
export const packageLink = (folder: string) => `/reference/${folder}`;

const modulesCount = (count: number) =>
  `${count} ${count === 1 ? "module" : "modules"}`;

/** The index of the reference: the packages under their categories. */
export const renderIndex = (packages: readonly ReferencePackage[]): string =>
  RANK.flatMap((category) => {
    const listed = packages.filter(
      (item) => packageCategory(item.folder) === category
    );
    return listed.length === 0
      ? []
      : [
          `## ${category}`,
          ...listed.map((item) =>
            [
              `### [${item.name}](${packageLink(item.folder)})`,
              modulesCount(item.modules.length),
              item.description,
            ].join("\n\n")
          ),
        ];
  }).join("\n\n");

/** A package's page: its description, where it is published and written, and its modules. */
export const renderPackage = (
  item: ReferencePackage,
  repoUrl: string,
  branch: string
): string =>
  [
    item.description,
    [
      modulesCount(item.modules.length),
      `[npm](https://www.npmjs.com/package/${item.name})`,
      `[Source](${repoUrl}/tree/${branch}/packages/${item.folder})`,
    ].join(" · "),
    "## Modules",
    item.modules
      .map((name) => `- [${name}](${packageLink(item.folder)}/${name})`)
      .join("\n"),
  ].join("\n\n");
