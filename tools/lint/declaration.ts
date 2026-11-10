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
//   use. A typo in one of them is a part with two names.
// - `declaration/class`: a builder is called to be extended, and nowhere else. A
//   `const LevelSolved = Game.Event(...)` runs, but it names no type, so the file grows a
//   `type LevelSolved = ...` beside it and the part is declared twice.
// - `declaration/inferred`: a builder is given no type argument. Its types come from the
//   definition; a type argument is how a definition that doesn't infer gets papered over.
// - `declaration/plain-handler`: a function in a definition is not `async` and not a generator.
//   Its host calls it and goes on.
// - `declaration/older-contract`: nothing new imports the contract the declarations replace.
//
// For the kit's own source:
//
// - `declaration/builder`: a function that returns a class is a builder, and has a builder's
//   shape: the name first, as a literal type; `kind` and the name as statics; its return type
//   written out as `<Noun>Class`, an interface of the same file.
//
// packages/arcadekit/test/style.test.ts checks what takes more than one file: that every
// builder is listed here, has its docs and is declared by a test.

/** The kit's declaration builders, as a game's code writes each. */
export const DECLARATION_BUILDERS: readonly string[] = [
  "Game.Event",
  "Game.Command",
  "Game.Rejection",
  "Game.Simulation",
  "Game.Engine",
  "Content",
  "Asset",
];

/**
 * The exports of the older contract, each with the declaration that replaces it. They stay in
 * the kit until survivors and the Co-op client have moved (ADR-0020), and a name leaves this
 * list when its export goes.
 */
export const OLDER_CONTRACT: Readonly<Record<string, string>> = {
  GameSimulation: "Game.Simulation",
  GameDefinition: "Game.Engine",
  GamePresentation: "Game.Engine",
  GameEngine: "Game.Engine",
  makeGameEngine: "Game.Engine",
  EngineLoader: "Game.Engine",
  LoadedEngine: "Game.Engine",
  makeEngineLoader: "Game.Engine",
  engineOf: "Game.Engine",
  ContentLoader: "Content",
  makeContentLoader: "Content",
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

/**
 * The builder a call declares with, as the code writes it, if it is one: `Game.Event` for
 * `Game.Event("X", ...)`, and `Asset<...>()` for the second call of a builder that takes its
 * types first, `Asset<Sheet, SheetError>()("X", ...)`. The first call of that pair takes no
 * argument and declares nothing.
 */
const builderOf = (node: Node | null | undefined): string | undefined => {
  if (node?.type !== "CallExpression" || (node.arguments?.length ?? 0) === 0) {
    return undefined;
  }
  const direct = dottedName(node.callee);
  if (direct !== undefined) {
    return DECLARATION_BUILDERS.includes(direct) ? direct : undefined;
  }
  const typesFirst =
    node.callee?.type === "CallExpression"
      ? dottedName(node.callee.callee)
      : undefined;
  return typesFirst !== undefined && DECLARATION_BUILDERS.includes(typesFirst)
    ? `${typesFirst}<...>()`
    : undefined;
};

/** The text of a plain string: "X", or `X` with nothing interpolated. */
const plainString = (node: Node | undefined): string | undefined => {
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

const named = {
  meta: {
    type: "problem",
    docs: {
      description:
        'A declaration\'s class has the name it is declared with: class X extends Game.Event("X").',
    },
  },
  create: (context: RuleContext) => {
    const check = (node: Node) => {
      const builder = builderOf(node.superClass);
      if (builder === undefined) {
        return;
      }
      const declared = plainString(node.superClass?.arguments?.[0]);
      const className = node.id?.name;
      if (className === undefined) {
        context.report({
          node,
          message: `A declaration is a named class: write \`class ${declared ?? "Name"} extends ${builder}(...) {}\`, so the code, its types and its readers have one name for the part. ${guide}`,
        });
        return;
      }
      if (declared === undefined) {
        context.report({
          node,
          message: `${builder} takes the class's own name as a plain string: \`class ${className} extends ${builder}("${className}", ...) {}\`. ${guide}`,
        });
        return;
      }
      if (declared !== className) {
        context.report({
          node,
          message: `The class ${className} is declared as "${declared}". A declaration has one name: \`class ${className} extends ${builder}("${className}", ...) {}\`. ${guide}`,
        });
      }
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};

const declaredAsClass = {
  meta: {
    type: "problem",
    docs: {
      description:
        'A declaration builder is called to be extended: class X extends Game.Event("X") {}.',
    },
  },
  create: (context: RuleContext) => ({
    CallExpression: (node: Node) => {
      const builder = builderOf(node);
      const { parent } = node;
      const extended =
        (parent?.type === "ClassDeclaration" ||
          parent?.type === "ClassExpression") &&
        parent.superClass === node;
      if (builder === undefined || extended) {
        return;
      }
      const declared = plainString(node.arguments?.[0]) ?? "Name";
      context.report({
        node,
        message: `Declare it as a class: \`class ${declared} extends ${builder}("${declared}", ...) {}\`. The class statement gives the part its value and its type under one name; a \`const\` gives only the value. ${guide}`,
      });
    },
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
  create: (context: RuleContext) => ({
    CallExpression: (node: Node) => {
      const builder = builderOf(node);
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
  }),
};

const plainHandler = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A function in a declaration's definition is a plain function: not async, not a generator.",
    },
  },
  create: (context: RuleContext) => {
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
        const builder = builderOf(node);
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
  },
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
        message: `${name} is the older contract, which stays only until survivors and the Co-op client have moved (ADR-0020). Declare a ${OLDER_CONTRACT[name]} in its place: packages/push-puzzle is the example. A new Co-op game still needs the older contract: turn this rule off for its files in oxlint.config.ts, and say so in the PR. ${guide}`,
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

/** What a class expression is wrapped in between itself and where it is returned. */
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

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

    /** The declared name: the builder's first parameter, a literal type, kept in a static. */
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
      if (literal?.const !== true) {
        context.report({
          node: first ?? made,
          message: `A builder takes the declared name first, as a literal type: \`<const Name extends string>(name: Name, definition)\`. Without \`const\` the name widens to string, and two declarations share one type. ${guide}`,
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
        for (const { kind, made } of built) {
          checkInterface(kind, made);
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
