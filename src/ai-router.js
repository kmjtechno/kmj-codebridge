const http = require("http");
function routeAIRequest(prompt, preference = "auto") {
  const isPrivateOrLocal = prompt.length < 500 || preference === "local";
  if (isPrivateOrLocal) {
    return {
      selectedProvider: "local-ollama",
      endpoint: "http://127.0.0.1:11434/api/generate",
      strategy: "LOCAL_FIRST_PRIVACY",
    };
  } else {
    return {
      selectedProvider: "cloud-approved-gateway",
      endpoint:
        process.env.CLOUD_AI_GATEWAY || "https://api.kmjtechno.com/v1/ai",
      strategy: "INTELLIGENT_CLOUD_FALLBACK",
    };
  }
}
module.exports = { routeAIRequest };
