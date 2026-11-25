const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9_-]{1,64}$/;

export function signerEnrollmentMessage(
  challenge,
  config,
  publicKey,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    !challenge ||
    Object.keys(challenge).length !== 7 ||
    challenge.organization_id !== config.tenant ||
    !uuid.test(challenge.organization_id) ||
    challenge.device_id !== config.id ||
    !id.test(challenge.device_id) ||
    !uuid.test(challenge.activation_id) ||
    !uuid.test(challenge.credential_id) ||
    !/^[1-9][0-9]{0,17}$/.test(challenge.owner_id) ||
    !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
    !Number.isSafeInteger(challenge.expires_at) ||
    challenge.expires_at <= now ||
    challenge.expires_at > now + 300 ||
    typeof publicKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)
  )
    throw Error("HOSTED_RECEIPT_ENROLLMENT_SCOPE_INVALID");
  return [
    "KMJ_CODEBRIDGE_SIGNER_ENROLLMENT_V1",
    challenge.organization_id,
    challenge.device_id,
    challenge.activation_id,
    challenge.credential_id,
    challenge.owner_id,
    challenge.nonce,
    String(challenge.expires_at),
    publicKey,
    "",
  ].join("\n");
}
