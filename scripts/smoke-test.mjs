// The pack-and-install smoke test (ADR-0018). Builds the arcadekit package, packs it, installs
// the tarball with its peer libraries into a throwaway project outside the workspace, and
// there:
// - typechecks a tiny game (scripts/smoke/) and every `ts` example in the entries' READMEs
//   (packages/arcadekit/src/<entry>/README.md), with TypeScript 5.9 and with the workspace's
//   TypeScript 7. arcadekit/net/worker's examples are a project of their own
//   (tsconfig.worker.json), checked with Cloudflare's Workers types and no DOM;
// - builds the game with Vite;
// - checks that exactly one copy of effect and of three is installed.
//
//   pnpm smoke            build, then test
//   pnpm smoke --no-build test the package already built
//   pnpm smoke --keep     leave the throwaway project in place, and print where it is
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The folders of src/ that have a README: one for each entry and its subpaths.
const ENTRIES = [
  "core",
  "input",
  "content",
  "save",
  "audio",
  "render-three",
  "runtime",
  "net",
  "foldkit",
];

// The entry that runs on Cloudflare, with a README of its own: its examples are a Worker's.
const WORKER_ENTRY = "net/worker";

const root = path.resolve(import.meta.dirname, "..");
const packageDir = path.join(root, "packages", "arcadekit");
const args = new Set(process.argv.slice(2));

const run = (command, commandArgs, cwd) => {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });
};

const output = (command, commandArgs, cwd) =>
  execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));

/** The version range arcadekit asks for, from its peerDependencies. */
const peerRange = (name) => {
  const range = readJson(path.join(packageDir, "package.json"))
    .peerDependencies?.[name];
  if (range === undefined) {
    throw new Error(`arcadekit has no ${name} peer dependency`);
  }
  return range;
};

/** The version installed in the workspace, such as the root's TypeScript. */
const workspaceVersion = (name) =>
  readJson(path.join(root, "node_modules", name, "package.json")).version;

/** Each ```ts block in a README, in order. */
const examples = (readme) =>
  [...readme.matchAll(/^```ts\n(?<code>[\s\S]*?)^```$/gmu)].map(
    (match) => match.groups.code
  );

if (!args.has("--no-build")) {
  run("pnpm", ["build:packages"], root);
}

const work = mkdtempSync(path.join(tmpdir(), "arcadekit-smoke-"));
let passed = false;
try {
  const tarballs = path.join(work, "tarballs");
  const project = path.join(work, "game");
  mkdirSync(tarballs);
  mkdirSync(project);

  const packed = output(
    "pnpm",
    ["pack", "--pack-destination", tarballs],
    packageDir
  )
    .trim()
    .split("\n");
  const tarball = packed.at(-1).trim();

  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "arcadekit-smoke",
        private: true,
        type: "module",
        dependencies: {
          arcadekit: `file:${tarball}`,
          "@effect/platform-browser": peerRange("@effect/platform-browser"),
          effect: peerRange("effect"),
          foldkit: peerRange("foldkit"),
          three: peerRange("three"),
        },
        devDependencies: {
          "@cloudflare/workers-types": peerRange("@cloudflare/workers-types"),
          "@types/three": peerRange("@types/three"),
          typescript5: "npm:typescript@~5.9.0",
          typescript7: `npm:typescript@${workspaceVersion("typescript")}`,
          vite: readJson(path.join(root, "package.json")).devDependencies.vite,
        },
      },
      null,
      2
    )}\n`
  );
  cpSync(path.join(root, "scripts", "smoke"), project, { recursive: true });

  const readmes = path.join(project, "src", "readme");
  const workerReadmes = path.join(project, "worker", "readme");
  mkdirSync(readmes);
  mkdirSync(workerReadmes, { recursive: true });
  let exampleCount = 0;
  for (const dir of [...ENTRIES, WORKER_ENTRY]) {
    const readme = path.join(packageDir, "src", dir, "README.md");
    if (!existsSync(readme)) {
      throw new Error(`packages/arcadekit/src/${dir} has no README.md`);
    }
    for (const [index, code] of examples(
      readFileSync(readme, "utf-8")
    ).entries()) {
      // `export {}` makes each example a module, so their names don't clash.
      writeFileSync(
        path.join(
          dir === WORKER_ENTRY ? workerReadmes : readmes,
          `${dir.replaceAll("/", "-")}-${index + 1}.ts`
        ),
        `${code}\nexport {};\n`
      );
      exampleCount += 1;
    }
  }
  console.log(`\n${exampleCount} README examples copied into the project.`);

  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    project
  );

  for (const ts of ["typescript5", "typescript7"]) {
    const { version } = readJson(
      path.join(project, "node_modules", ts, "package.json")
    );
    console.log(`\nTypeScript ${version}`);
    for (const tsconfig of [".", "tsconfig.worker.json"]) {
      run(
        process.execPath,
        [path.join("node_modules", ts, "bin", "tsc"), "-p", tsconfig],
        project
      );
    }
  }

  run(
    process.execPath,
    [
      path.join("node_modules", "vite", "bin", "vite.js"),
      "build",
      "--logLevel",
      "warn",
    ],
    project
  );
  if (!existsSync(path.join(project, "dist", "index.html"))) {
    throw new Error("Vite wrote no dist/index.html");
  }

  for (const name of ["effect", "three"]) {
    const copies = new Set(
      JSON.parse(output("npm", ["query", `#${name}`], project)).map(
        (node) => node.realpath ?? node.path
      )
    );
    if (copies.size !== 1) {
      throw new Error(
        `Expected one copy of ${name}, found ${copies.size}:\n${[...copies].join("\n")}`
      );
    }
    console.log(`One copy of ${name}.`);
  }

  const kitCopies = JSON.parse(
    output("npm", ["query", "#arcadekit"], project)
  ).length;
  if (kitCopies !== 1) {
    throw new Error(`Expected arcadekit installed once, found ${kitCopies}`);
  }
  passed = true;
} finally {
  if (args.has("--keep")) {
    console.log(`\nKept the throwaway project in ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}

if (passed) {
  console.log(
    "\nSmoke test passed: arcadekit packed, installed, typechecked with TypeScript 5.9 and 7, built with Vite."
  );
}
