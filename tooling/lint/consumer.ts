// What a program that installs the packed packages gets, beyond what publint and attw look at.
// tooling/lint/packages.sh unpacks the tarballs into `node_modules` of a folder, passes it here,
// and then compiles the files this writes into it, against dist/, without the `source` condition.
//
// An entry's member named after another entry, the index's `Transform3d` beside
// `arcadekit/Transform3d` or `net`'s `Message` beside `arcadekit/net/Message`, is that entry: the
// same module at run time, and a value of its module's type (#389).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = path.resolve(process.argv[2] ?? ".");
const resolve = createRequire(path.join(dir, "package.json")).resolve;
const load = (specifier: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(resolve(specifier)).href);

const problems: string[] = [];
const checks: string[] = [];
for (const name of ["arcadekit", "@arcadekit/three"]) {
  const pkg: { readonly exports: Readonly<Record<string, unknown>> } =
    JSON.parse(
      readFileSync(
        path.join(dir, "node_modules", name, "package.json"),
        "utf-8"
      )
    );
  const subpaths = new Set(Object.keys(pkg.exports));
  const specifier = (subpath: string): string =>
    subpath === "." ? name : `${name}/${subpath.slice("./".length)}`;
  for (const subpath of subpaths) {
    const entry = await load(specifier(subpath));
    for (const [member, value] of Object.entries(entry)) {
      const own = `${subpath}/${member}`;
      if (!subpaths.has(own)) {
        continue;
      }
      if (value !== (await load(specifier(own)))) {
        problems.push(
          `${specifier(subpath)}: ${member} is not the module ${specifier(own)}`
        );
      }
      const i = checks.length;
      checks.push(
        `import { ${member} as E${i} } from "${specifier(subpath)}";
import type * as M${i} from "${specifier(own)}";
export const m${i}: typeof M${i} = E${i};`
      );
    }
  }
}

writeFileSync(path.join(dir, "members.ts"), `${checks.join("\n")}\n`);
writeFileSync(
  path.join(dir, "transform.ts"),
  `import { Component, Transform2d, Transform3d } from "arcadekit";
import { Three } from "@arcadekit/three";
import { BoxGeometry, MeshBasicMaterial } from "three";

const geometry = new BoxGeometry();
const material = new MeshBasicMaterial();
const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] });
const Card = Component.tag("game/Card", { requires: [Transform2d.Position] });

export const rocks = Three.instances("game/Rocks", { of: Rock, transform: Transform3d, geometry, material });
export const cards = Three.instances("game/Cards", { of: Card, transform: Transform2d, geometry, material });
`
);
writeFileSync(
  path.join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2023", "DOM"],
      types: [],
      strict: true,
      noEmit: true,
    },
    files: ["members.ts", "transform.ts"],
  })
);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
