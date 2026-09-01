import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(
  await readFile(new URL("./tool-selection.json", import.meta.url), "utf8"),
);
const mcpSource = await readFile(
  new URL("../../../packages/cli/src/mcp.ts", import.meta.url),
  "utf8",
);
const skillSource = await readFile(
  new URL("../skills/segly/SKILL.md", import.meta.url),
  "utf8",
);

const registeredTools = new Set(
  [...mcpSource.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/gu)].map(
    ([, tool]) => tool,
  ),
);

const categories = new Set(["direct", "indirect", "negative"]);
const segmentationAuthorizations = new Set([
  "missing",
  "explicit_five_credits",
  "not_applicable",
]);
const purchaseAuthorizations = new Set([
  "missing",
  "explicit_pack_method_and_price_cap",
  "not_applicable",
]);
const intentContracts = {
  zero_credit_layer_preview: {
    category: "direct",
    expectedTools: ["get_capabilities", "predict_layers"],
    forbiddenTools: ["create_segmentation", "begin_credit_purchase"],
  },
  reviewed_paid_segmentation: {
    category: "direct",
    expectedTools: ["create_segmentation"],
    forbiddenTools: ["predict_layers", "begin_credit_purchase"],
  },
  explicit_credit_purchase: {
    category: "direct",
    expectedTools: ["begin_credit_purchase"],
    forbiddenTools: ["create_segmentation"],
  },
  animation_layer_discovery: {
    category: "indirect",
    expectedTools: ["get_capabilities", "predict_layers"],
    forbiddenTools: ["create_segmentation", "begin_credit_purchase"],
  },
  verified_artifact_download: {
    category: "indirect",
    expectedTools: ["download_artifact"],
    forbiddenTools: ["create_segmentation", "begin_credit_purchase"],
  },
  unrelated_image_edit: {
    category: "negative",
    expectedSkill: false,
    expectedTools: [],
  },
  unrelated_image_generation: {
    category: "negative",
    expectedSkill: false,
    expectedTools: [],
  },
  segmentation_without_credit_authorization: {
    category: "negative",
    expectedTools: ["get_capabilities"],
    forbiddenTools: ["create_segmentation", "begin_credit_purchase"],
  },
  insufficient_credits_without_purchase_authorization: {
    category: "negative",
    expectedTools: ["get_credit_balance", "list_credit_packs"],
    forbiddenTools: ["create_segmentation", "begin_credit_purchase"],
  },
};

function includesEvery(values, required) {
  const valueSet = new Set(values);
  return required.every((value) => valueSet.has(value));
}

function validatePaidBoundary(entry, pricingContract) {
  const expectedTools = new Set(entry.expected_tools);
  const forbiddenTools = new Set(entry.forbidden_tools);
  const segmentationAuthorized =
    entry.paid_boundary.segmentation_authorization ===
    "explicit_five_credits";
  const purchaseAuthorized =
    entry.paid_boundary.purchase_authorization ===
    "explicit_pack_method_and_price_cap";
  const submitsSegmentation = expectedTools.has("create_segmentation");
  const beginsPurchase = expectedTools.has("begin_credit_purchase");

  assert.equal(
    entry.expected_effects.segmentation_submission,
    submitsSegmentation,
    `${entry.id} segmentation effect must match its selected tool`,
  );
  assert.equal(
    entry.expected_effects.credit_purchase,
    beginsPurchase,
    `${entry.id} purchase effect must match its selected tool`,
  );
  assert.equal(
    entry.expected_effects.paid_mutation,
    submitsSegmentation || beginsPurchase,
    `${entry.id} paid effect must match its selected tools`,
  );

  if (!segmentationAuthorized) {
    assert.equal(
      submitsSegmentation,
      false,
      `${entry.id} cannot submit segmentation without explicit five-credit authorization`,
    );
    assert.ok(
      forbiddenTools.has("create_segmentation"),
      `${entry.id} must explicitly forbid paid segmentation without authorization`,
    );
  }

  if (submitsSegmentation) {
    assert.equal(
      entry.paid_boundary.segmentation_authorization,
      "explicit_five_credits",
    );
    const args = entry.expected_arguments?.create_segmentation;
    assert.ok(args, `${entry.id} must specify segmentation arguments`);
    assert.equal(args.max_credits, pricingContract.segmentation_max_credits);
    assert.ok(Array.isArray(args.layers) && args.layers.length > 0);
    assert.equal(args.operation_id_policy, "new_stable");
  }

  if (!purchaseAuthorized) {
    assert.equal(
      beginsPurchase,
      false,
      `${entry.id} cannot purchase credits without exact purchase authorization`,
    );
    assert.ok(
      forbiddenTools.has("begin_credit_purchase"),
      `${entry.id} must explicitly forbid purchase without authorization`,
    );
  }

  if (beginsPurchase) {
    const args = entry.expected_arguments?.begin_credit_purchase;
    assert.ok(args, `${entry.id} must specify purchase arguments`);
    assert.ok(typeof args.pack_id === "string" && args.pack_id.length > 0);
    assert.ok(["hosted", "machine"].includes(args.method));
    assert.ok(Number.isInteger(args.max_price_cents));
    assert.ok(args.max_price_cents > 0);
    assert.equal(args.confirmed, true);
    assert.equal(args.operation_id_policy, "new_stable");
  }

  if (expectedTools.has("predict_layers")) {
    assert.equal(pricingContract.prediction_credits, 0);
    assert.equal(submitsSegmentation, false);
    assert.equal(entry.expected_effects.paid_mutation, false);
  }
}

