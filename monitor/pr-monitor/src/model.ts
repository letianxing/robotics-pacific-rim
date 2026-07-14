import { discoverProjectEndpoints } from "./discovery.js";
import { createCollectors, type Collector, type CollectorSample, type CollectorStatus } from "./collectors.js";
import { TypeBits, type EndpointInfo, type ProcessInfo } from "./types.js";
export { TypeBits, type EndpointInfo, type EndpointType, type ProcessInfo, type SchemaType } from "./types.js";

export interface EndpointStats {
  freq: number | null;
  rate: number | null;
  loss: number | null;
  latency: number | null;
  stable: boolean;
  active: boolean;
  ticks: number;
  seq: number;
  lastSeenAt: number | null;
  source: string;
  status: string;
}

export interface EndpointHistory {
  freq: number[];
  rate: number[];
  loss: number[];
  latency: number[];
}

export interface DetailSample {
  time: string;
  seq: number;
  size: number | null;
  latency: number | null;
  preview: string;
}

export interface MonitorOptions {
  urls: string[];
  filter: string;
  blackMode: boolean;
  nativeMode: boolean;
  countMode: boolean;
  detailMode: boolean;
  observeAllMode: boolean;
  profilerMode: boolean;
  serMode: boolean;
  activeMode: boolean;
  pubsubMode: boolean;
  processMode: boolean;
  chartMode: boolean;
  presetMode: boolean;
  plainMode: boolean;
  dotMode: boolean;
  blobMode: boolean;
  rows: number;
  columns: number;
  chartWidth: number;
  processWidth: number;
  protoArgs: string;
  protoDir: string;
  fbsDir: string;
  locMode: boolean;
  projectRoot: string;
  prometheusUrl: string;
  ros2SampleSeconds: number;
  listRoutes: boolean;
  listProcesses: boolean;
}

export class MonitorModel {
  readonly options: MonitorOptions;
  endpoints: EndpointInfo[] = [];
  readonly stats = new Map<string, EndpointStats>();
  readonly histories = new Map<string, EndpointHistory>();
  readonly details = new Map<string, DetailSample[]>();
  readonly collectorStatuses: CollectorStatus[] = [];
  private collectors: Collector[] = [];
  private collecting = false;

  filterText: string;
  paused = false;
  selectedLine = -1;
  currentPage = 0;
  filterInputMode = false;
  detailView: EndpointInfo | null = null;
  lastJumpMessage = "";
  totalRate = 0;
  activeCount = 0;
  discoveryStatus = "discovering project routes";

  constructor(options: MonitorOptions) {
    this.options = options;
    this.filterText = options.filter;
  }

  async initialize() {
    const discovery = await discoverProjectEndpoints(this.options.projectRoot);
    this.endpoints = discovery.endpoints;
    this.discoveryStatus = `${this.endpoints.length} routes from ${discovery.sources.length} project files`;
    if (discovery.errors.length > 0) {
      this.discoveryStatus += ` (${discovery.errors.length} parse warnings)`;
    }

    for (const endpoint of this.endpoints) {
      this.ensureEndpointState(endpoint);
    }

    this.collectors = createCollectors(this.options);
    this.collectorStatuses.splice(
      0,
      this.collectorStatuses.length,
      { name: "discovery", ok: this.endpoints.length > 0, message: this.discoveryStatus, updatedAt: Date.now() },
      ...this.collectors.map((collector) => ({
        name: collector.name,
        ok: false,
        message: "waiting for first sample",
        updatedAt: 0,
      })),
    );
  }

  async collect() {
    if (this.paused || this.collecting) return;
    this.collecting = true;
    try {
      for (const endpoint of this.endpoints) {
        this.ensureEndpointState(endpoint);
        const stats = this.stats.get(endpoint.url);
        if (stats) stats.ticks += 1;
      }

      const snapshots = await Promise.allSettled(this.collectors.map((collector) => collector.collect(this.endpoints)));
      for (let index = 0; index < snapshots.length; index += 1) {
        const collector = this.collectors[index];
        if (!collector) continue;
        const snapshot = snapshots[index];
        if (!snapshot) continue;

        if (snapshot.status === "fulfilled") {
          this.updateCollectorStatus(collector.name, snapshot.value.status);
          for (const sample of snapshot.value.samples) {
            this.applySample(sample);
          }
        } else {
          this.updateCollectorStatus(collector.name, {
            name: collector.name,
            ok: false,
            message: snapshot.reason instanceof Error ? snapshot.reason.message : String(snapshot.reason),
            updatedAt: Date.now(),
          });
        }
      }

      this.refreshTotals();
      this.appendMissingHistory();
    } finally {
      this.collecting = false;
    }
  }

  visibleEndpoints() {
    const targetUrls = new Set(this.options.urls);
    const terms = splitFilter(this.filterText);

    return this.endpoints.filter((endpoint) => {
      if (targetUrls.size > 0) {
        const found = targetUrls.has(endpoint.url);
        if (this.options.blackMode ? found : !found) return false;
      }

      if (terms.length > 0) {
        const haystack = `${endpoint.url} ${endpoint.serType} ${endpoint.sources.join(" ")} ${endpoint.routeNames.join(" ")}`.toLowerCase();
        const matched = terms.some((term) => haystack.includes(term.toLowerCase()));
        if (this.options.blackMode ? matched : !matched) return false;
      }

      if (
        this.options.pubsubMode &&
        (endpoint.type & TypeBits.publisher) === 0 &&
        (endpoint.type & TypeBits.subscriber) === 0
      ) {
        return false;
      }

      if (this.options.activeMode && !this.stats.get(endpoint.url)?.active) return false;
      return true;
    }).sort((left, right) => {
      const leftActive = this.stats.get(left.url)?.active ? 1 : 0;
      const rightActive = this.stats.get(right.url)?.active ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return left.url.localeCompare(right.url);
    });
  }

