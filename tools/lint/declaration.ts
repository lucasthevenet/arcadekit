// An oxlint JS plugin (ESLint's plugin shape) for how a declaration is written (ADR-0020):
//
//   export class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
//
// docs/code-style.md is the style. These rules hold the part of it that one file shows.
//
// For the code of a game (a genre package, an app):
//
// - `declaration/named`: the class and the string have the same name. The string is what the
//   run uses (an event's `_tag`, a service's key); the class is what the code and its readers
//   use. A typo in one of them is a part with two names. A class that extends a declaration is
//   a second class under the first one's name.
// - `declaration/class`: a builder is called to be extended, and nowhere else. A
//   `const LevelSolved = Game.Event(...)` runs, but it names no type, so the file grows a
//   `type LevelSolved = ...` beside it and the part is declared twice.
// - `declaration/inferred`: a builder is given no type argument. Its types come from the
//   definition; a type argument is how a definition that doesn't infer gets papered over.
// - `declaration/plain-handler`: a function in a definition is not `async` and not a generator.
//   Its host calls it and goes on.
// - `declaration/older-contract`: nothing new imports the contract the declarations replace.
//
// A builder is found by what the file imports, under whatever name it gave it: `Game.Event`,
// `G.Event`, or `Event` imported by name. A function that is only called `Content` is no
// builder.
//
// For the kit's own source:
//
// - `declaration/builder`: a function that returns a class is a builder, and has a builder's
//   shape: the name first, typed by a type parameter; `kind` and the name as statics; its return type
//   written out as `<Noun>Class`, an interface of the same file with the statics the class has.
//
// packages/arcadekit/test/style.test.ts checks what takes more than one file: that every
// builder is listed here, has its docs and is declared by a test.
import path from "node:path";

/** The kit's declaration builders, as a game's code writes each. */
export const DECLARATION_BUILDERS: readonly string[] = [
  "Game.Event",
  "Game.Command",
  "Game.Rejection",
  "Game.Simulation",
  "Game.Engine",
  "Content",
  "Asset",
  "Coop",
];

/** How a game names the entries whose builders it writes with a namespace: `Game.Event`. */
const NAMESPACE = "Game";

/**
 * The entries a game imports builders from, each with whether its builders are written with the
 * namespace (`Game.Event`) or bare (`Content`). The style test checks each exports them.
 */
export const BUILDER_ENTRIES: Readonly<Record<string, "namespace" | "bare">> = {
  "arcadekit/game": "namespace",
  "arcadekit/game/browser": "namespace",
  "arcadekit/content": "bare",
  "arcadekit/net/browser": "bare",
};

/** The same entries by their public file from the kit's src/, as the kit's own files import them. */
const KIT_SRC = "packages/arcadekit/src/";
const KIT_ENTRY_FILES: Readonly<Record<string, string>> = {
  "game/index": "arcadekit/game",
  "game/browser": "arcadekit/game/browser",
  "content/index": "arcadekit/content",
  "net/browser/index": "arcadekit/net/browser",
};

/**
 * The exports of the older contract, each with the declaration that replaces it. No game uses
 * one any more: they stay in the kit until the end of the move to declarations (ADR-0020), for
 * the kit's own tests and its older engine, and a name leaves this list when its export goes.
 */
export const OLDER_CONTRACT: Readonly<Record<string, string>> = {
  GameSimulation: "Game.Simulation",
  GameDefinition: "Game.Engine",
  GamePresentation: "Game.Engine",
  GameEngine: "Game.Engine",
  makeGameEngine: "Game.Engine",
};

/** The package whose entries export the older contract. */
const KIT = "arcadekit";