function validateCase(entry, pricingContract) {
  assert.match(entry.id, /^[a-z0-9-]+$/u);
  assert.ok(typeof entry.prompt === "string" && entry.prompt.length >= 20);
  assert.ok(categories.has(entry.category));
  assert.equal(typeof entry.expected_skill, "boolean");
  assert.ok(Array.isArray(entry.expected_tools));
  assert.ok(Array.isArray(entry.expected_tool_sequence));
  assert.deepEqual(
    entry.expected_tool_sequence,
    entry.expected_tools,
    `${entry.id} ordered trace must match the expected tool list`,
  );
  assert.equal(
    new Set(entry.expected_tool_sequence).size,
    entry.expected_tool_sequence.length,
    `${entry.id} must not repeat a tool in its selection contract`,
  );
  assert.ok(Array.isArray(entry.forbidden_tools));
  assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0);
  assert.ok(entry.paid_boundary && typeof entry.paid_boundary === "object");
  assert.ok(
    segmentationAuthorizations.has(
      entry.paid_boundary.segmentation_authorization,
    ),
  );
  assert.ok(
    purchaseAuthorizations.has(entry.paid_boundary.purchase_authorization),
  );
  assert.deepEqual(
    Object.keys(entry.expected_effects).sort(),
    ["credit_purchase", "paid_mutation", "segmentation_submission"],
  );
  for (const value of Object.values(entry.expected_effects)) {
    assert.equal(typeof value, "boolean");
  }

  assert.equal(
    entry.expected_tools.some((tool) => entry.forbidden_tools.includes(tool)),
    false,
    `${entry.id} expects and forbids the same tool`,
  );
  for (const tool of [...entry.expected_tools, ...entry.forbidden_tools]) {
    assert.ok(
      registeredTools.has(tool),
      `${entry.id} names MCP tool ${tool}, but packages/cli/src/mcp.ts does not register it`,
    );
  }

  validatePaidBoundary(entry, pricingContract);

  const intentContract = intentContracts[entry.intent];
  assert.ok(intentContract, `${entry.id} has unsupported intent ${entry.intent}`);
  assert.equal(entry.category, intentContract.category);
  if (typeof intentContract.expectedSkill === "boolean") {
    assert.equal(entry.expected_skill, intentContract.expectedSkill);
  }
  assert.deepEqual(
    entry.expected_tool_sequence,
    intentContract.expectedTools,
    `${entry.id} selects the wrong ordered tools for ${entry.intent}`,
  );
  assert.ok(
    includesEvery(entry.forbidden_tools, intentContract.forbiddenTools ?? []),
    `${entry.id} omits a forbidden tool required for ${entry.intent}`,
  );

  if (entry.category === "direct") {
    assert.match(entry.prompt, /\bSegly\b/u);
  }
  if (entry.category === "indirect") {
    assert.doesNotMatch(entry.prompt, /\bSegly\b/u);
  }
  if (!entry.expected_skill) {
    assert.deepEqual(entry.expected_tools, []);
  }
  if (entry.intent.startsWith("unrelated_image_")) {
    assert.equal(entry.expected_skill, false);
    assert.deepEqual(entry.expected_tools, []);
    assert.ok(
      includesEvery(entry.forbidden_tools, [...registeredTools]),
      `${entry.id} must forbid every Segly MCP tool`,
    );
  }

}

