import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MonitorOptions } from "./model.js";
import { type EndpointInfo, type ProcessInfo } from "./types.js";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 2_500;
const dockerDiscoveryTimeoutMs = 15_000;
const dockerMonitorContainerTimeoutMs = 120_000;
const ros2GraphTimeoutMs = 25_000;
const ros2GraphCacheMs = 30_000;
const maxRos2HzSamplesPerTick = 1;
const maxCycloneDdsSamplesPerTick = 1;
const nativeCycloneDdsHelperSource = "monitor/pr-monitor/native/cyclonedds_sample.cpp";
const hostNativeCycloneDdsHelperBinary = ".cache/pr-monitor/cyclonedds_sample-host";
const containerNativeCycloneDdsHelperBinary = ".cache/pr-monitor/cyclonedds_sample-container";

export interface CollectorSample {
  url: string;
  source: string;
  timestamp: number;
  freq?: number;
  rate?: number;
  loss?: number;
  latency?: number;
  countDelta?: number;
  size?: number;
  active?: boolean;
  status?: string;
  preview?: string;
  processList?: ProcessInfo[];
}

export interface CollectorStatus {
  name: string;
  ok: boolean;
  message: string;
  updatedAt: number;
}

export interface CollectorSnapshot {
  samples: CollectorSample[];
  status: CollectorStatus;
}

export interface Collector {
  name: string;
  collect(endpoints: EndpointInfo[]): Promise<CollectorSnapshot>;
}

export function createCollectors(options: MonitorOptions): Collector[] {
  return [
    new ProcessCollector(),
    new PrometheusCollector(options.prometheusUrl),
    new CycloneDdsCollector(options.ros2SampleSeconds),
    new Ros2Collector(options.ros2SampleSeconds),
  ];
}

class ProcessCollector implements Collector {
  readonly name = "process";

  async collect(endpoints: EndpointInfo[]): Promise<CollectorSnapshot> {
    const startedAt = Date.now();
    let stdout = "";
    try {
      const result = await execFileAsync("ps", ["-axo", "pid=,pcpu=,comm=,args="], { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024 * 4 });
      stdout = result.stdout;
    } catch (error) {
      return {
        samples: [],
        status: {
          name: this.name,
          ok: false,
          message: `ps unavailable: ${errorMessage(error)}`,
          updatedAt: startedAt,
        },
      };
    }

    const processes = parseProcessTable(stdout);
    const samples: CollectorSample[] = [];
    for (const endpoint of endpoints) {
      const matched = matchProcesses(endpoint, processes);
      if (matched.length === 0) continue;
      samples.push({
        url: endpoint.url,
        source: this.name,
        timestamp: startedAt,
        status: `${matched.length} matching local process${matched.length === 1 ? "" : "es"}`,
        processList: matched,
      });
    }

    return {
      samples,
      status: {
        name: this.name,
        ok: true,
        message: `${samples.length} routes matched local process table`,
        updatedAt: startedAt,
      },
    };
  }
}

class PrometheusCollector implements Collector {
  readonly name = "prometheus";
  private readonly endpoint: string;
  private readonly previousCount = new Map<string, { value: number; timestamp: number }>();

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  async collect(endpoints: EndpointInfo[]): Promise<CollectorSnapshot> {
    const startedAt = Date.now();
    if (!this.endpoint) {
      return {
        samples: [],
        status: { name: this.name, ok: false, message: "disabled: no Prometheus URL", updatedAt: startedAt },
      };
    }

    let countSeries: PrometheusSeries[] = [];
    let latencySeries: PrometheusSeries[] = [];
    try {
      [countSeries, latencySeries] = await Promise.all([
        this.querySeries('pacific_rim_message_count_total or pacific_rim_message_count or pacific_rim_message_count_sum'),
        this.querySeries(
          [
            "pacific_rim_message_latency",
            "pacific_rim_message_latency_milliseconds",
            "(rate(pacific_rim_message_latency_sum[2m]) / rate(pacific_rim_message_latency_count[2m]))",
            "(rate(pacific_rim_message_latency_milliseconds_sum[2m]) / rate(pacific_rim_message_latency_milliseconds_count[2m]))",
          ].join(" or "),
        ),
      ]);
    } catch (error) {
      return {
        samples: [],
        status: {
          name: this.name,
          ok: false,
          message: `${this.endpoint} unavailable: ${errorMessage(error)}`,
          updatedAt: startedAt,
        },
      };
    }

    const samples: CollectorSample[] = [];
    for (const endpoint of endpoints) {
      const count = bestSeriesForEndpoint(endpoint, countSeries);
      const latency = bestSeriesForEndpoint(endpoint, latencySeries);
      if (!count && !latency) continue;

      const sample: CollectorSample = {
        url: endpoint.url,
        source: this.name,
        timestamp: startedAt,
        active: true,
        status: "observed in Prometheus",
        preview: "Prometheus runtime metric sample",
      };

      if (count) {
        const previous = this.previousCount.get(endpoint.url);
        const value = count.value;
        const elapsedSec = previous ? Math.max(0.001, (startedAt - previous.timestamp) / 1000) : 0;
        const delta = previous ? Math.max(0, value - previous.value) : 0;
        this.previousCount.set(endpoint.url, { value, timestamp: startedAt });
        sample.countDelta = delta;
        if (previous) sample.freq = delta / elapsedSec;
      }

      if (latency) {
        sample.latency = latency.value;
      }

      samples.push(sample);
    }

    return {
      samples,
      status: {
        name: this.name,
        ok: true,
        message: `${countSeries.length + latencySeries.length} metric series, ${samples.length} route matches`,
        updatedAt: startedAt,
      },
    };
  }