interface Node {
  readonly type: string;
  readonly parent?: Node;
  readonly name?: string;
  /** A literal's value, or the node a property holds. */
  readonly value?: unknown;
  readonly computed?: boolean;
  readonly static?: boolean;
  readonly readonly?: boolean;
  readonly const?: boolean;
  readonly async?: boolean;
  readonly generator?: boolean;
  readonly object?: Node;
  readonly property?: Node;
  readonly left?: Node;
  readonly right?: Node;
  readonly key?: Node;
  readonly callee?: Node;
  readonly arguments?: readonly Node[];
  readonly typeArguments?: Node | null;
  readonly typeParameters?: { readonly params: readonly Node[] } | null;
  readonly params?: readonly Node[];
  readonly returnType?: Node | null;
  readonly typeAnnotation?: Node | null;
  readonly typeName?: Node;
  readonly literal?: Node;
  readonly expression?: Node;
  readonly properties?: readonly Node[];
  readonly id?: Node | null;
  readonly init?: Node | null;
  readonly superClass?: Node | null;
  readonly body?: unknown;
  readonly source?: Node | null;
  readonly specifiers?: readonly Node[];
  readonly imported?: Node;
  readonly local?: Node;
  readonly quasis?: readonly { readonly value: { readonly cooked?: string } }[];
  readonly expressions?: readonly Node[];
}

interface RuleContext {
  readonly filename: string;
  readonly report: (descriptor: { node: Node; message: string }) => void;
}

const guide = "See docs/code-style.md.";

const asNode = (value: unknown): Node | undefined =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string"
    ? (value as Node)
    : undefined;

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const CLASSES = new Set(["ClassDeclaration", "ClassExpression"]);

/** What an expression may be wrapped in and still be itself: a cast, parentheses. */
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

/** `Content` for an identifier, `Game.Event` for a member of one, undefined for anything else. */
const dottedName = (node: Node | undefined): string | undefined => {
  if (node?.type === "Identifier") {
    return node.name;
  }
  if (
    node?.type === "MemberExpression" &&
    node.computed !== true &&
    node.object?.type === "Identifier" &&
    node.property?.type === "Identifier"
  ) {
    return `${node.object.name}.${node.property.name}`;
  }
  return undefined;
};

/** The text of a plain string: "X", `X` with nothing interpolated, or either `as const`. */
const plainString = (node: Node | undefined): string | undefined => {
  if (node?.type === "TSAsExpression") {
    return plainString(node.expression);
  }
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions?.length === 0 &&
    node.quasis?.length === 1
  ) {
    return node.quasis[0]?.value.cooked;
  }
  return undefined;
};

/** The builders of the entry a file imports with `specifier`, as a game writes each, by export name. */
const buildersOf = (
  filename: string,
  specifier: unknown
): ReadonlyMap<string, string> | undefined => {
  if (typeof specifier !== "string") {
    return undefined;
  }
  let entry = specifier;
  if (specifier.startsWith(".")) {
    // A file of the kit imports an entry by the relative path of its public file.
    const file = filename.split(path.sep).join("/");
    const at = file.lastIndexOf(KIT_SRC);
    if (at === -1) {
      return undefined;
    }
    const from = path.posix.dirname(file.slice(at + KIT_SRC.length));
    const target = path.posix
      .normalize(path.posix.join(from, specifier))
      .replace(/\.ts$/u, "");
    entry = KIT_ENTRY_FILES[target] ?? "";
  }
  const written = BUILDER_ENTRIES[entry];
  if (written === undefined) {
    return undefined;
  }
  const prefix = `${NAMESPACE}.`;
  return new Map(
    DECLARATION_BUILDERS.filter(
      (name) => name.startsWith(prefix) === (written === "namespace")
    ).map((name) => [name.replace(prefix, ""), name])
  );
};

/** The builders a file can call, by the local name it gave each. */
class Builders {
  /** A builder imported by name: its local name, and the builder as a game writes it. */
  private readonly named = new Map<string, string>();
  /** An entry imported as a namespace: its local name, and its builders by export name. */
  private readonly namespaces = new Map<string, ReadonlyMap<string, string>>();

