// An oxlint JS plugin (ESLint's plugin shape) for how a game writes a declaration (ADR-0020):
//
//   export class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
//
// A declaration is a class statement whose name is the name it is declared with. Two rules hold
// a game to it, since neither is a type error:
//
// - `declaration/named`: the class and the string have the same name. The string is what the
//   run uses (an event's `_tag`, a service's key); the class is what the code and its readers
//   use. A typo in one of them is a part with two names.
// - `declaration/class`: a builder is called to be extended, and nowhere else. A
//   `const LevelSolved = Game.Event(...)` runs, but it names no type, so the file grows a
//   `type LevelSolved = ...` beside it and the part is declared twice.
//
// docs/code-style.md has the rest of the style, and packages/arcadekit/test/style.test.ts checks
// that this list names every builder the kit has.

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

interface Node {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly computed?: boolean;
  readonly object?: Node;
  readonly property?: Node;
  readonly callee?: Node;
  readonly arguments?: readonly Node[];
  readonly id?: Node | null;
  readonly superClass?: Node | null;
  readonly quasis?: readonly { readonly value: { readonly cooked?: string } }[];
  readonly expressions?: readonly Node[];
}

interface RuleContext {
  readonly report: (descriptor: { node: Node; message: string }) => void;
}

const guide = "See docs/code-style.md.";

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
  create: (context: RuleContext) => {
    // A class is visited before its superclass's call, so the call is known by then.
    const extended = new WeakSet<Node>();
    const remember = (node: Node) => {
      if (node.superClass !== null && node.superClass !== undefined) {
        extended.add(node.superClass);
      }
    };
    return {
      ClassDeclaration: remember,
      ClassExpression: remember,
      CallExpression: (node: Node) => {
        const builder = builderOf(node);
        if (builder === undefined || extended.has(node)) {
          return;
        }
        const declared = plainString(node.arguments?.[0]) ?? "Name";
        context.report({
          node,
          message: `Declare it as a class: \`class ${declared} extends ${builder}("${declared}", ...) {}\`. The class statement gives the part its value and its type under one name; a \`const\` gives only the value. ${guide}`,
        });
      },
    };
  },
};

export default {
  meta: { name: "declaration" },
  rules: { named, class: declaredAsClass },
};
