import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "./plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const outside = `import { HashMap } from "effect";
import * as HashSet from "effect/HashSet";
let n = 0;
const cache = new Map();
const list = [];
const obj = { a: { b: 0 } };
`;

const kinds = {
  "System.tick": (body: string) =>
    `System.tick("Move", function* () {\n${body}\n});`,
  "State.onEnter": (body: string) =>
    `State.onEnter(Phase, "play", "Enter", function* () {\n${body}\n});`,
  "State.onExit": (body: string) =>
    `State.onExit(Phase, "play", "Exit", function* () {\n${body}\n});`,
  "Action.handler": (body: string) =>
    `Action.handler(Go, function* (payload) {\n${body}\n});`,
  "Plugin.make's setup": (body: string) =>
    `Plugin.make("P", { setup: Effect.gen(function* () {\n${body}\n}) });`,
};

const changesOutside = [
  "n++;",
  "n += 1;",
  "n = 2;",
  "cache.set(1, 2);",
  "list.push(1);",
  "obj.a.b = 1;",
  "delete obj.a;",
  "const later = () => { n++; };",
];

const changesNothingOutside = [
  "let m = 0; m++; const own = []; own.push(1);",
  "const later = () => { let k = 0; k++; const own = new Map(); own.set(1, 2); };",
  "const map = HashMap.set(HashMap.empty(), 1, 2); HashSet.add(HashSet.empty(), 1);",
  "const read = cache.get(1) + list.length + obj.a.b + n;",
];

new RuleTester().run("no-outside-state", plugin.rules["no-outside-state"], {
  valid: [
    ...Object.entries(kinds).flatMap(([kind, wrap]) =>
      changesNothingOutside.map((body: string) => ({
        name: `${kind}: ${body}`,
        code: outside + wrap(body),
      }))
    ),
    {
      name: "an action's handler changes its payload",
      code: outside + kinds["Action.handler"]("payload = 1; payload.x = 1;"),
    },
    {
      name: "code that is not the tick's changes what is outside it",
      code: `${outside}function plain() {\n${changesOutside.join("\n")}\n}\nEffect.gen(function* () { n++; list.push(1); });`,
    },
  ],
  invalid: Object.entries(kinds).flatMap(([kind, wrap]) =>
    changesOutside.map((body: string) => ({
      name: `${kind}: ${body}`,
      code: outside + wrap(body),
      errors: [
        {
          message:
            /^This changes (n|cache|list|obj), which is declared outside the code of the tick/u,
        },
      ],
    }))
  ),
});