  private async querySeries(query: string): Promise<PrometheusSeries[]> {
    const url = new URL("/api/v1/query", this.endpoint);
    url.searchParams.set("query", query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), commandTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = (await response.json()) as PrometheusResponse;
      if (body.status !== "success") throw new Error(body.error || "query failed");
      return body.data.result
        .map((item) => {
          const raw = item.value?.[1];
          const value = typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
          return Number.isFinite(value) ? { metric: item.metric, value } : undefined;
        })
        .filter((item): item is PrometheusSeries => Boolean(item));
    } finally {
      clearTimeout(timer);
    }
  }
}

class CycloneDdsCollector implements Collector {
  readonly name = "cyclonedds";
  private readonly sampleSeconds: number;
  private sampleCursor = 0;

  constructor(sampleSeconds: number) {
    this.sampleSeconds = Math.max(1, sampleSeconds);
  }

  async collect(endpoints: EndpointInfo[]): Promise<CollectorSnapshot> {
    const startedAt = Date.now();
    const ddsRoutes = endpoints.filter((endpoint) => endpoint.url.startsWith("cyclonedds://"));
    if (ddsRoutes.length === 0) {
      return {
        samples: [],
        status: { name: this.name, ok: true, message: "no native CycloneDDS routes discovered", updatedAt: startedAt },
      };
    }

    const sampleBudget = ddsRoutes.slice(this.sampleCursor, this.sampleCursor + maxCycloneDdsSamplesPerTick);
    if (sampleBudget.length < maxCycloneDdsSamplesPerTick) {
      sampleBudget.push(...ddsRoutes.slice(0, maxCycloneDdsSamplesPerTick - sampleBudget.length));
    }
    this.sampleCursor = ddsRoutes.length === 0 ? 0 : (this.sampleCursor + maxCycloneDdsSamplesPerTick) % ddsRoutes.length;

    const samples: CollectorSample[] = [];
    let samplerLabel = "";
    try {
      const sampler = await resolveNativeCycloneDdsSampler();
      samplerLabel = sampler.label;
      for (const endpoint of sampleBudget) {
        const route = routeFromUrl(endpoint.url);
        const result = await sampler.sample(route, this.sampleSeconds);
        const active = result.count > 0;
        samples.push({
          url: endpoint.url,
          source: this.name,
          timestamp: Date.now(),
          active,
          freq: result.freq,
          rate: result.rate,
          latency: result.latency_ms,
          countDelta: result.count,
          size: result.count > 0 ? result.bytes / result.count : 0,
          status: active ? `native CycloneDDS sample via ${sampler.label}` : `native CycloneDDS sampled via ${sampler.label}; no messages`,
          preview:
            `${route} domain=${result.domain_id} count=${result.count} freq=${result.freq.toFixed(2)}Hz rate=${formatRate(result.rate)}` +
            (result.latency_ms !== undefined ? ` latency=${result.latency_ms.toFixed(2)}ms` : ""),
        });
      }
    } catch (error) {
      nativeCycloneDdsSampler = null;
      return {
        samples,
        status: {
          name: this.name,
          ok: false,
          message: `native sampler unavailable: ${errorMessage(error)}`,
          updatedAt: startedAt,
        },
      };
    }

    const activeCount = samples.filter((sample) => sample.active).length;
    return {
      samples,
      status: {
        name: this.name,
        ok: true,
        message: `${sampleBudget.length} native route sample${sampleBudget.length === 1 ? "" : "s"} via ${samplerLabel}, ${activeCount} active`,
        updatedAt: startedAt,
      },
    };
  }
}

class Ros2Collector implements Collector {
  readonly name = "ros2";
  private readonly sampleSeconds: number;
  private readonly typeByRoute = new Map<string, string>();
  private runtime: Ros2Runtime | null = null;
  private graphCache: { topics: string[]; services: string[]; timestamp: number } | null = null;
  private sampleCursor = 0;

  constructor(sampleSeconds: number) {
    this.sampleSeconds = Math.max(1, sampleSeconds);
  }