  constructor(filename: string, program: Node) {
    for (const statement of (program.body ?? []) as readonly Node[]) {
      const entry =
        statement.type === "ImportDeclaration"
          ? buildersOf(filename, statement.source?.value)
          : undefined;
      for (const specifier of entry === undefined
        ? []
        : (statement.specifiers ?? [])) {
        const local = specifier.local?.name;
        const builder = entry?.get(specifier.imported?.name ?? "");
        if (local !== undefined && entry !== undefined) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            this.namespaces.set(local, entry);
          } else if (builder !== undefined) {
            this.named.set(local, builder);
          }
        }
      }
    }
  }

  /** The builder an expression names, as a game writes it: `Game.Event` for `G.Event`. */
  private builderNamed(callee: Node | undefined): string | undefined {
    if (callee?.type === "Identifier") {
      return this.named.get(callee.name ?? "");
    }
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier"
    ) {
      const member =
        callee.computed === true
          ? plainString(callee.property)
          : callee.property?.name;
      return this.namespaces.get(callee.object.name ?? "")?.get(member ?? "");
    }
    return undefined;
  }

  /**
   * The builder of a call that only gives a builder its types, `Asset<Sheet, SheetError>()`:
   * the first call of a builder that takes its types first. It declares nothing yet.
   */
  typesOnly(node: Node | null | undefined): string | undefined {
    return node?.type === "CallExpression" &&
      (node.arguments?.length ?? 0) === 0
      ? this.builderNamed(node.callee)
      : undefined;
  }

  /**
   * The builder a call declares with, as a game writes it, if it is one: `Game.Event` for
   * `Game.Event("X", ...)`, and `Asset<...>()` for `Asset<Sheet, SheetError>()("X", ...)`.
   */
  of(node: Node | null | undefined): string | undefined {
    if (
      node?.type !== "CallExpression" ||
      (node.arguments?.length ?? 0) === 0
    ) {
      return undefined;
    }
    const typesFirst = this.typesOnly(node.callee);
    return typesFirst === undefined
      ? this.builderNamed(node.callee)
      : `${typesFirst}<...>()`;
  }
}

/** Gives each rule the file's builders, read once from its imports when the file's walk begins. */
const withBuilders = (
  context: RuleContext,
  visitors: (builders: () => Builders) => Record<string, (node: Node) => void>
): Record<string, (node: Node) => void> => {
  let found: Builders | undefined;
  const made = visitors(() => {
    found ??= new Builders(context.filename, { type: "Program", body: [] });
    return found;
  });
  const { Program: onProgram } = made;
  return {
    ...made,
    Program: (node: Node) => {
      found = new Builders(context.filename, node);
      onProgram?.(node);
    },
  };
};

/** The class whose `extends` clause holds `node`, through any wrapper round it. */
const extendedBy = (node: Node): Node | undefined => {
  let inner = node;
  let outer = node.parent;
  while (outer !== undefined && WRAPPERS.has(outer.type)) {
    inner = outer;
    outer = outer.parent;
  }
  return outer !== undefined &&
    CLASSES.has(outer.type) &&
    outer.superClass === inner
    ? outer
    : undefined;
};

/** The name of the `const` a call is the whole value of: `const X = call`. */
const constOf = (node: Node): string | undefined => {
  const { parent } = node;
  return parent?.type === "VariableDeclarator" &&
    parent.init === node &&
    parent.id?.type === "Identifier"
    ? parent.id.name
    : undefined;
};

/** The name of the class or const a class extends, when it extends one by name. */
const extending = (node: Node): string | undefined =>
  node.superClass?.type === "Identifier" ? node.superClass.name : undefined;

const named = {
  meta: {
    type: "problem",
    docs: {
      description:
        'A declaration\'s class has the name it is declared with: class X extends Game.Event("X").',
    },
  },
  create: (context: RuleContext) =>
    withBuilders(context, (builders) => {
      // What the file declares with a builder: a class by its name, and a builder's call kept
      // in a const (the kit's own files name a base before they extend it) by the const's.
      const declared = new Set<string>();
      const bases = new Map<
        string,
        { readonly builder: string; readonly name: string | undefined }
      >();
      const classes: Node[] = [];

      const check = (
        node: Node,
        builder: string,
        declaredAs: string | undefined
      ) => {
        const className = node.id?.name;
        if (className === undefined) {
          context.report({
            node,
            message: `A declaration is a named class: write \`class ${declaredAs ?? "Name"} extends ${builder}(...) {}\`, so the code, its types and its readers have one name for the part. ${guide}`,
          });
          return;
        }
        declared.add(className);
        if (declaredAs === undefined) {
          context.report({
            node,
            message: `${builder} takes the class's own name as a plain string: \`class ${className} extends ${builder}("${className}", ...) {}\`. ${guide}`,
          });
        } else if (declaredAs !== className) {
          context.report({
            node,
            message: `The class ${className} is declared as "${declaredAs}". A declaration has one name: \`class ${className} extends ${builder}("${className}", ...) {}\`. ${guide}`,
          });
        }
      };

      const onClass = (node: Node) => {
        const builder = builders().of(node.superClass);
        if (builder === undefined) {
          classes.push(node);
        } else {
          check(node, builder, plainString(node.superClass?.arguments?.[0]));
        }
      };
      return {
        ClassDeclaration: onClass,
        ClassExpression: onClass,
        CallExpression: (node: Node) => {
          const builder = builders().of(node);
          const held = constOf(node);
          if (builder !== undefined && held !== undefined) {
            bases.set(held, {
              builder,
              name: plainString(node.arguments?.[0]),
            });
          }
        },
        "Program:exit": () => {
          // First the classes that extend a named base, which are declarations too.
          for (const node of classes) {
            const base = bases.get(extending(node) ?? "");
            if (base !== undefined) {
              check(node, base.builder, base.name);
            }
          }
          for (const node of classes) {
            const base = extending(node);
            if (base !== undefined && !bases.has(base) && declared.has(base)) {
              context.report({
                node,
                message: `${node.id?.name ?? "This class"} extends the declaration ${base}, so it is a second class under ${base}'s name: its values have the same tag, or its service the same key. Declare a part of its own, and put what the two share in a function. ${guide}`,
              });
            }
          }
        },
      };
    }),
};

