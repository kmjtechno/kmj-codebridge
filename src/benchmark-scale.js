const percentile = (samples, fraction) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ];
};

const timed = (iterations, fn) => {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  return {
    iterations,
    p50ms: Number(percentile(samples, 0.5).toFixed(4)),
    p95ms: Number(percentile(samples, 0.95).toFixed(4)),
    maxMs: Number(Math.max(...samples).toFixed(4)),
  };
};

export function simulateControlPlaneScale({
  counts = [1, 10, 100, 1000],
  iterations = 100,
  now = 1_800_000_000_000,
  leaseMs = 30_000,
} = {}) {
  return counts.map((count) => {
    const agents = new Map();
    const lastSeen = new Map();
    const pending = new Map();
    for (let i = 0; i < count; i++) {
      const id = `device-${i}`;
      agents.set(id, {
        id,
        tenant: "tenant",
        projects: ["project"],
        online: true,
      });
      lastSeen.set(id, now - (i % 5) * 1000);
      pending.set(id, []);
    }

    const listPresence = () => {
      const visible = [];
      for (const agent of agents.values()) {
        if (now - (lastSeen.get(agent.id) ?? 0) <= leaseMs)
          visible.push(agent.id);
      }
      return visible;
    };
    for (let i = 0; i < 10; i++) listPresence();

    const presenceList = timed(iterations, listPresence);
    const heartbeatUpdate = timed(iterations, (i) => {
      const id = `device-${i % count}`;
      lastSeen.set(id, now);
    });
    const queueLookup = timed(iterations, (i) => {
      pending.get(`device-${i % count}`);
    });

    const serializedMetadataBytes = Buffer.byteLength(
      JSON.stringify([...agents.values()]),
    );
    const serializedMetadataBytesPerAgent = Number(
      (serializedMetadataBytes / count).toFixed(2),
    );
    const budget = {
      presenceListP95MsMax: 100,
      heartbeatP95MsMax: 25,
      queueLookupP95MsMax: 25,
      serializedMetadataBytesPerAgentMax: 256,
    };
    const budgetPass =
      presenceList.p95ms <= budget.presenceListP95MsMax &&
      heartbeatUpdate.p95ms <= budget.heartbeatP95MsMax &&
      queueLookup.p95ms <= budget.queueLookupP95MsMax &&
      serializedMetadataBytesPerAgent <=
        budget.serializedMetadataBytesPerAgentMax;

    return {
      agents: count,
      model: "in-process-map-simulation",
      presenceList,
      heartbeatUpdate,
      queueLookup,
      serializedMetadataBytes,
      serializedMetadataBytesPerAgent,
      budget,
      budgetPass,
    };
  });
}
