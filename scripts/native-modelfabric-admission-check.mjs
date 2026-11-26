#!/usr/bin/env node
// Operator-only, GET-only check of the native ModelFabric admission path.
// Never outputs credentials, tickets, digests, upstream errors or source.
import { pathToFileURL } from "node:url";
import { createNativeModelFabricWorkerModel } from "../src/native-modelfabric-worker-model.js";

const CONFIRM = "--confirm-readonly-native-admission";
const TOKEN = /^kmjmf_[A-Za-z0-9]{48}$/;

export async function checkNativeAdmission({
  args = [],
  token,
  request = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (args.length !== 1 || args[0] !== CONFIRM)
    return "EXPLICIT_READONLY_CONFIRMATION_REQUIRED";
  if (typeof token !== "string" || !TOKEN.test(token) || token.length !== 54)
    return "SCOPED_TOKEN_NOT_CONFIGURED";
  try {
    const model = createNativeModelFabricWorkerModel({
      token,
      authorized: () => true,
      now,
      request: (url, options) => {
        if (
          url !== "https://kmjtechno.com/api/modelfabric/v1/models" ||
          options.method !== "GET" ||
          options.body !== undefined
        )
          throw Error("READONLY_ADMISSION_ONLY");
        return request(url, options);
      },
    });
    const status = await model.status();
    return status.available === true &&
      model.readiness() === "FREE_ADMISSION_CACHED"
      ? "FREE_ADMISSION_VERIFIED_AT_CHECK"
      : "FREE_ADMISSION_NOT_VERIFIED";
  } catch {
    return "FREE_ADMISSION_NOT_VERIFIED";
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const status = await checkNativeAdmission({
    args: process.argv.slice(2),
    token: process.env.CODEBRIDGE_KMJ_MODELFABRIC_TOKEN,
  });
  console.log("NATIVE_ADMISSION=" + status);
  console.log("INFERENCE=NOT_EXECUTED");
  console.log("SOURCE_TRANSFER=NONE");
  console.log("ACTIVATION=NOT_ATTEMPTED");
  process.exitCode = status === "FREE_ADMISSION_VERIFIED_AT_CHECK" ? 0 : 2;
}