  async collect(endpoints: EndpointInfo[]): Promise<CollectorSnapshot> {
    const startedAt = Date.now();
    const ros2Routes = endpoints.filter((endpoint) => endpointRuntimeUrl(endpoint).startsWith("ros2://"));
    if (ros2Routes.length === 0) {
      return {
        samples: [],
        status: { name: this.name, ok: true, message: "no ROS2 routes discovered", updatedAt: startedAt },
      };
    }

    let topics: string[] = [];
    let services: string[] = [];
    try {
      const graph = await this.getGraph();
      topics = graph.topics;
      services = graph.services;
    } catch (error) {
      return {
        samples: [],
        status: {
          name: this.name,
          ok: false,
          message: `ros2 CLI unavailable or daemon not running: ${errorMessage(error)}`,
          updatedAt: startedAt,
        },
      };
    }

    const live = new Set([...topics, ...services].map((route) => routeUrl(route)));
    const observedAt = Date.now();
    const samples: CollectorSample[] = [];
    const liveEndpoints = ros2Routes.filter((endpoint) => live.has(endpointRuntimeUrl(endpoint)));
    const hzBudget = liveEndpoints
      .filter((endpoint) => topics.includes(routeFromUrl(endpointRuntimeUrl(endpoint))))
      .slice(this.sampleCursor, this.sampleCursor + maxRos2HzSamplesPerTick);
    if (hzBudget.length < maxRos2HzSamplesPerTick) {
      hzBudget.push(
        ...liveEndpoints
          .filter((endpoint) => topics.includes(routeFromUrl(endpointRuntimeUrl(endpoint))))
          .slice(0, maxRos2HzSamplesPerTick - hzBudget.length),
      );
    }
    this.sampleCursor = liveEndpoints.length === 0 ? 0 : (this.sampleCursor + maxRos2HzSamplesPerTick) % liveEndpoints.length;
    const hzUrls = new Set(hzBudget.map((endpoint) => endpoint.url));

    for (const endpoint of liveEndpoints) {
      const runtimeUrl = endpointRuntimeUrl(endpoint);
      if (!live.has(runtimeUrl)) continue;
      const route = routeFromUrl(runtimeUrl);
      const topic = topics.includes(route);
      const statusPrefix = endpoint.url.startsWith("cyclonedds://") && endpoint.runtimeUrl ? "CycloneDDS RMW" : "ROS2";
      const sample: CollectorSample = {
        url: endpoint.url,
        source: this.name,
        timestamp: observedAt,
        active: true,
        status: topic ? `${statusPrefix} topic discovered` : `${statusPrefix} service discovered`,
        preview: this.typeByRoute.get(route) ? `${route} [${this.typeByRoute.get(route)}]` : route,
      };

      if (topic && hzUrls.has(endpoint.url)) {
        const runtime = await this.resolveRuntime();
        const [hz, bandwidth, latency] = await Promise.all([
          sampleTopicHz(runtime, route, this.sampleSeconds),
          sampleTopicBandwidth(runtime, route, this.sampleSeconds),
          sampleTopicEnvelopeLatency(runtime, route, this.sampleSeconds),
        ]);
        if (hz.ok) {
          sample.freq = hz.freq;
          sample.timestamp = Date.now();
          sample.status = `${statusPrefix} topic hz`;
          sample.preview = hz.preview;
        } else {
          sample.status = `${statusPrefix} topic discovered; hz unavailable: ${hz.error}`;
        }
        if (bandwidth.ok) {
          sample.rate = bandwidth.rate;
          sample.size = bandwidth.size;
          sample.timestamp = Date.now();
          sample.status = hz.ok ? `${statusPrefix} topic hz/bw` : `${statusPrefix} topic bw`;
          sample.preview = hz.ok ? `${hz.preview} | ${bandwidth.preview}` : bandwidth.preview;
        }
        if (latency.ok) {
          sample.latency = latency.latency;
          sample.timestamp = Date.now();
          sample.status = bandwidth.ok ? `${sample.status}/latency` : `${statusPrefix} topic latency`;
          sample.preview = `${sample.preview} | ${latency.preview}`;
        }
      }
      samples.push(sample);
    }

    return {
      samples,
      status: {
        name: this.name,
        ok: true,
        message: `${topics.length} topics, ${services.length} services, ${samples.length} route matches`,
        updatedAt: startedAt,
      },
    };
  }

  private async resolveRuntime(): Promise<Ros2Runtime> {
    if (this.runtime) return this.runtime;
    const containerId = await findRos2Container();
    if (containerId) {
      this.runtime = new DockerRos2Runtime(containerId);
      return this.runtime;
    }
    if (await commandAvailable("ros2")) {
      this.runtime = new HostRos2Runtime();
      return this.runtime;
    }
    throw new Error("ros2 CLI unavailable and no running ros2 container was found");
  }

  private async getGraph() {
    const now = Date.now();
    if (this.graphCache && now - this.graphCache.timestamp < ros2GraphCacheMs) return this.graphCache;

    const runtime = await this.resolveRuntime();
    const [topicList, serviceList] = await Promise.all([
      runtime.run(["topic", "list"], ros2GraphTimeoutMs),
      runtime.run(["service", "list"], ros2GraphTimeoutMs),
    ]);
    const graph = {
      topics: parseRos2List(topicList.stdout, this.typeByRoute),
      services: parseRos2List(serviceList.stdout, this.typeByRoute),
      timestamp: Date.now(),
    };
    this.graphCache = graph;
    return graph;
  }
}

interface Ros2CommandResult {
  stdout: string;
  stderr: string;
}

interface Ros2Runtime {
  run(args: string[], timeoutMs?: number): Promise<Ros2CommandResult>;
}

class HostRos2Runtime implements Ros2Runtime {
  async run(args: string[], timeoutMs = commandTimeoutMs): Promise<Ros2CommandResult> {
    return execFileAsync("ros2", args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 2,
    });
  }
}

class DockerRos2Runtime implements Ros2Runtime {
  constructor(private readonly containerId: string) {}

  async run(args: string[], timeoutMs = commandTimeoutMs): Promise<Ros2CommandResult> {
    const rmw = process.env.RMW_IMPLEMENTATION || "rmw_cyclonedds_cpp";
    const command = shellQuote(["ros2", ...args]);
    const timeoutSeconds = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
    const legacyInstallSetup = shellSingleQuote("install/setup.bash");
    return execFileAsync(
      "docker",
      [
        "exec",
        "--env",
        `RMW_IMPLEMENTATION=${rmw}`,
        this.containerId,
        "timeout",
        "--kill-after=1s",
        timeoutSeconds,
        "bash",
        "-lc",
        [
          `ros_distro="\${ROS_DISTRO:-humble}"`,
          `source "/opt/ros/$ros_distro/setup.bash"`,
          `install_setup="install/$ros_distro/setup.bash"`,
          `if [[ ! -f "$install_setup" && -f ${legacyInstallSetup} ]]; then install_setup=${legacyInstallSetup}; fi`,
          `if [[ -f "$install_setup" ]]; then source "$install_setup"; fi`,
          command,
        ].join("; "),
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 2,
      },
    );
  }
}