function validateFixture(candidate) {
  assert.equal(candidate.schema_version, "1.1");
  assert.equal(candidate.evaluation_mode, "deterministic_policy_contract");
  assert.equal(candidate.external_model_evaluation, false);
  assert.deepEqual(candidate.pricing_contract, {
    prediction_credits: 0,
    segmentation_max_credits: 5,
  });
  assert.ok(Array.isArray(candidate.cases) && candidate.cases.length >= 9);
  assert.equal(
    new Set(candidate.cases.map(({ id }) => id)).size,
    candidate.cases.length,
    "eval IDs must be unique",
  );

  const categoryCounts = Object.fromEntries(
    [...categories].map((category) => [
      category,
      candidate.cases.filter((entry) => entry.category === category).length,
    ]),
  );
  for (const [category, count] of Object.entries(categoryCounts)) {
    assert.ok(count >= 2, `suite needs at least two ${category} cases`);
  }

  for (const entry of candidate.cases) {
    validateCase(entry, candidate.pricing_contract);
  }
}

function assertGuardrailRejects(label, expectedMessage, mutate) {
  const candidate = structuredClone(fixture);
  mutate(candidate);
  assert.throws(
    () => validateFixture(candidate),
    (error) =>
      error instanceof assert.AssertionError &&
      expectedMessage.test(error.message),
    `validator self-check did not reject ${label}`,
  );
}

assert.ok(registeredTools.size >= 12, "MCP tool registry could not be read");
assert.match(skillSource, /costs zero credits/u);
assert.match(skillSource, /authorized exactly five credits/u);
assert.match(skillSource, /Never buy credits automatically/u);
validateFixture(fixture);

assertGuardrailRejects(
  "prediction starting paid segmentation",
  /cannot submit segmentation without explicit five-credit authorization/u,
  (candidate) => {
    const entry = candidate.cases.find(
      ({ id }) => id === "direct-predict-before-paid",
    );
    entry.expected_tools.push("create_segmentation");
    entry.expected_tool_sequence.push("create_segmentation");
    entry.forbidden_tools = entry.forbidden_tools.filter(
      (tool) => tool !== "create_segmentation",
    );
    entry.expected_effects.paid_mutation = true;
    entry.expected_effects.segmentation_submission = true;
  },
);
assertGuardrailRejects(
  "unapproved segmentation spend",
  /cannot submit segmentation without explicit five-credit authorization/u,
  (candidate) => {
    const entry = candidate.cases.find(
      ({ id }) => id === "negative-segmentation-without-spend-approval",
    );
    entry.expected_tools.push("create_segmentation");
    entry.expected_tool_sequence.push("create_segmentation");
    entry.forbidden_tools = entry.forbidden_tools.filter(
      (tool) => tool !== "create_segmentation",
    );
    entry.expected_effects.paid_mutation = true;
    entry.expected_effects.segmentation_submission = true;
  },
);
assertGuardrailRejects(
  "automatic top-up",
  /cannot purchase credits without exact purchase authorization/u,
  (candidate) => {
    const entry = candidate.cases.find(
      ({ id }) => id === "negative-no-automatic-top-up",
    );
    entry.expected_tools.push("begin_credit_purchase");
    entry.expected_tool_sequence.push("begin_credit_purchase");
    entry.forbidden_tools = entry.forbidden_tools.filter(
      (tool) => tool !== "begin_credit_purchase",
    );
    entry.expected_effects.paid_mutation = true;
    entry.expected_effects.credit_purchase = true;
  },
);
assertGuardrailRejects(
  "Segly selection for unrelated editing",
  /selects the wrong ordered tools for unrelated_image_edit/u,
  (candidate) => {
    const entry = candidate.cases.find(
      ({ id }) => id === "negative-general-image-edit",
    );
    entry.expected_tools.push("upload_image");
    entry.expected_tool_sequence.push("upload_image");
    entry.forbidden_tools = entry.forbidden_tools.filter(
      (tool) => tool !== "upload_image",
    );
  },
);

process.stdout.write(
  `Validated ${fixture.cases.length} deterministic Segly policy-contract cases and 4 guardrail mutations against ${registeredTools.size} registered MCP tools; no model inference was run.\n`,
);
