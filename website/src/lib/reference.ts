// The reference's index and each package's page, made from the packages' manifests as Effect's
// API reference is (effect.website/docs/v4/api): the index lists the packages under their
// category, each with how many modules it has and its description, and a package's page lists
// its modules, under their group when MODULE_GROUPS gives the package groups. A module's own
// page is made from its doc comments (api.ts).

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

/** A group of a package's modules, with the modules listed under it. */
export interface ModuleGroup {
  readonly label: string;
  readonly modules: readonly string[];
}

/**
 * The groups a package's modules are listed under, on its page and in the sidebar, by its folder,
 * in this order, as Effect's reference lists its own: Core, then a group for each subsystem. A
 * package not here lists its modules in one list, and a module its package's groups don't name is
 * listed under Other, last.
 */
export const MODULE_GROUPS: Readonly<Record<string, readonly ModuleGroup[]>> = {
  arcadekit: [
    {
      label: "Core",
      modules: [
        "Action",
        "App",
        "Color",
        "Component",
        "Driver",
        "Event",
        "Field",
        "Grid",
        "Overlap",
        "Plugin",
        "Query",
        "Resource",
        "Schemas",
        "Services",
        "Singleton",
        "State",
        "System",
        "Timer",
        "Transform2d",
        "Transform3d",
        "Vec2",
        "View",
      ],
    },
    { label: "Storage", modules: ["ecs"] },
    {
      label: "Browser",
      modules: ["browser", "browser/Browser", "browser/Audio"],
    },
    { label: "Media", modules: ["Assets", "Input", "Sound"] },
    { label: "Saves", modules: ["Journal", "Migrate", "Save", "Timeline"] },
    {
      label: "Net",
      modules: [
        "net",
        "net/Drift",
        "net/Message",
        "net/Peer",
        "net/Relay",
        "net/Session",
        "net/Transport",
      ],
    },
  ],
  three: [
    { label: "Core", modules: ["Three", "Scene", "Renderer"] },
    { label: "Drawing", modules: ["Instances", "Objects"] },
    { label: "Assets", modules: ["Assets", "Gltf"] },
  ],
};

/**
 * A package's modules by group: each group of MODULE_GROUPS that has a module, with its modules
 * in the package's order, then Other. A package with no groups is one group with no label. A
 * group that names a module the package doesn't have throws, so the groups can't keep a module
 * that is gone.
 */
export const moduleGroups = (
  item: Pick<ReferencePackage, "folder" | "modules">
): readonly { readonly label?: string; readonly modules: string[] }[] => {
  const groups = MODULE_GROUPS[item.folder];
  if (groups === undefined) {
    return [{ modules: [...item.modules] }];
  }
  const named = groups.flatMap((group) => group.modules);
  const missing = named.filter((name) => !item.modules.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `MODULE_GROUPS of website/src/lib/reference.ts names ${missing.join(", ")}, which ${item.folder} doesn't export`
    );
  }
  return [
    ...groups.map((group) => ({
      label: group.label,
      modules: item.modules.filter((name) => group.modules.includes(name)),
    })),
    {
      label: OTHER,
      modules: item.modules.filter((name) => !named.includes(name)),
    },
  ].filter((group) => group.modules.length > 0);
};

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
    ...moduleGroups(item).flatMap((group) => [
      ...(group.label === undefined ? [] : [`### ${group.label}`]),
      group.modules
        .map((name) => `- [${name}](${packageLink(item.folder)}/${name})`)
        .join("\n"),
    ]),
  ].join("\n\n");