async function sampleTopicHz(
  runtime: Ros2Runtime,
  route: string,
  seconds: number,
): Promise<{ ok: true; freq: number; preview: string } | { ok: false; error: string }> {
  const timeoutSeconds = Math.max(4, seconds + 3);
  try {
    const result = await runtime.run(["topic", "hz", route], (timeoutSeconds + 2) * 1000);
    const output = result.stdout + result.stderr;
    const match = output.match(/average rate:\s*([0-9.]+)/);
    if (!match?.[1]) return { ok: false, error: "no average rate" };
    return { ok: true, freq: Number.parseFloat(match[1]), preview: compact(output) };
  } catch (error) {
    const output = processOutput(error);
    const match = output.match(/average rate:\s*([0-9.]+)/);
    if (match?.[1]) {
      return { ok: true, freq: Number.parseFloat(match[1]), preview: compact(output) };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

async function sampleTopicBandwidth(
  runtime: Ros2Runtime,
  route: string,
  seconds: number,
): Promise<{ ok: true; rate: number; size: number; preview: string } | { ok: false; error: string }> {
  const timeoutSeconds = Math.max(4, seconds + 3);
  try {
    const result = await runtime.run(["topic", "bw", route], (timeoutSeconds + 2) * 1000);
    const output = result.stdout + result.stderr;
    const parsed = parseTopicBandwidth(output);
    if (!parsed) return { ok: false, error: "no bandwidth sample" };
    return { ...parsed, preview: compact(output) };
  } catch (error) {
    const output = processOutput(error);
    const parsed = parseTopicBandwidth(output);
    if (parsed) return { ...parsed, preview: compact(output) };
    return { ok: false, error: errorMessage(error) };
  }
}

async function sampleTopicEnvelopeLatency(
  runtime: Ros2Runtime,
  route: string,
  seconds: number,
): Promise<{ ok: true; latency: number; preview: string } | { ok: false; error: string }> {
  const timeoutSeconds = Math.max(4, seconds + 3);
  try {
    const result = await runtime.run(
      ["topic", "echo", "--once", "--timeout", String(timeoutSeconds), "--include-message-info", "--field", "created_at_unix_ms", route],
      (timeoutSeconds + 2) * 1000,
    );
    const output = result.stdout + result.stderr;
    const latency = parseEnvelopeLatency(output);
    if (latency === null) return { ok: false, error: "no envelope timestamp" };
    return { ok: true, latency, preview: `latency ${latency.toFixed(2)}ms` };
  } catch (error) {
    const output = processOutput(error);
    const latency = parseEnvelopeLatency(output);
    if (latency !== null) return { ok: true, latency, preview: `latency ${latency.toFixed(2)}ms` };
    return { ok: false, error: errorMessage(error) };
  }
}

interface NativeCycloneDdsSample {
  topic: string;
  domain_id: number;
  count: number;
  bytes: number;
  elapsed_sec: number;
  freq: number;
  rate: number;
  latency_ms?: number;
}

interface RosRuntimeContext {
  domainId: string;
  rosDistro: string;
  source: string;
}

interface NativeCycloneDdsSampler {
  label: string;
  sample(route: string, seconds: number): Promise<NativeCycloneDdsSample>;
}

let nativeCycloneDdsSampler: NativeCycloneDdsSampler | null = null;
let nativeCycloneDdsSamplerKey = "";
let rosRuntimeContextCache: { contexts: RosRuntimeContext[]; timestamp: number } | null = null;
const dockerMonitorContainerCache = new Map<string, Promise<string>>();

class HostNativeCycloneDdsSampler implements NativeCycloneDdsSampler {
  readonly label: string;

  constructor(private readonly helperPath: string, private readonly context: RosRuntimeContext) {
    this.label = `host:d${context.domainId}`;
  }

  async sample(route: string, seconds: number): Promise<NativeCycloneDdsSample> {
    const timeoutSeconds = Math.max(2, seconds + 2);
    const result = await execFileAsync(
      this.helperPath,
      nativeCycloneDdsSampleArgs(route, seconds, this.context.domainId),
      {
        env: nativeCycloneDdsEnv(this.context),
        timeout: (timeoutSeconds + 1) * 1000,
        maxBuffer: 1024 * 256,
      },
    );
    return parseNativeCycloneDdsSample(result.stdout + result.stderr);
  }
}

class DockerNativeCycloneDdsSampler implements NativeCycloneDdsSampler {
  readonly label: string;
  private helperReady = false;
  private containerId = "";

  constructor(private readonly context: RosRuntimeContext) {
    this.label = `monitor-container:${context.rosDistro}:d${context.domainId}`;
  }

  async sample(route: string, seconds: number): Promise<NativeCycloneDdsSample> {
    await this.ensureHelper();
    const timeoutSeconds = Math.max(2, seconds + 2);
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        ...nativeCycloneDdsDockerEnvArgs(this.context),
        this.containerId,
        "timeout",
        "--kill-after=1s",
        `${timeoutSeconds}s`,
        `/workspace/${containerNativeCycloneDdsHelperBinary}`,
        ...nativeCycloneDdsSampleArgs(route, seconds, this.context.domainId),
      ],
      {
        timeout: (timeoutSeconds + 2) * 1000,
        maxBuffer: 1024 * 256,
      },
    );
    return parseNativeCycloneDdsSample(result.stdout + result.stderr);
  }

  private async ensureHelper() {
    if (this.helperReady) return;
    this.containerId = await ensureNativeCycloneDdsMonitorContainer(this.context.rosDistro);

    const source = shellSingleQuote(nativeCycloneDdsHelperSource);
    const output = shellSingleQuote(containerNativeCycloneDdsHelperBinary);
    const command = [
      "set -e",
      "cd /workspace",
      `src=${source}`,
      `out=${output}`,
      'if [[ ! -x "$out" || "$src" -nt "$out" ]]; then mkdir -p "$(dirname "$out")"; c++ -std=c++17 -O2 -I /workspace -I /workspace/infra/communication/cpp/include "$src" -o "$out" $(pkg-config --cflags --libs CycloneDDS); fi',
    ].join("; ");

    await execFileAsync("docker", ["exec", this.containerId, "bash", "-lc", command], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    this.helperReady = true;
  }
}

class MultiNativeCycloneDdsSampler implements NativeCycloneDdsSampler {
  readonly label: string;

  constructor(private readonly samplers: NativeCycloneDdsSampler[], label: string) {
    this.label = label;
  }

  async sample(route: string, seconds: number): Promise<NativeCycloneDdsSample> {
    const settled = await Promise.allSettled(this.samplers.map((sampler) => sampler.sample(route, seconds)));
    const samples = settled
      .filter((item): item is PromiseFulfilledResult<NativeCycloneDdsSample> => item.status === "fulfilled")
      .map((item) => item.value);
    if (samples.length === 0) {
      const errors = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => errorMessage(item.reason))
        .slice(0, 3)
        .join("; ");
      throw new Error(errors || "no native CycloneDDS sampler succeeded");
    }

    const best = samples.sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      return right.rate - left.rate;
    })[0];
    if (!best) throw new Error("no native CycloneDDS samples were produced");
    return best;
  }
}

