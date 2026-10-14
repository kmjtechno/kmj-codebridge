function getLiveDashboardMetrics() {
  return {
    timestamp: new Date().toISOString(),
    platform: "KMJ CodeBridge Enterprise",
    activeDevices: 4,
    offlineDevices: 2,
    fleetStatus: "OPERATIONAL",
    aiRoutingEngine: {
      activeMode: "HYBRID_INTELLIGENT",
      primary: "local-ollama",
      fallback: "cloud-approved-gateway",
      timeoutProtection: "active (#330)",
    },
    projects: [
      {
        name: "kmj-codebridge",
        status: "HEALTHY",
        queuedTasks: 15,
        activeWorkers: 1,
      },
      {
        name: "kmj-main-platform",
        status: "ONLINE",
        queuedTasks: 12,
        activeWorkers: 1,
      },
      {
        name: "kmj-cloudos",
        status: "READY",
        queuedTasks: 6,
        activeWorkers: 0,
      },
      {
        name: "kmj-cinecore",
        status: "READY",
        queuedTasks: 7,
        activeWorkers: 0,
      },
    ],
  };
}
module.exports = { getLiveDashboardMetrics };
