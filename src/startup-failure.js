// A gateway or agent that cannot start prints one fixed line. Without a
// reason, an operator has to reproduce the start by hand to learn why (seen on
// 2026-11-14: a config with mode 0640 kept the gateway down). Only fixed
// identifier-shaped codes are ever printed: never a message, path or value.
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function startupFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function startupFailureCode(error) {
  if (error?.name === "ZodError") return "CONFIG_SCHEMA_INVALID";
  if (error instanceof SyntaxError) return "CONFIG_JSON_INVALID";
  const code = error?.code;
  return typeof code === "string" && CODE.test(code) ? code : "UNCLASSIFIED";
}