async function resolveNativeCycloneDdsSampler(): Promise<NativeCycloneDdsSampler> {
  const contexts = await discoverRosRuntimeContexts();
  const contextKey = rosRuntimeContextKey(contexts);
  if (nativeCycloneDdsSampler && nativeCycloneDdsSamplerKey === contextKey) return nativeCycloneDdsSampler;

  let hostError: unknown = null;
  try {
    const helperPath = await ensureHostNativeCycloneDdsHelper();
    nativeCycloneDdsSampler = new MultiNativeCycloneDdsSampler(
      contexts.map((context) => new HostNativeCycloneDdsSampler(helperPath, context)),
      `host domains ${contexts.map((context) => context.domainId).join(",")}`,
    );
    nativeCycloneDdsSamplerKey = contextKey;
    return nativeCycloneDdsSampler;
  } catch (error) {
    hostError = error;
  }

  try {
    nativeCycloneDdsSampler = new MultiNativeCycloneDdsSampler(
      contexts.map((context) => new DockerNativeCycloneDdsSampler(context)),
      `monitor containers domains ${contexts.map((context) => context.domainId).join(",")}`,
    );
    nativeCycloneDdsSamplerKey = contextKey;
    return nativeCycloneDdsSampler;
  } catch (containerError) {
    nativeCycloneDdsSampler = null;
    nativeCycloneDdsSamplerKey = "";
    throw new Error(`host ${errorMessage(hostError)}; monitor container ${errorMessage(containerError)}`);
  }
}

async function ensureHostNativeCycloneDdsHelper() {
  const root = process.cwd();
  const sourcePath = join(root, nativeCycloneDdsHelperSource);
  const binaryPath = join(root, hostNativeCycloneDdsHelperBinary);
  if (!helperNeedsBuild(sourcePath, binaryPath)) {
    return binaryPath;
  }

  mkdirSync(join(root, ".cache", "pr-monitor"), { recursive: true });
  const pkgConfig = await execFileAsync("pkg-config", ["--cflags", "--libs", "CycloneDDS"], {
    timeout: commandTimeoutMs,
    maxBuffer: 1024 * 128,
  });
  const pkgConfigArgs = splitCompilerArgs(pkgConfig.stdout);
  await execFileAsync(
    "c++",
    [
      "-std=c++17",
      "-O2",
      "-I",
      root,
      "-I",
      join(root, "infra", "communication", "cpp", "include"),
      sourcePath,
      "-o",
      binaryPath,
      ...pkgConfigArgs,
    ],
    {
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4,
    },
  );
  return binaryPath;
}

async function discoverRosRuntimeContexts() {
  const now = Date.now();
  if (rosRuntimeContextCache && now - rosRuntimeContextCache.timestamp < ros2GraphCacheMs) {
    return rosRuntimeContextCache.contexts;
  }

  const contexts = dedupeRosRuntimeContexts([
    ...explicitRosRuntimeContexts(),
    ...(await dockerRosRuntimeContexts()),
    ...procRosRuntimeContexts(),
  ]);

  const result = contexts.length > 0 ? contexts : [defaultRosRuntimeContext()];
  rosRuntimeContextCache = { contexts: result, timestamp: now };
  return result;
}

function explicitRosRuntimeContexts(): RosRuntimeContext[] {
  const domainIds = parseDomainIds(process.env.PR_MONITOR_ROS_DOMAIN_IDS || process.env.ROS_DOMAIN_IDS || "");
  if (domainIds.length > 0) {
    return domainIds.map((domainId) => ({
      domainId,
      rosDistro: normalizeRosDistro(process.env.PR_MONITOR_ROS_DISTRO || process.env.ROS_DISTRO || ""),
      source: "env:PR_MONITOR_ROS_DOMAIN_IDS",
    }));
  }

  const domainId = normalizeDomainId(process.env.PR_MONITOR_ROS_DOMAIN_ID || process.env.ROS_DOMAIN_ID || "");
  if (!domainId) return [];
  return [{
    domainId,
    rosDistro: normalizeRosDistro(process.env.PR_MONITOR_ROS_DISTRO || process.env.ROS_DISTRO || ""),
    source: "env:ROS_DOMAIN_ID",
  }];
}