const declaredAsClass = {
  meta: {
    type: "problem",
    docs: {
      description:
        'A declaration builder is called to be extended: class X extends Game.Event("X") {}.',
    },
  },
  create: (context: RuleContext) =>
    withBuilders(context, (builders) => {
      // A builder's call kept in a const, and how many classes of the file extend each const.
      const held = new Map<
        string,
        { readonly node: Node; readonly builder: string }
      >();
      const extended = new Map<string, number>();
      const asClass = (node: Node, builder: string): string => {
        const name = plainString(node.arguments?.[0]) ?? "Name";
        return `\`class ${name} extends ${builder}("${name}", ...) {}\``;
      };
      const onClass = (node: Node) => {
        if (node.superClass?.type === "Identifier") {
          const base = node.superClass.name ?? "";
          extended.set(base, (extended.get(base) ?? 0) + 1);
        }
      };
      return {
        ClassDeclaration: onClass,
        ClassExpression: onClass,
        CallExpression: (node: Node) => {
          const typesOnly = builders().typesOnly(node);
          if (
            typesOnly !== undefined &&
            !(
              node.parent?.type === "CallExpression" &&
              node.parent.callee === node
            )
          ) {
            context.report({
              node,
              message: `Give ${typesOnly} its types where the part is declared: \`class Name extends ${typesOnly}<...>()("Name", ...) {}\`. Kept apart, the call that names the part reads as an ordinary function's. ${guide}`,
            });
            return;
          }
          const builder = builders().of(node);
          if (builder === undefined) {
            return;
          }
          const by = extendedBy(node);
          if (by !== undefined) {
            if (by.superClass !== node) {
              context.report({
                node,
                message: `Extend ${builder}(...) itself: ${asClass(node, builder)}. A cast or a call round it hides the declaration from its readers, and its types need none. ${guide}`,
              });
            }
            return;
          }
          const name = constOf(node);
          if (name === undefined) {
            context.report({
              node,
              message: `Declare it as a class: ${asClass(node, builder)}. The class statement gives the part its value and its type under one name; a \`const\` gives only the value. ${guide}`,
            });
          } else {
            held.set(name, { node, builder });
          }
        },
        "Program:exit": () => {
          for (const [name, { node, builder }] of held) {
            const classes = extended.get(name) ?? 0;
            if (classes === 0) {
              context.report({
                node,
                message: `Declare it as a class: ${asClass(node, builder)}. The class statement gives the part its value and its type under one name; a \`const\` gives only the value. ${guide}`,
              });
            } else if (classes > 1) {
              context.report({
                node,
                message: `${classes} classes extend ${name}, so they are one declaration under several names. Each part is declared once: ${asClass(node, builder)}. ${guide}`,
              });
            }
          }
        },
      };
    }),
};

const inferred = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A declaration builder is given no type argument: its types come from the definition.",
    },
  },
  create: (context: RuleContext) =>
    withBuilders(context, (builders) => ({
      CallExpression: (node: Node) => {
        const builder = builders().of(node);
        if (
          builder === undefined ||
          node.typeArguments === null ||
          node.typeArguments === undefined
        ) {
          return;
        }
        context.report({
          node: node.typeArguments,
          message: `${builder} takes no type argument: it infers every type from the definition. If one doesn't infer, the definition is why (a handler inside a call, a type nothing in the definition carries), and the builder is what to change. ${guide}`,
        });
      },
    })),
};