  private ensureEndpointState(endpoint: EndpointInfo) {
    if (!this.stats.has(endpoint.url)) this.stats.set(endpoint.url, zeroStats());
    if (!this.histories.has(endpoint.url)) this.histories.set(endpoint.url, emptyHistory());
    if (!this.details.has(endpoint.url)) this.details.set(endpoint.url, []);
  }

  private updateCollectorStatus(name: string, status: CollectorStatus) {
    const next = { ...status, name, updatedAt: status.updatedAt || Date.now() };
    const existing = this.collectorStatuses.findIndex((item) => item.name === name);
    if (existing >= 0) {
      this.collectorStatuses[existing] = next;
    } else {
      this.collectorStatuses.push(next);
    }
  }

  private applySample(sample: CollectorSample) {
    const endpoint = this.endpoints.find((item) => item.url === sample.url);
    if (!endpoint) return;
    const stats = this.stats.get(endpoint.url) ?? zeroStats();
    const previousSeq = stats.seq;
    const observedMetric = hasObservedValue(sample);

    stats.freq = sample.freq ?? stats.freq;
    stats.rate = sample.rate ?? stats.rate;
    stats.loss = sample.loss ?? stats.loss;
    stats.latency = sample.latency ?? stats.latency;
    stats.source = sample.source;
    stats.status = sample.status ?? "sampled";
    stats.lastSeenAt = sample.timestamp;
    if (sample.active !== undefined || observedMetric) {
      stats.active = sample.active ?? observedMetric;
    }
    stats.stable = stats.ticks >= 2 && stats.active;
    stats.seq += Math.max(0, Math.round(sample.countDelta ?? sample.freq ?? 0));

    endpoint.processList = mergeProcesses(endpoint.processList, sample.processList ?? []);
    if (observedMetric || sample.active !== undefined) {
      appendHistorySample(this.histories.get(endpoint.url) ?? emptyHistory(), stats, this.options.chartWidth);
    }
    if (stats.seq !== previousSeq || sample.preview) {
      appendDetail(this.details.get(endpoint.url) ?? [], sample, stats);
    }
  }

  private refreshTotals() {
    this.totalRate = 0;
    this.activeCount = 0;
    for (const stats of this.stats.values()) {
      if (stats.active) this.activeCount += 1;
      if (stats.rate !== null) this.totalRate += stats.rate;
    }
  }

  private appendMissingHistory() {
    const now = Date.now();
    for (const endpoint of this.endpoints) {
      const stats = this.stats.get(endpoint.url);
      const history = this.histories.get(endpoint.url);
      if (!stats || !history) continue;
      const stale = !stats.lastSeenAt || now - stats.lastSeenAt > 10_000;
      if (stale) {
        stats.active = false;
        stats.stable = false;
        appendHistory(history, 0, 0, 0, 0, this.options.chartWidth);
      }
    }
  }
}

export function splitFilter(filter: string) {
  return filter
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function zeroStats(): EndpointStats {
  return {
    freq: null,
    rate: null,
    loss: null,
    latency: null,
    stable: false,
    active: false,
    ticks: 0,
    seq: 0,
    lastSeenAt: null,
    source: "",
    status: "not observed",
  };
}

export function emptyHistory(): EndpointHistory {
  return { freq: [], rate: [], loss: [], latency: [] };
}

function appendHistorySample(history: EndpointHistory, stats: EndpointStats, chartWidth: number) {
  appendHistory(history, stats.freq ?? 0, stats.rate ?? 0, stats.loss ?? 0, stats.latency ?? 0, chartWidth);
}

function appendHistory(history: EndpointHistory, freq: number, rate: number, loss: number, latency: number, chartWidth: number) {
  const max = Math.max(26, chartWidth);
  history.freq.push(freq);
  history.rate.push(rate);
  history.loss.push(loss);
  history.latency.push(latency);

  for (const values of [history.freq, history.rate, history.loss, history.latency]) {
    while (values.length > max) values.shift();
  }
}

function appendDetail(detail: DetailSample[], sample: CollectorSample, stats: EndpointStats) {
  detail.push({
    time: new Date(sample.timestamp).toLocaleTimeString("en-US", { hour12: false }),
    seq: stats.seq,
    size: sample.size ?? null,
    latency: sample.latency ?? null,
    preview: sample.preview ?? `${sample.source}: ${sample.status ?? "observed"}`,
  });

  while (detail.length > 80) detail.shift();
}

function hasObservedValue(sample: CollectorSample) {
  return (
    (sample.freq !== undefined && sample.freq > 0) ||
    (sample.rate !== undefined && sample.rate > 0) ||
    (sample.countDelta !== undefined && sample.countDelta > 0) ||
    sample.active === true
  );
}

function mergeProcesses(current: ProcessInfo[], incoming: ProcessInfo[]) {
  const merged = new Map<string, ProcessInfo>();
  for (const process of [...current, ...incoming]) {
    const key = `${process.name}:${process.pid}:${process.type}`;
    merged.set(key, process);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid);
}
