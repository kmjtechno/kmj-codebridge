#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const P720_TARGETS = Object.freeze([
  { port: 11435, model: "qwen2.5-coder:7b" },
  { port: 11436, model: "qwen3:4b" },
]);

// Read-only, fixed-path Windows GPU identity. Ollama's size_vram indicates
// offloading but cannot identify a physical adapter by itself. Never take an
// executable, shell command, GPU path or arguments from a model or MCP client.
export function inspectP720PhysicalGpu({
  platform = process.platform,
  exists = fs.existsSync,
  run = execFileSync,
} = {}) {
  if (platform !== "win32")
    return { verification: "NOT_WINDOWS_P720", modelGpuMappingVerified: false };
  const options = {
    encoding: "utf8",
    timeout: 3500,
    windowsHide: true,
    maxBuffer: 16384,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  };
  const nvidiaPaths = [
    "C:\\Windows\\System32\\nvidia-smi.exe",
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
  ];
  for (const executable of nvidiaPaths) {
    if (!exists(executable)) continue;
    try {
      const output = String(
        run(
          executable,
          [
            "--query-gpu=index,name,driver_version,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
          ],
          options,
        ),
      );
      const devices = output
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 8)
        .map((line) => {
          const fields = line.split(",").map((v) => v.trim());
          if (fields.length !== 5) return null;
          const [index, name, driver, memoryMiB, utilizationPercent] = fields;
          if (
            !/^\d{1,2}$/.test(index) ||
            !/^[\w .()+/-]{1,100}$/.test(name) ||
            !/^[\d.]{1,32}$/.test(driver)
          )
            return null;
          return {
            index: Number(index),
            name,
            driver,
            memoryMiB: /^\d{1,7}$/.test(memoryMiB)
              ? Number(memoryMiB)
              : null,
            utilizationPercent: /^\d{1,3}$/.test(utilizationPercent)
              ? Math.min(100, Number(utilizationPercent))
              : null,
          };
        })
        .filter(Boolean);
      if (devices.length) {
        let ollamaComputeProcessObserved = null;
        try {
          const processes = String(
            run(
              executable,
              [
                "--query-compute-apps=process_name",
                "--format=csv,noheader,nounits",
              ],
              options,
            ),
          );
          ollamaComputeProcessObserved = processes
            .split(/\r?\n/)
            .some((name) => /(?:^|[\\/])ollama(?:\.exe)?$/i.test(name.trim()));
        } catch {
          // Windows WDDM may not expose compute processes through NVML.
        }
        return {
          verification: "WINDOWS_NVIDIA_GPU_INVENTORY_VERIFIED",
          devices,
          ollamaComputeProcessObserved,
          modelGpuMappingVerified: false,
        };
      }
    } catch {
      // Only fall back to a fixed-path read-only OS adapter query.
    }
  }
  const powershell =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (exists(powershell)) {
    try {
      const raw = String(
        run(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress",
          ],
          options,
        ),
      );
      const value = JSON.parse(raw);
      const rows = (Array.isArray(value) ? value : [value])
        .filter((v) => typeof v?.Name === "string")
        .slice(0, 8)
        .map((v) => ({
          name: v.Name.slice(0, 100),
          driver: String(v.DriverVersion ?? "unknown").slice(0, 32),
        }));
      if (rows.length)
        return {
          verification: "WINDOWS_DISPLAY_ADAPTER_INVENTORY_ONLY",
          devices: rows,
          modelGpuMappingVerified: false,
        };
    } catch {
      // Unavailable CIM data is not evidence of absent hardware.
    }
  }
  return {
    verification: "GPU_IDENTITY_NOT_VERIFIED",
    modelGpuMappingVerified: false,
  };
}

function loopbackUrl(port, route) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("INVALID_LOCAL_PORT");
  }
  return `http://127.0.0.1:${port}${route}`;
}

async function jsonRequest(fetchImpl, port, route, init = {}) {
  const response = await fetchImpl(loopbackUrl(port, route), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

export async function inspectP720Target(target, fetchImpl = fetch) {
  const { port, model } = target;
  const record = { port, model, status: "BLOCKED" };
  try {
    const version = await jsonRequest(fetchImpl, port, "/api/version");
    record.ollamaVersion = String(version.version ?? "unknown");

    const tags = await jsonRequest(fetchImpl, port, "/api/tags");
    const installed = Array.isArray(tags.models)
      ? tags.models.some((item) => item.name === model || item.model === model)
      : false;
    if (!installed) {
      record.reason = "MODEL_NOT_INSTALLED";
      return record;
    }

    const generated = await jsonRequest(fetchImpl, port, "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "Write a JavaScript function that adds two integers.",
        stream: false,
        think: false,
        keep_alive: "30s",
        options: { num_ctx: 2048, num_predict: 48, temperature: 0 },
      }),
    });
    if (
      generated.done !== true ||
      !(Number(generated.eval_count) > 0) ||
      !(Number(generated.eval_duration) > 0)
    ) {
      record.reason = "GENERATION_NOT_VERIFIED";
      return record;
    }
    const visibleText = String(generated.response ?? "").trim();
    if (!visibleText) {
      record.reason = String(generated.thinking ?? "").trim()
        ? "THINKING_ONLY_NO_VISIBLE_TEXT"
        : "EMPTY_GENERATION";
      record.evalTokens = Number(generated.eval_count);
      return record;
    }

    record.evalTokens = Number(generated.eval_count);
    record.tokensPerSecond = Number(
      (
        (record.evalTokens * 1000000000) /
        Number(generated.eval_duration)
      ).toFixed(2),
    );

    const running = await jsonRequest(fetchImpl, port, "/api/ps");
    const loaded = Array.isArray(running.models)
      ? running.models.find(
          (item) => item.name === model || item.model === model,
        )
      : null;
    const vramBytes = loaded ? Number(loaded.size_vram) : NaN;
    record.gpuOffloadBytes = Number.isFinite(vramBytes) ? vramBytes : null;
    if (Number.isFinite(vramBytes) && vramBytes > 0) {
      record.status = "PASS";
      record.reason = "GENERATION_AND_GPU_OFFLOAD_VERIFIED";
    } else {
      record.status = "WARN";
      record.reason = "GENERATION_OK_GPU_OFFLOAD_NOT_VERIFIED";
    }
  } catch (error) {
    record.reason = "ENDPOINT_OR_INFERENCE_FAILED";
    record.error = String(error?.message ?? error).slice(0, 180);
  }
  return record;
}

export async function inspectP720Fleet(
  targets = P720_TARGETS,
  fetchImpl = fetch,
  hardwareProbe = inspectP720PhysicalGpu,
) {
  const results = [];
  // Sequential loads avoid memory-pressure spikes on a 32 GB workstation.
  for (const target of targets) {
    results.push(await inspectP720Target(target, fetchImpl));
  }
  return {
    device: "P720",
    mode: "readiness-only",
    note: "Physical adapter identity and local model offload are separately checked; model-to-GPU process attribution is not proven by VRAM bytes. No downloads, deployment or paid API.",
    gpuHardware: hardwareProbe(),
    results,
    allPassed: results.every((result) => result.status === "PASS"),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await inspectP720Fleet();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.allPassed ? 0 : 2;
}