async function dockerRosRuntimeContexts(): Promise<RosRuntimeContext[]> {
  try {
    const result = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.ID}}\t{{.Names}}"],
      { timeout: dockerDiscoveryTimeoutMs, maxBuffer: 1024 * 256 },
    );
    const containers = result.stdout
      .split(/\r?\n/)
      .map((line) => {
        const [id, name = ""] = line.trim().split(/\s+/, 2);
        return { id: id ?? "", name };
      })
      .filter((item) => item.id && /(pacific-rim|ros2|cyclonedds)/i.test(item.name))
      .slice(0, 32);

    const contexts: RosRuntimeContext[] = [];
    for (const container of containers) {
      const inspect = await execFileAsync("docker", ["inspect", "--format", "{{json .Config.Env}}", container.id], {
        timeout: commandTimeoutMs,
        maxBuffer: 1024 * 128,
      });
      const env = envObjectFromDockerInspect(inspect.stdout);
      const fromEnv = contextFromEnv(env, `docker:${container.name}`);
      if (fromEnv) {
        contexts.push(fromEnv);
        continue;
      }
      const fromName = contextFromContainerName(container.name);
      if (fromName) contexts.push(fromName);
    }
    return contexts;
  } catch {
    return [];
  }
}

function procRosRuntimeContexts(): RosRuntimeContext[] {
  if (!existsSync("/proc")) return [];

  const contexts: RosRuntimeContext[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).slice(0, 512);
  } catch {
    return [];
  }

  for (const pid of pids) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!environ.includes("ROS_DOMAIN_ID=") && !environ.includes("ROS_DISTRO=")) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!/(pacific[-_ ]rim|ros2|_node|cyclonedds)/i.test(cmdline)) continue;
      const env = envObjectFromNullSeparated(environ);
      const context = contextFromEnv(env, `proc:${pid}`);
      if (context) contexts.push(context);
    } catch {
      // Processes can exit or hide their environment while scanning.
    }
  }
  return contexts;
}

function contextFromEnv(env: Record<string, string>, source: string): RosRuntimeContext | null {
  const domainId = normalizeDomainId(env.ROS_DOMAIN_ID || "");
  if (!domainId) return null;
  return {
    domainId,
    rosDistro: normalizeRosDistro(env.ROS_DISTRO || process.env.ROS_DISTRO || ""),
    source,
  };
}

function contextFromContainerName(name: string): RosRuntimeContext | null {
  const match = name.match(/(?:^|[-_])([a-z]+)(?:[-_])d(\d+)(?:$|[-_])/i);
  if (!match?.[2]) return null;
  return {
    domainId: match[2],
    rosDistro: normalizeRosDistro(match[1] ?? process.env.ROS_DISTRO ?? ""),
    source: `docker-name:${name}`,
  };
}

function envObjectFromDockerInspect(output: string) {
  try {
    const values = JSON.parse(output.trim()) as string[];
    return envObjectFromEntries(Array.isArray(values) ? values : []);
  } catch {
    return {};
  }
}

function envObjectFromNullSeparated(value: string) {
  return envObjectFromEntries(value.split("\0"));
}

function envObjectFromEntries(values: string[]) {
  const env: Record<string, string> = {};
  for (const item of values) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    env[item.slice(0, index)] = item.slice(index + 1);
  }
  return env;
}

function parseDomainIds(value: string) {
  const out: string[] = [];
  for (const part of value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range?.[1] && range[2]) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      if (Number.isInteger(start) && Number.isInteger(end) && start <= end && end - start <= 64) {
        for (let domain = start; domain <= end; domain += 1) out.push(String(domain));
      }
      continue;
    }
    const normalized = normalizeDomainId(part);
    if (normalized) out.push(normalized);
  }
  return [...new Set(out)];
}

function normalizeDomainId(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return "";
  const domainId = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(domainId) || domainId < 0 || domainId > 232) return "";
  return String(domainId);
}

function normalizeRosDistro(value: string) {
  return sanitizeContainerNamePart(value.trim() || "humble");
}