const plainHandler = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A function in a declaration's definition is a plain function: not async, not a generator.",
    },
  },
  create: (context: RuleContext) =>
    withBuilders(context, (builders) => {
      /** Reports the async and generator functions an object holds, in it or in an object it holds. */
      const check = (object: Node | undefined, builder: string) => {
        for (const property of object?.properties ?? []) {
          const value = asNode(property.value);
          if (value?.type === "ObjectExpression") {
            check(value, builder);
          } else if (
            value !== undefined &&
            FUNCTIONS.has(value.type) &&
            (value.async === true || value.generator === true)
          ) {
            const key = dottedName(property.key) ?? "A handler";
            context.report({
              node: value,
              message: `${key} is ${value.async === true ? "async" : "a generator"}. A function in a ${builder} definition is a plain function: what hosts it calls it and goes on, and waits for nothing. Load what it needs before the run (an Asset, the engine's \`uses\`, the run's config), and report what happened as an event. ${guide}`,
            });
          }
        }
      };
      return {
        CallExpression: (node: Node) => {
          const builder = builders().of(node);
          if (builder === undefined) {
            return;
          }
          for (const argument of node.arguments ?? []) {
            if (argument.type === "ObjectExpression") {
              check(argument, builder);
            }
          }
        },
      };
    }),
};

/** Whether an import or a re-export names one of the kit's entries. */
const fromKit = (node: Node): boolean => {
  const source = node.source?.value;
  return (
    typeof source === "string" &&
    (source === KIT || source.startsWith(`${KIT}/`))
  );
};

const olderContract = {
  meta: {
    type: "problem",
    docs: {
      description:
        "New code uses the declarations, not the older contract they replace.",
    },
  },
  create: (context: RuleContext) => {
    const report = (node: Node, name: string) => {
      context.report({
        node,
        message: `${name} is the older contract, which no game uses any more and which goes at the end of the move to declarations (ADR-0020). Declare a ${OLDER_CONTRACT[name]} in its place: packages/push-puzzle is the example, and a \`Coop\` is made from the declared engine too. ${guide}`,
      });
    };
    // The names a file gives the kit's entries: `import * as Runtime from "arcadekit/runtime"`.
    const namespaces = new Set<string>();
    const checkMember = (
      object: Node | undefined,
      member: Node | undefined
    ) => {
      if (
        object?.type === "Identifier" &&
        object.name !== undefined &&
        namespaces.has(object.name) &&
        member?.type === "Identifier" &&
        member.name !== undefined &&
        Object.hasOwn(OLDER_CONTRACT, member.name)
      ) {
        report(member, member.name);
      }
    };
    return {
      ImportDeclaration: (node: Node) => {
        if (!fromKit(node)) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          const imported = specifier.imported?.name;
          if (specifier.type === "ImportNamespaceSpecifier") {
            if (specifier.local?.name !== undefined) {
              namespaces.add(specifier.local.name);
            }
          } else if (
            imported !== undefined &&
            Object.hasOwn(OLDER_CONTRACT, imported)
          ) {
            report(specifier, imported);
          }
        }
      },
      // `export { makeGameEngine } from "arcadekit/runtime/browser"`.
      ExportNamedDeclaration: (node: Node) => {
        if (!fromKit(node)) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          const local = specifier.local?.name;
          if (local !== undefined && Object.hasOwn(OLDER_CONTRACT, local)) {
            report(specifier, local);
          }
        }
      },
      MemberExpression: (node: Node) => {
        if (node.computed !== true) {
          checkMember(node.object, node.property);
        }
      },
      TSQualifiedName: (node: Node) => {
        checkMember(node.left, node.right);
      },
    };
  },
};

