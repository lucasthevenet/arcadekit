// An oxlint JS plugin (ESLint's plugin shape) for what oxlint's built-in rules can't express.
// `**` is Number::exponentiate, the same implementation-approximated operation as `Math.pow`,
// so a step that uses it can give different bits in different engines (ADR-0011).

interface Node {
  readonly type: string;
  readonly operator?: string;
}

interface RuleContext {
  readonly report: (descriptor: { node: Node; message: string }) => void;
}

const message =
  "`**` is approximated differently by each engine, so a step that uses it can desync lockstep peers. Use exact operations, such as ExactMath.powInt in arcadekit/core. See docs/adr/0011-a-step-uses-only-exact-math.md.";

const noExponentiation = {
  meta: {
    type: "problem",
    docs: { description: "Disallow `**` and `**=` in simulation code." },
  },
  create: (context: RuleContext) => ({
    AssignmentExpression: (node: Node) => {
      if (node.operator === "**=") {
        context.report({ node, message });
      }
    },
    BinaryExpression: (node: Node) => {
      if (node.operator === "**") {
        context.report({ node, message });
      }
    },
  }),
};

export default {
  meta: { name: "deterministic-math" },
  rules: { "no-exponentiation": noExponentiation },
};