function dedupeRosRuntimeContexts(contexts: RosRuntimeContext[]) {
  const byKey = new Map<string, RosRuntimeContext>();
  for (const context of contexts) {
    const domainId = normalizeDomainId(context.domainId);
    if (!domainId) continue;
    const rosDistro = normalizeRosDistro(context.rosDistro);
    const key = `${domainId}:${rosDistro}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...context, domainId, rosDistro });
    }
  }
  return [...byKey.values()].slice(0, 16);
}

function defaultRosRuntimeContext(): RosRuntimeContext {
  return {
    domainId: "0",
    rosDistro: normalizeRosDistro(process.env.PR_MONITOR_ROS_DISTRO || process.env.ROS_DISTRO || ""),
    source: "default",
  };
}

function rosRuntimeContextKey(contexts: RosRuntimeContext[]) {
  return contexts
    .map((context) => `${context.domainId}:${context.rosDistro}`)
    .sort()
    .join("|");
}

async function ensureNativeCycloneDdsMonitorContainer(rosDistro: string) {
  const distro = normalizeRosDistro(rosDistro);
  const cached = dockerMonitorContainerCache.get(distro);
  if (cached) return cached;

  const promise = startNativeCycloneDdsMonitorContainer(distro).catch((error) => {
    dockerMonitorContainerCache.delete(distro);
    throw error;
  });
  dockerMonitorContainerCache.set(distro, promise);
  return promise;
}

async function startNativeCycloneDdsMonitorContainer(rosDistro: string) {
  const name = nativeCycloneDdsMonitorContainerName(rosDistro);
  const result = await execFileAsync(
    "scripts/ros2-docker.sh",
    ["monitor-container", name],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROS_DISTRO: rosDistro,
      },
      timeout: dockerMonitorContainerTimeoutMs,
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  const id = findContainerId(result.stdout + result.stderr);
  if (!id) {
    throw new Error(`monitor container did not report an id: ${compact(result.stdout + result.stderr)}`);
  }
  return id;
}

function helperNeedsBuild(sourcePath: string, binaryPath: string) {
  if (!existsSync(binaryPath)) return true;
  try {
    const source = statSync(sourcePath);
    const binary = statSync(binaryPath);
    return source.mtimeMs > binary.mtimeMs;
  } catch {
    return true;
  }
}

function splitCompilerArgs(value: string) {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nativeCycloneDdsSampleArgs(route: string, seconds: number, domainId: string) {
  return [
    "--topic",
    route,
    "--domain-id",
    domainId,
    "--milliseconds",
    String(Math.max(100, Math.round(seconds * 1000))),
  ];
}

function nativeCycloneDdsEnv(context: RosRuntimeContext) {
  return {
    ...process.env,
    ROS_DOMAIN_ID: context.domainId,
    ROS_DISTRO: context.rosDistro,
  };
}

function nativeCycloneDdsDockerEnvArgs(context: RosRuntimeContext) {
  const args = ["--env", `ROS_DOMAIN_ID=${context.domainId}`, "--env", `ROS_DISTRO=${context.rosDistro}`];
  if (process.env.CYCLONEDDS_URI) {
    args.push("--env", `CYCLONEDDS_URI=${process.env.CYCLONEDDS_URI}`);
  }
  return args;
}

function nativeCycloneDdsMonitorContainerName(rosDistro: string) {
  const distro = sanitizeContainerNamePart(rosDistro || "humble");
  return `pacific-rim-ros2-monitor-${distro}`;
}

function sanitizeContainerNamePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function findContainerId(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (/^[a-f0-9]{12,64}$/i.test(line)) return line;
  }
  return "";
}

function parseNativeCycloneDdsSample(output: string): NativeCycloneDdsSample {
  const line = lastJsonLine(output);
  if (!line) throw new Error(`native sampler returned no JSON: ${compact(output)}`);
  const parsed = JSON.parse(line) as Partial<NativeCycloneDdsSample>;
  const count = numberValue(parsed.count);
  const bytes = numberValue(parsed.bytes);
  const elapsed = Math.max(0.001, numberValue(parsed.elapsed_sec));
  const freq = parsed.freq === undefined ? count / elapsed : numberValue(parsed.freq);
  const rate = parsed.rate === undefined ? bytes / elapsed : numberValue(parsed.rate);
  const sample: NativeCycloneDdsSample = {
    topic: String(parsed.topic ?? ""),
    domain_id: numberValue(parsed.domain_id),
    count,
    bytes,
    elapsed_sec: elapsed,
    freq,
    rate,
  };
  if (parsed.latency_ms !== undefined && Number.isFinite(Number(parsed.latency_ms))) {
    sample.latency_ms = Number(parsed.latency_ms);
  }
  return sample;
}

function lastJsonLine(output: string) {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("{") && line.endsWith("}")) return line;
  }
  return "";
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function commandAvailable(command: string) {
  try {
    await execFileAsync("command", ["-v", command], { timeout: 500 });
    return true;
  } catch {
    try {
      await execFileAsync("which", [command], { timeout: 500 });
      return true;
    } catch {
      return false;
    }
  }
}

async function findRos2Container() {
  try {
    const result = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.ID}}\t{{.Names}}"],
      { timeout: dockerDiscoveryTimeoutMs, maxBuffer: 1024 * 64 },
    );
    const containers = result.stdout
      .split(/\r?\n/)
      .map((line) => {
        const [id, name = ""] = line.trim().split(/\s+/, 2);
        return { id: id ?? "", name };
      })
      .filter((item) => item.id && item.name);
    return (
      containers.find((item) => item.name.includes("pacific-rim-ros2-monitor"))?.id ??
      containers.find((item) => item.name.includes("pacific-rim-ros2-run"))?.id ??
      containers.find((item) => item.name.includes("ros2-ros2-run"))?.id ??
      ""
    );
  } catch {
    return "";
  }
}

function shellQuote(args: string[]) {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

function parseTopicBandwidth(output: string) {
  const rateMatches = [...output.matchAll(/([0-9.]+)\s*([KMGT]?B)\/s\b/gi)];
  const sizeMatches = [...output.matchAll(/Message size mean:\s*([0-9.]+)\s*([KMGT]?B)\b/gi)];
  const rateMatch = rateMatches.at(-1);
  if (!rateMatch?.[1]) return null;
  const sizeMatch = sizeMatches.at(-1);
  return {
    ok: true as const,
    rate: parseBytes(rateMatch[1], rateMatch[2] ?? "B"),
    size: sizeMatch?.[1] ? parseBytes(sizeMatch[1], sizeMatch[2] ?? "B") : 0,
  };
}

function parseEnvelopeLatency(output: string) {
  const receivedMatch = output.match(/received_timestamp['":\s]+(\d{10,})/);
  const createdMatch = output.match(/(?:^|\n)\s*(\d{10,})\s*(?:\n|$)/);
  if (!createdMatch?.[1]) return null;
  let createdAt = Number.parseInt(createdMatch[1], 10);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (createdAt < 10_000_000_000) {
    createdAt *= 1000;
  }
  if (receivedMatch?.[1]) {
    const receivedAtNs = Number.parseInt(receivedMatch[1], 10);
    if (Number.isFinite(receivedAtNs) && receivedAtNs > 0) {
      return Math.max(0, receivedAtNs / 1_000_000 - createdAt);
    }
  }
  return null;
}

function parseBytes(value: string, unit: string) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  const normalized = unit.toUpperCase();
  if (normalized === "TB") return number * 1024 * 1024 * 1024 * 1024;
  if (normalized === "GB") return number * 1024 * 1024 * 1024;
  if (normalized === "MB") return number * 1024 * 1024;
  if (normalized === "KB") return number * 1024;
  return number;
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0.00B/s";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)}GB/s`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)}MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB/s`;
  return `${value.toFixed(2)}B/s`;
}

function processOutput(error: unknown) {
  const maybeOutput = error as { stdout?: unknown; stderr?: unknown };
  return `${typeof maybeOutput.stdout === "string" ? maybeOutput.stdout : ""}${typeof maybeOutput.stderr === "string" ? maybeOutput.stderr : ""}`;
}

interface PrometheusResponse {
  status: string;
  error?: string;
  data: {
    result: Array<{
      metric: Record<string, string>;
      value: [number, string];
    }>;
  };
}

interface PrometheusSeries {
  metric: Record<string, string>;
  value: number;
}

interface ParsedProcess {
  pid: number;
  cpu: number;
  command: string;
  args: string;
}

function parseProcessTable(stdout: string): ParsedProcess[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+([0-9.]+)\s+(\S+)\s*(.*)$/);
      if (!match) return undefined;
      return {
        pid: Number.parseInt(match[1] ?? "0", 10),
        cpu: Number.parseFloat(match[2] ?? "0"),
        command: match[3] ?? "",
        args: match[4] ?? "",
      };
    })
    .filter((process): process is ParsedProcess => Boolean(process));
}

function matchProcesses(endpoint: EndpointInfo, processes: ParsedProcess[]): ProcessInfo[] {
  const tokens = processMatchTokens(endpoint);
  if (tokens.length === 0) return [];
  return processes
    .filter((process) => {
      const haystack = `${process.command} ${process.args}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })
    .slice(0, 8)
    .map((process) => ({
      type: endpoint.type,
      host: hostname(),
      ip: "127.0.0.1",
      name: basename(process.command),
      pid: process.pid,
      profiler: process.cpu,
    }));
}