/** The function a class expression is the result of, if it is one's result. */
const returnedFrom = (node: Node): Node | undefined => {
  let outer = node;
  while (outer.parent !== undefined && WRAPPERS.has(outer.parent.type)) {
    outer = outer.parent;
  }
  const { parent } = outer;
  if (parent?.type === "ArrowFunctionExpression" && parent.body === outer) {
    return parent;
  }
  if (parent?.type !== "ReturnStatement") {
    return undefined;
  }
  let scope = parent.parent;
  while (scope !== undefined && !FUNCTIONS.has(scope.type)) {
    scope = scope.parent;
  }
  return scope;
};

/** The members of a class or an interface that `kept` keeps, by name. */
const membersOf = (
  node: Node,
  kept: (member: Node) => boolean
): ReadonlyMap<string, Node> => {
  const { body } = (node.body ?? {}) as { readonly body?: readonly Node[] };
  const members = new Map<string, Node>();
  for (const member of body ?? []) {
    const name =
      member.key?.type === "Identifier" ? member.key.name : undefined;
    if (name !== undefined && member.computed !== true && kept(member)) {
      members.set(name, member);
    }
  }
  return members;
};

const lowerFirst = (text: string): string =>
  text.slice(0, 1).toLowerCase() + text.slice(1);

/** The name of the type something is annotated with: `Name`, `EventClass`. */
const annotatedAs = (
  annotation: Node | null | undefined
): string | undefined => {
  const type = annotation?.typeAnnotation;
  return type?.type === "TSTypeReference" &&
    type.typeName?.type === "Identifier"
    ? type.typeName.name
    : undefined;
};

/** A type parameter's name. Its `name` is an Identifier, where an Identifier's is a string. */
const typeParameterName = (parameter: Node): string | undefined => {
  const name: unknown = parameter.name;
  return typeof name === "string" ? name : asNode(name)?.name;
};

