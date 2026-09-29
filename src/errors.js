export class CodeBridgeError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodeBridgeError";
    this.code = code;
  }
}
export function fail(code) {
  throw new CodeBridgeError(code);
}
export function publicError(error) {
  return {
    error: error instanceof CodeBridgeError ? error.code : "INTERNAL_ERROR",
  };
}
