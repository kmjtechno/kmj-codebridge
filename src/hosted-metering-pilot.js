import { createHash, createPrivateKey, sign } from "node:crypto";
import { resolveAgentGatewayCredential } from "./agent-gateway-credential.js";
import { readJsonLimited } from "./http.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9_-]{1,64}$/;
const digest = /^[a-f0-9]{64}$/;

export function pilotRequestHash(device, project) {
  if (!id.test(device) || !id.test(project))
    throw Error("HOSTED_METERING_SCOPE_INVALID");
  return createHash("sha256")
    .update("git_status\n" + device + "\n" + project + "\n")
    .digest("hex");
}

export function pilotReceiptMessage(binding, work, config) {
  if (
    !binding ||
    Object.keys(binding).length !== 6 ||
    work.tool !== "git_status" ||
    work.id !== binding.execution_id ||
    !uuid.test(binding.execution_id) ||
    !uuid.test(binding.organization_id) ||
    binding.organization_id !== config.tenant ||
    binding.subject_key !== "account" ||
    binding.device_id !== config.id ||
    binding.device_id !== work.args?.device ||
    binding.project_id !== work.args?.project ||
    !config.projects.some((project) => project.id === binding.project_id) ||
    !digest.test(binding.request_sha256) ||
    binding.request_sha256 !==
      pilotRequestHash(binding.device_id, binding.project_id)
  )
    throw Error("HOSTED_METERING_SCOPE_INVALID");
  return [
    "KMJ_CODEBRIDGE_HOSTED_RECEIPT_V1",
    binding.organization_id,
    binding.subject_key,
    binding.execution_id,
    binding.device_id,
    binding.project_id,
    binding.request_sha256,
    "succeeded",
    "",
  ].join("\n");
}

export async function loadPilotSigner(config) {
  if (!config.hostedReceiptKeyFile) return null;
  if (config.hostedReceiptKeyFile === config.gatewayTokenFile)
    throw Error("HOSTED_RECEIPT_KEY_MUST_BE_SEPARATE");
  const encoded = await resolveAgentGatewayCredential({
    ...config,
    token: undefined,
    gatewayTokenFile: config.hostedReceiptKeyFile,
  });
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw Error("HOSTED_RECEIPT_KEY_INVALID");
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519")
      throw Error("HOSTED_RECEIPT_KEY_INVALID");
    return (message) =>
      sign(null, Buffer.from(message), key).toString("base64");
  } catch {
    throw Error("HOSTED_RECEIPT_KEY_INVALID");
  }
}

export function createHostedMeteringPilot(config, oauth, env = process.env) {
  if (!config) return null;
  const expected = oauth
    ? new URL("/api/codebridge/v1/hosted-metering-pilot", oauth.issuer).href
    : null;
  const token = env[config.tokenEnv];
  if (
    config.endpoint !== expected ||
    !uuid.test(config.tenant) ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(token)
  )
    throw Error("HOSTED_METERING_PILOT_CONFIG_INVALID");

  async function request(data) {
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error();
      return await readJsonLimited(response.body, 4096);
    } catch {
      throw Error("HOSTED_METERING_PILOT_UNAVAILABLE");
    }
  }

  return {
    tenant: config.tenant,
    async reserve(user, agent, execution, args) {
      if (
        user.dynamic !== true ||
        !/^kmj-user:[1-9][0-9]{0,17}$/.test(user.subject) ||
        agent.dynamic !== true ||
        agent.tenant !== config.tenant ||
        args.device !== agent.id ||
        !uuid.test(execution)
      )
        throw Error("HOSTED_METERING_SCOPE_INVALID");
      const hash = pilotRequestHash(agent.id, args.project);
      const result = await request({
        action: "reserve",
        organization_id: config.tenant,
        execution_id: execution,
        user_subject: user.subject,
        device_id: agent.id,
        project_id: args.project,
        tool: "git_status",
      });
      if (result?.reserved !== true || result.request_sha256 !== hash)
        throw Error("HOSTED_METERING_RESERVATION_UNVERIFIED");
      return {
        organization_id: config.tenant,
        subject_key: "account",
        execution_id: execution,
        device_id: agent.id,
        project_id: args.project,
        request_sha256: hash,
      };
    },
    async settle(binding, signature) {
      if (
        typeof signature !== "string" ||
        !/^[A-Za-z0-9+/]{86}==$/.test(signature)
      )
        throw Error("HOSTED_METERING_SIGNATURE_REQUIRED");
      const result = await request({
        action: "settle",
        organization_id: config.tenant,
        execution_id: binding.execution_id,
        outcome: "succeeded",
        signature,
      });
      if (result?.settled !== true)
        throw Error("HOSTED_METERING_SETTLEMENT_UNVERIFIED");
    },
  };
}
