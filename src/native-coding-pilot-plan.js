// Pure planning only: never reads credentials, applies config or starts a worker.
// The owner must independently verify every host and admission prerequisite.
const SOURCE = "src/skill-packs.js";
const TEST = "tests/skill-packs.test.js";
const GATE = "native_pilot_check";

export function planNativeCodingPilot({ head, ownerApprovedHead } = {}) {
  if (
    typeof head !== "string" ||
    !/^[a-f0-9]{40}$/.test(head) ||
    head !== ownerApprovedHead
  ) {
    return { status: "EXACT_SOURCE_SCOPE_REVIEW_REQUIRED" };
  }

  return {
    status: "PROPOSAL_ONLY_NOT_ACTIVATED",
    project: "kmj-codebridge",
    expectedHead: head,
    sourceScope: [SOURCE],
    gateName: GATE,
    gate: {
      command: "/opt/kmj-codebridge-node/bin/node",
      args: ["--test", TEST],
      timeoutMs: 30000,
      autopilotCodingSafe: false,
    },
    worker: {
      enabled: false,
      inferenceRoute: "native-verified-free-cloud-only",
      nativeModelFabricApproved: false,
      cloudSourceTransferApproved: false,
      cloudProxyApproved: false,
      localProcessingApproved: false,
      nativeTokenEnv: "CODEBRIDGE_KMJ_MODELFABRIC_TOKEN",
      model: "modelfabric-auto",
      maxTokens: 1024,
      timeoutSeconds: 90,
      recipes: {
        pilot: {
          verifyGate: GATE,
          paths: [SOURCE],
          contextPaths: [SOURCE],
        },
      },
    },
    taskKey: "auto-code:pilot:" + head,
    requiredBeforeActivation: [
      "OWNER_EXACT_SOURCE_TRANSFER_CONSENT",
      "PROTECTED_SCOPED_TOKEN",
      "LIVE_STRICT_FREE_ACCOUNT_AND_QUOTA",
      "EXECUTE_ENTITLEMENT_AND_ISOLATED_LANE",
      "INDEPENDENT_GATE_REVIEW",
      "SIGNED_CONFIG_VALIDATION_AND_JOB_DRAIN",
    ],
  };
}
