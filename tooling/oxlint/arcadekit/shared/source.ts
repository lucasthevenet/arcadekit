import { packages } from "./entries.ts";
import type { PackageRules } from "./entries.ts";

/** The package a file is a source of, and its path in that package. */
export const sourceOf = (
  filename: string
): { readonly rules: PackageRules; readonly file: string } | undefined => {
  const match = /(?:^|\/)packages\/([^/]+)\/(src\/.+)$/u.exec(
    filename.replaceAll("\\", "/")
  );

  const rules = packages.find((one) => one.dir === match?.[1]);

  return match === null || rules === undefined
    ? undefined
    : { rules, file: match[2]! };
};

/** Where a relative specifier leads, from a file: "src/ecs/world.ts" and "../App" give "src/App". */
export const resolve = (file: string, specifier: string): string => {
  const parts = file.split("/").slice(0, -1);

  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/");
};