function processMatchTokens(endpoint: EndpointInfo) {
  const values = new Set<string>();
  for (const source of endpoint.sources) {
    const match = source.match(/module\/service\/([^/]+)/);
    if (match?.[1]) values.add(match[1].toLowerCase());
  }
  for (const name of endpoint.routeNames) {
    if (name.length >= 4) values.add(name.toLowerCase().replace(/_/g, "-"));
    if (name.length >= 4) values.add(name.toLowerCase().replace(/_/g, "_"));
  }
  const pathParts = endpoint.url
    .replace(/^[a-z0-9+.-]+:\/\//, "")
    .split(/[/.:-]+/)
    .filter((part) => part.length >= 5);
  for (const part of pathParts) values.add(part.toLowerCase());
  return [...values].filter((value) => !["service", "topic", "robot"].includes(value));
}

function bestSeriesForEndpoint(endpoint: EndpointInfo, series: PrometheusSeries[]) {
  let best: PrometheusSeries | undefined;
  let bestScore = 0;
  for (const item of series) {
    const score = scoreSeries(endpoint, item.metric);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function scoreSeries(endpoint: EndpointInfo, metric: Record<string, string>) {
  const specificScore = scoreSpecificSeries(endpoint, metric);
  if (specificScore !== null) return specificScore;

  const labels = Object.values(metric).join(" ").toLowerCase();
  const runtimeUrl = endpointRuntimeUrl(endpoint);
  const route = routeFromUrl(runtimeUrl).toLowerCase();
  let score = 0;
  if (labels.includes(endpoint.url.toLowerCase())) score += 10;
  if (labels.includes(runtimeUrl.toLowerCase())) score += 10;
  if (labels.includes(route)) score += 8;
  for (const name of endpoint.routeNames) {
    if (name && labels.includes(name.toLowerCase())) score += 3;
  }
  for (const source of endpoint.sources) {
    const service = source.match(/module\/service\/([^/]+)/)?.[1];
    if (service && labels.includes(service.toLowerCase())) score += 2;
  }
  return score;
}

function scoreSpecificSeries(endpoint: EndpointInfo, metric: Record<string, string>) {
  const endpointRoute = normalizeRoutePath(routeFromUrl(endpointRuntimeUrl(endpoint)));
  const labeledRoutes = [metric.url, metric.topic, metric.service, metric.ros_topic, metric.ros_service].filter(Boolean);
  if (labeledRoutes.length > 0) {
    return labeledRoutes.some((value) => normalizeRoutePath(value ?? "") === endpointRoute) ? 40 : 0;
  }

  if (metric.route) {
    return routeLabelCandidates(endpoint).has(normalizeRouteLabel(metric.route)) ? 30 : 0;
  }

  return null;
}

function routeLabelCandidates(endpoint: EndpointInfo) {
  const values = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeRouteLabel(value);
    if (!normalized) return;
    values.add(normalized);
    for (const suffix of ["ros2", "cyclonedds", "dds", "nats"]) {
      values.add(`${normalized}_${suffix}`);
    }
  };

  for (const name of endpoint.routeNames) add(name);

  const path = normalizeRoutePath(routeFromUrl(endpointRuntimeUrl(endpoint)));
  const leaf = path.split("/").filter(Boolean).at(-1) ?? "";
  add(leaf);

  return values;
}

function normalizeRoutePath(value: string) {
  return value
    .replace(/^[a-z0-9+.-]+:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizeRouteLabel(value: string) {
  return value.trim().toLowerCase().replace(/[-\s/]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseRos2List(stdout: string, typeByRoute: Map<string, string>) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)(?:\s+\[(.+)\])?$/);
      const route = match?.[1] ?? "";
      const type = match?.[2] ?? "";
      if (route && type) typeByRoute.set(route, type);
      return route;
    })
    .filter(Boolean);
}

function routeUrl(route: string) {
  return `ros2://${route.replace(/^\/+/, "")}`;
}

function routeFromUrl(url: string) {
  const parsed = url.replace(/^[a-z0-9+.-]+:\/\//, "");
  return `/${parsed.replace(/^\/+/, "")}`;
}

function endpointRuntimeUrl(endpoint: EndpointInfo) {
  return endpoint.runtimeUrl || endpoint.url;
}

function basename(command: string) {
  return command.split(/[\\/]/).at(-1) || command;
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.replace(/\s+/g, " ").trim();
  return String(error).replace(/\s+/g, " ").trim();
}
