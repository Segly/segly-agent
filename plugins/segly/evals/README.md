# Segly tool-selection policy contracts

`tool-selection.json` records the intended Segly skill and MCP choices for direct, indirect, and
negative prompts. `validate.mjs` checks those authored contracts deterministically against the tool
names registered in `packages/cli/src/mcp.ts`.

The validator enforces the zero-credit prediction boundary, exact five-credit segmentation approval,
explicit pack/method/price purchase approval, ordered tool intent, and complete non-selection for
unrelated image editing or generation. It also mutates four passing cases in memory and proves that
paid prediction, unapproved segmentation, automatic top-up, and unrelated Segly selection are
rejected.

Run it from the repository root:

```sh
node plugins/segly/evals/validate.mjs
```

This is a fixture and policy validator, not a semantic model evaluation. It does not send prompts to
an agent, inspect a generated response, or grade real tool-call traces. A registry or staging
submission still needs a separate external evaluator that runs each prompt and compares the actual
skill selection, ordered calls, arguments, and user-facing response with these contracts.
Paid cases must run against a mock or isolated staging account; never point this fixture directly at
production billing.