const builder = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A function of the kit that returns a class is a declaration builder, and has a builder's shape.",
    },
  },
  create: (context: RuleContext) => {
    const interfaces = new Map<string, Node>();
    const built: { readonly kind: string; readonly made: Node }[] = [];
    const nouns = new Set(
      DECLARATION_BUILDERS.map((name) => name.split(".").at(-1) ?? name)
    );

    const checkInterface = (kind: string, made: Node) => {
      const type = interfaces.get(`${kind}Class`);
      if (
        type === undefined ||
        type.parent?.type !== "ExportNamedDeclaration"
      ) {
        context.report({
          node: made,
          message: `This file exports no interface ${kind}Class. A builder's public type is written out beside it, as an interface with everything the class has: it is what a reader and the type files see. ${guide}`,
        });
        return;
      }
      const members = membersOf(type, () => true);
      const kindType = members.get("kind")?.typeAnnotation?.typeAnnotation;
      if (
        members.get("kind")?.readonly !== true ||
        kindType?.type !== "TSLiteralType" ||
        kindType.literal?.value !== kind
      ) {
        context.report({
          node: type,
          message: `${kind}Class says what its class is: \`readonly kind: "${kind}";\`. ${guide}`,
        });
      }
      if (!members.has("tag") && !members.has(`${lowerFirst(kind)}Name`)) {
        context.report({
          node: type,
          message: `${kind}Class has the declared name: \`readonly tag\` when it is the \`_tag\` of the class's values, \`readonly ${lowerFirst(kind)}Name\` otherwise. ${guide}`,
        });
      }
      // The class is cast to the interface, so nothing else holds the two to each other.
      const statics = membersOf(made, (member) => member.static === true);
      for (const [name, member] of members) {
        if (!statics.has(name)) {
          context.report({
            node: member,
            message: `${kind}Class has \`${name}\`, which the builder's class never sets: a game that reads it gets undefined. Set it as a static, or take it out of the interface. ${guide}`,
          });
        }
      }
      for (const [name, member] of statics) {
        if (!members.has(name)) {
          context.report({
            node: member,
            message: `The builder's class sets \`${name}\`, which ${kind}Class doesn't have, so no game can see it. Add it to the interface, or keep it out of the class. ${guide}`,
          });
        }
      }
    };

    /** The class's kind, if it says one. Reports a class that doesn't, or whose kind is new. */
    const checkKind = (
      node: Node,
      statics: ReadonlyMap<string, Node>
    ): string | undefined => {
      const kindStatic = statics.get("kind");
      const kindValue = asNode(kindStatic?.value);
      const kind =
        kindStatic?.readonly === true && kindValue?.type === "TSAsExpression"
          ? plainString(kindValue.expression)
          : undefined;
      if (kind === undefined) {
        context.report({
          node,
          message: `A function that returns a class is a declaration builder, and its class says what it is: \`static readonly kind = "<Noun>" as const\`, with the builder's noun (Event, Asset). ${guide}`,
        });
      } else if (!nouns.has(kind)) {
        context.report({
          node: kindStatic ?? node,
          message: `"${kind}" is not one of the kit's declarations. A new one is a new word of the kit's vocabulary: add its builder to DECLARATION_BUILDERS in tools/lint/declaration.ts and to DECLARATIONS in packages/arcadekit/test/style.test.ts, which then checks its docs. ${guide}`,
        });
      }
      return kind;
    };

    /** The declared name: the builder's first parameter, typed by a type parameter, kept in a static. */
    const checkName = (
      node: Node,
      statics: ReadonlyMap<string, Node>,
      kind: string,
      made: Node
    ) => {
      const nameOwn = statics.get("name");
      if (nameOwn !== undefined) {
        context.report({
          node: nameOwn,
          message: `A class already has a \`name\`, and a minifier changes it. Keep the declared name in \`tag\` (when it is the \`_tag\` of the class's values) or in \`${lowerFirst(kind)}Name\`. ${guide}`,
        });
      }
      const [first] = made.params ?? [];
      const parameter = first?.type === "Identifier" ? first : undefined;
      const nameStatic =
        statics.get("tag") ?? statics.get(`${lowerFirst(kind)}Name`);
      const nameValue = asNode(nameStatic?.value);
      if (
        nameStatic?.readonly !== true ||
        nameValue?.type !== "Identifier" ||
        nameValue.name !== parameter?.name
      ) {
        context.report({
          node: nameStatic ?? node,
          message: `A builder's class keeps the name it was declared with, the builder's first parameter: \`static readonly tag\` when it is the \`_tag\` of the class's values, \`static readonly ${lowerFirst(kind)}Name\` otherwise. ${guide}`,
        });
      }
      const nameType = annotatedAs(parameter?.typeAnnotation);
      const literal = made.typeParameters?.params.find(
        (typeParameter) => typeParameterName(typeParameter) === nameType
      );
      if (literal === undefined) {
        context.report({
          node: first ?? made,
          message: `A builder takes the declared name first, typed by a type parameter: \`<Name extends string>(name: Name, definition)\`. Typed \`string\`, every declaration of the builder has one type, and every service one identity. ${guide}`,
        });
      }
    };

    /** The builder's written return type, and the base its class extends. */
    const checkSignature = (node: Node, kind: string, made: Node) => {
      if (annotatedAs(made.returnType) !== `${kind}Class`) {
        context.report({
          node: made.returnType ?? made,
          message: `A builder's return type is written out: \`${kind}Class<...>\`, the interface of this file that has everything the class has. ${guide}`,
        });
      }
      const base = node.superClass ?? undefined;
      if (base !== undefined && base.type !== "Identifier") {
        context.report({
          node: base,
          message: `Name the base before the class extends it: \`const Base = ...; return class extends Base { ... }\`. The class then reads as its statics alone. ${guide}`,
        });
      }
    };

    return {
      TSInterfaceDeclaration: (node: Node) => {
        if (node.id?.name !== undefined) {
          interfaces.set(node.id.name, node);
        }
      },
      ClassExpression: (node: Node) => {
        const made = returnedFrom(node);
        if (made === undefined) {
          return;
        }
        const statics = membersOf(node, (member) => member.static === true);
        const kind = checkKind(node, statics);
        if (kind === undefined) {
          return;
        }
        checkName(node, statics, kind, made);
        checkSignature(node, kind, made);
        built.push({ kind, made: node });
      },
      "Program:exit": () => {
        const kinds = new Set<string>();
        for (const { kind, made } of built) {
          if (kinds.has(kind)) {
            context.report({
              node: made,
              message: `This file has another builder of kind "${kind}". One builder makes one kind of declaration: a second way to declare a ${kind} is a second word for the same part. ${guide}`,
            });
          } else {
            kinds.add(kind);
            checkInterface(kind, made);
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "declaration" },
  rules: {
    named,
    class: declaredAsClass,
    inferred,
    "plain-handler": plainHandler,
    "older-contract": olderContract,
    builder,
  },
};
