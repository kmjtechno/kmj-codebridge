// Pure, bounded aggregation of fixed KMJ-elite Postfix read-only diagnostics.
// This module never executes a process, touches mail files, or emits envelope identities.
const LIMIT_BYTES = 262144;
const MAX_RECORDS = 1000;
const STATES = new Set(["deferred", "active", "incoming", "hold", "maildrop", "corrupt"]);
const CODES = /\b(525|535|530|454|450)\b/;

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function stateFromUnit(raw) {
  if (typeof raw !== "string" || raw.length > 256) return "unknown";
  const m = /^ActiveState=(active|inactive|failed|activating|deactivating)$/m.exec(raw);
  return m ? m[1] : "unknown";
}
function lifetimeHours(raw) {
  const m = /^([1-9][0-9]{0,3})([dh])$/.exec(safeText(raw));
  if (!m) return null;
  const hours = Number(m[1]) * (m[2] === "d" ? 24 : 1);
  return hours > 0 && hours <= 365 * 24 ? hours : null;
}
function classify(reason) {
  if (typeof reason !== "string") return "UNCLASSIFIED";
  const code = CODES.exec(reason);
  if (code) return "SMTP_" + code[1];
  const r = reason.toLowerCase();
  if (r.includes("sasl") || r.includes("authentication failed")) return "AUTH_OTHER";
  if (r.includes("timed out") || r.includes("timeout")) return "TIMEOUT";
  if (r.includes("refused")) return "CONNECTION_REFUSED";
  if (r.includes("network is unreachable")) return "NETWORK_UNREACHABLE";
  if (r.includes("host not found") || r.includes("name service")) return "DNS";
  if (r.includes("tls") || r.includes("certificate")) return "TLS";
  return r ? "OTHER_REDACTED" : "NO_DELAY_REASON";
}
function sortedCounts(counter) {
  return Object.fromEntries(
    [...counter.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}
function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
export function aggregateEliteMailHealth(
  { queueJsonl, lifetime, relayhost, fallback, postfixState, opendkimState },
  now = Date.now(),
) {
  if (typeof queueJsonl !== "string" || Buffer.byteLength(queueJsonl) > LIMIT_BYTES)
    throw new Error("INVALID_QUEUE_INPUT");
  if (!Number.isFinite(now) || now <= 0)
    throw new Error("INVALID_CLOCK");
  const lifespan = lifetimeHours(lifetime);
  const stateCounts = new Map();
  const ageCounts = new Map();
  const delayCounts = new Map();
  let messages = 0;
  let recipients = 0;
  let unknownAge = 0;
  let oldest = null;
  for (const line of queueJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 65536) throw new Error("INVALID_QUEUE_INPUT");
    messages++;
    if (messages > MAX_RECORDS) throw new Error("QUEUE_TOO_LARGE");
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      throw new Error("INVALID_QUEUE_INPUT");
    }
    if (!m || typeof m !== "object" || Array.isArray(m) || !Array.isArray(m.recipients))
      throw new Error("INVALID_QUEUE_INPUT");
    const state = STATES.has(m.queue_name) ? m.queue_name : "unknown";
    increment(stateCounts, state);
    const t = m.arrival_time;
    if (typeof t === "number" && Number.isFinite(t) && t > 0 && t * 1000 <= now + 60000) {
      const age = Math.max(0, (now / 1000 - t) / 3600);
      oldest = oldest === null ? age : Math.max(oldest, age);
      if (lifespan === null) increment(ageCounts, "THRESHOLD_UNKNOWN");
      else if (age >= lifespan) increment(ageCounts, "AT_OR_OVER_LIFETIME");
      else if (age >= Math.max(0, lifespan - 24)) increment(ageCounts, "WITHIN_24H_OF_LIFETIME");
      else increment(ageCounts, "BELOW_WARNING_WINDOW");
    } else {
      unknownAge++;
    }
    recipients += m.recipients.length;
    if (recipients > MAX_RECORDS * 100) throw new Error("QUEUE_TOO_LARGE");
    for (const r of m.recipients) {
      if (!r || typeof r !== "object" || Array.isArray(r))
        throw new Error("INVALID_QUEUE_INPUT");
      increment(delayCounts, classify(r.delay_reason));
    }
  }
  return {
    schema: "KMJ_ELITE_MAIL_HEALTH_V1",
    mode: "READ_ONLY",
    scope: "kmj-main-platform",
    inspection: "PASS",
    postfixActive: stateFromUnit(postfixState) === "active",
    opendkimActive: stateFromUnit(opendkimState) === "active",
    directMxPrimaryConfigured: typeof relayhost === "string" && safeText(relayhost) === "",
    brevoFallbackConfigured: safeText(fallback) === "[smtp-relay.brevo.com]:587",
    queueMessages: messages,
    queueRecipients: recipients,
    queueStates: sortedCounts(stateCounts),
    queueAgeBuckets: sortedCounts(ageCounts),
    oldestHours: oldest === null ? null : Math.round(oldest * 10) / 10,
    unknownAgeMessages: unknownAge,
    maximalQueueLifetimeHours: lifespan,
    lastRecordedDelayCategories: sortedCounts(delayCounts),
    queueDrained: messages === 0,
    // Queue acceptance, clearance, and historical records are NOT inbox evidence.
    recipientDeliveryProven: false,
    rootCommandExecutedForMutation: false,
    queueMutation: "NONE",
    dnsMutation: "NONE",
  };
}
