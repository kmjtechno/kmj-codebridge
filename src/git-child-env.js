// Never pass ModelFabric credentials to a Git subprocess (including its
// configured credential helpers, filters and external programs).
// Preserve ordinary Git environment behavior; this is not OS isolation.
export function gitChildEnvironment(source = process.env) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        !/^CODEBRIDGE_KMJ_MODELFABRIC_TOKEN/i.test(key) &&
        !(typeof value === "string" && /kmjmf_[A-Za-z0-9]{48,}/.test(value)),
    ),
  );
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
