#!/usr/bin/env bun
import {
  createCliRenderer,
  RGBA,
  Renderable,
  TextAttributes,
  type KeyEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  buildInspectCommand,
  clamp,
  formatBytes,
  formatFixed,
  formatNumber,
  formatOptionalBytes,
  formatOptionalFixed,
  formatOptionalHz,
  formatProfiler,
  padLeft,
  padRight,
  processTypeLabel,
  typeLabel,
} from "./format.js";
import { emptyHistory, MonitorModel, splitFilter, TypeBits, zeroStats, type EndpointHistory, type EndpointInfo, type MonitorOptions, type ProcessInfo } from "./model.js";

const COLLECT_INTERVAL_MS = 1000;
const FRAME_INTERVAL_MS = 50;
const HISTORY_SECONDS = 26;
const DETAIL_LINES = 12;

const color = {
  bg: RGBA.fromHex("#05070d"),
  panelBg: RGBA.fromHex("#090b12"),
  headerBg: RGBA.fromHex("#255ba8"),
  headerFg: RGBA.fromHex("#f8fbff"),
  fg: RGBA.fromHex("#d7dbe5"),
  dim: RGBA.fromHex("#7e8798"),
  green: RGBA.fromHex("#28ff23"),
  yellow: RGBA.fromHex("#ffd21a"),
  red: RGBA.fromHex("#ff3f4a"),
  cyan: RGBA.fromHex("#67e8f9"),
  blue: RGBA.fromHex("#8ab4ff"),
  magenta: RGBA.fromHex("#d58bff"),
  white: RGBA.fromHex("#f2f5f8"),
  black: RGBA.fromHex("#05070d"),
  selectionBg: RGBA.fromHex("#f3f4f6"),
  selectionFg: RGBA.fromHex("#05070d"),
  dividerBg: RGBA.fromHex("#1f5eab"),
  boxBg: RGBA.fromHex("#153f78"),
  boxBorder: RGBA.fromHex("#dce9ff"),
};

const transparent = RGBA.fromValues(0, 0, 0, 0);

class MonitorRenderable extends Renderable {
  private model: MonitorModel;

  constructor(ctx: RenderContext, options: RenderableOptions & { model: MonitorModel }) {
    super(ctx, options);
    this.model = options.model;
    this.focusable = true;
    this.live = true;
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    const width = safeDimension(this.width, process.stdout.columns || 120);
    const height = safeDimension(this.height, process.stdout.rows || 34);
    buffer.fillRect(this.x, this.y, width, height, color.bg);

    if (this.model.detailView) {
      this.renderDetail(buffer, width, height, this.model.detailView);
      return;
    }

    const viewWidth = this.model.options.columns > 0 ? Math.min(width, this.model.options.columns) : width;
    const viewHeight = this.model.options.rows > 0 ? Math.min(height, this.model.options.rows) : height;
    const contentRows = Math.max(3, viewHeight - 3);
    const endpoints = this.model.visibleEndpoints();
    const maxUrlSize = Math.max(16, ...endpoints.map((endpoint) => endpoint.url.length));
    const maxSerSize = Math.max(16, ...endpoints.map((endpoint) => endpoint.serType.length));
    const mainWidth = this.computeMainWidth(maxUrlSize, maxSerSize);
    const chartPanelWidth =
      this.model.options.chartMode && this.model.options.detailMode && viewWidth >= mainWidth + this.model.options.chartWidth + 10
        ? this.model.options.chartWidth + 8
        : 0;
    const processPanelWidth =
      this.model.options.processMode && viewWidth >= mainWidth + this.model.options.processWidth + 4
        ? this.model.options.processWidth
        : 0;
    const availableMainWidth = Math.max(20, viewWidth - chartPanelWidth - processPanelWidth - (chartPanelWidth ? 1 : 0) - (processPanelWidth ? 1 : 0));
    const totalPages = Math.max(1, Math.ceil(endpoints.length / contentRows));
    this.model.currentPage = clamp(this.model.currentPage, 0, totalPages - 1);
    if (this.model.selectedLine >= endpoints.length) {
      this.model.selectedLine = endpoints.length - 1;
    }

    const pageStart = this.model.currentPage * contentRows;
    const pageEnd = Math.min(pageStart + contentRows, endpoints.length);
    const selectedInfo = this.model.selectedLine >= 0 ? endpoints[this.model.selectedLine] : undefined;
    const processLines = processPanelWidth > 0 && selectedInfo ? renderProcessPanel(selectedInfo.processList, contentRows, processPanelWidth) : [];
    const chartLines =
      chartPanelWidth > 0 && selectedInfo
        ? renderChartPanel(this.model.histories.get(selectedInfo.url) ?? emptyHistory(), contentRows, this.model.options.chartWidth, this.model.options.dotMode)
        : [];

    this.drawText(buffer, 2, 0, `Information Collected by pr-monitor${this.model.paused ? " (Paused)" : ""}:`, {
      fg: this.model.paused ? color.yellow : color.fg,
      attrs: this.model.paused ? TextAttributes.BOLD : TextAttributes.NONE,
      width: viewWidth - 2,
    });

    let headerX = 0;
    this.drawHeader(buffer, headerX, 1, maxUrlSize, maxSerSize, availableMainWidth);
    headerX += availableMainWidth;
    if (processPanelWidth > 0) {
      this.drawDivider(buffer, headerX, 1);
      headerX += 1;
      this.drawText(buffer, headerX, 1, "[PROCESS]", { fg: color.headerFg, bg: color.headerBg, attrs: TextAttributes.BOLD, width: processPanelWidth });
      headerX += processPanelWidth;
    }
    if (chartPanelWidth > 0) {
      this.drawDivider(buffer, headerX, 1);
      headerX += 1;
      this.drawText(buffer, headerX, 1, "[CHART]", { fg: color.headerFg, bg: color.headerBg, attrs: TextAttributes.BOLD, width: chartPanelWidth });
    }

    for (let row = 0; row < contentRows; row += 1) {
      const lineIndex = pageStart + row;
      const endpoint = lineIndex < pageEnd ? endpoints[lineIndex] : undefined;
      const y = row + 2;
      const selected = lineIndex === this.model.selectedLine;

      if (endpoint) {
        this.drawEndpoint(buffer, endpoint, 0, y, maxUrlSize, maxSerSize, availableMainWidth, selected);
      } else {
        buffer.fillRect(this.x, this.y + y, availableMainWidth, 1, color.bg);
      }

      let panelX = availableMainWidth;
      if (processPanelWidth > 0) {
        this.drawDivider(buffer, panelX, y);
        panelX += 1;
        this.drawText(buffer, panelX, y, processLines[row] ?? "", { fg: color.fg, bg: color.panelBg, width: processPanelWidth });
        panelX += processPanelWidth;
      }
      if (chartPanelWidth > 0) {
        this.drawDivider(buffer, panelX, y);
        panelX += 1;
        this.drawText(buffer, panelX, y, chartLines[row] ?? "", { fg: color.fg, bg: color.panelBg, width: chartPanelWidth });
      }
    }

    this.drawStatusLine(buffer, viewWidth, viewHeight - 1, totalPages, endpoints.length);

    if (this.model.filterInputMode) {
      this.drawFilterBox(buffer, viewWidth, viewHeight, contentRows);
    }
  }

  private renderDetail(buffer: OptimizedBuffer, width: number, height: number, endpoint: EndpointInfo) {
    const stats = this.model.stats.get(endpoint.url) ?? zeroStats();
    const history = this.model.histories.get(endpoint.url) ?? emptyHistory();
    const details = this.model.details.get(endpoint.url) ?? [];

      this.drawText(buffer, 2, 0, `Route detail: ${endpoint.url}`, { fg: color.green, attrs: TextAttributes.BOLD, width: width - 4 });
    this.drawText(buffer, 2, 1, `Enter/Esc returns. source=${stats.source || "none"} status=${stats.status}`, {
      fg: color.dim,
      width: width - 4,
    });
    this.drawText(buffer, 0, 3, "=".repeat(Math.min(width, 120)), { fg: color.blue, width });
    this.drawText(
      buffer,
      2,
      4,
      [
        `type=${typeLabel(endpoint.type, false)}`,
        `schema=${endpoint.serType}`,
        `freq=${formatOptionalHz(stats.freq)}`,
        `rate=${stats.rate === null ? "---" : `${formatBytes(stats.rate)}/s`}`,
        `loss=${formatOptionalFixed(stats.loss, 2, "%")}`,
        `latency=${formatOptionalFixed(stats.latency, 2, "ms")}`,
      ].join("  "),
      { fg: stats.active ? color.green : color.red, width: width - 4 },
    );
    this.drawText(buffer, 2, 5, buildInspectCommand(endpoint, this.model.options), { fg: color.blue, width: width - 4 });
    this.drawText(buffer, 2, 6, `routes=${endpoint.routeNames.join(", ") || "-"}  files=${endpoint.sources.join(", ") || "-"}`, {
      fg: color.dim,
      width: width - 4,
    });
    this.drawText(buffer, 2, 7, `collectors=${this.model.collectorStatuses.map((item) => `${item.name}:${item.ok ? "ok" : item.message}`).join(" | ")}`, {
      fg: color.dim,
      width: width - 4,
    });

    const chartWidth = Math.min(this.model.options.chartWidth, Math.max(10, width - 18));
    let y = 9;
    for (const chart of [
      renderMiniChart("Freq", history.freq, "Hz", chartWidth),
      renderMiniChart("Rate", history.rate, "B/s", chartWidth, 1024),
      renderMiniChart("Loss", history.loss, "%", chartWidth),
      renderMiniChart("Latency", history.latency, "ms", chartWidth),
    ]) {
      for (const line of chart) {
        if (y >= height - 1) break;
        this.drawText(buffer, 2, y, line, { fg: color.fg, width: width - 4 });
        y += 1;
      }
      y += 1;
    }

    if (y < height - 3) {
      this.drawText(buffer, 2, y, "Recent payloads", { fg: color.headerFg, bg: color.headerBg, attrs: TextAttributes.BOLD, width: Math.min(width - 4, 110) });
      y += 1;
      this.drawText(buffer, 2, y, "TIME         SEQ        SIZE       LATENCY    PREVIEW", { fg: color.cyan, width: width - 4 });
      y += 1;
      for (const sample of details.slice(-DETAIL_LINES).reverse()) {
        if (y >= height - 1) break;
        this.drawText(
          buffer,
          2,
          y,
          `${padRight(sample.time, 12)} ${padLeft(String(sample.seq), 9)} ${padLeft(formatOptionalBytes(sample.size), 9)} ${padLeft(formatOptionalFixed(sample.latency, 2, "ms"), 10)}  ${sample.preview}`,
          { fg: color.fg, width: width - 4 },
        );
        y += 1;
      }
    }
  }

  private computeMainWidth(maxUrlSize: number, maxSerSize: number) {
    let width = 8 + maxUrlSize + 3;
    if (this.model.options.serMode) width += maxSerSize + 3;
    if (this.model.options.detailMode) width += 12 + 12 + 9 + 12;
    if (this.model.options.profilerMode) width += 14;
    return width;
  }

  private drawHeader(buffer: OptimizedBuffer, x: number, y: number, maxUrlSize: number, maxSerSize: number, width: number) {
    let header = `${padRight("[TYPE]", 8)}${padRight("[ROUTE]", maxUrlSize + 3)}`;
    if (this.model.options.serMode) header += padRight("[SCHEMA]", maxSerSize + 3);
    if (this.model.options.detailMode) {
      header += `${padRight("[FREQ]", 12)}${padRight("[RATE]", 12)}${padRight("[LOSS]", 9)}${padRight("[LATENCY]", 12)}`;
    }
    if (this.model.options.profilerMode) header += padRight("[PROFILER]", 14);
    this.drawText(buffer, x, y, header, { fg: color.headerFg, bg: color.headerBg, attrs: TextAttributes.BOLD, width });
  }

  private drawEndpoint(buffer: OptimizedBuffer, endpoint: EndpointInfo, x: number, y: number, maxUrlSize: number, maxSerSize: number, width: number, selected: boolean) {
    const stats = this.model.stats.get(endpoint.url) ?? zeroStats();
    const fg = this.model.options.detailMode
      ? stats.active
        ? stats.stable
          ? color.green
          : color.yellow
        : color.red
      : color.fg;
    const bg = selected ? color.selectionBg : color.bg;
    const selectedFg = selected ? color.selectionFg : fg;
    buffer.fillRect(this.x + x, this.y + y, width, 1, bg);

    let cursor = x;
    cursor = this.drawText(buffer, cursor, y, padRight(typeLabel(endpoint.type, this.model.options.countMode, endpoint.processList), 8), {
      fg: selectedFg,
      bg,
      attrs: selected ? TextAttributes.BOLD : TextAttributes.NONE,
    });
    cursor = this.drawHighlightedRoute(buffer, cursor, y, endpoint.url, splitFilter(this.model.filterText), selectedFg, bg, selected);
    cursor = this.drawText(buffer, cursor, y, " ".repeat(Math.max(3, maxUrlSize - endpoint.url.length + 3)), { fg: selectedFg, bg });

    if (this.model.options.serMode) {
      cursor = this.drawText(buffer, cursor, y, endpoint.serType, { fg: selected ? selectedFg : color.cyan, bg });
      cursor = this.drawText(buffer, cursor, y, " ".repeat(Math.max(3, maxSerSize - endpoint.serType.length + 3)), { fg: selectedFg, bg });
    }

    if (this.model.options.detailMode) {
      if (stats.active) {
        cursor = this.drawText(buffer, cursor, y, padRight(formatOptionalHz(stats.freq), 12), { fg: selectedFg, bg });
        cursor = this.drawText(buffer, cursor, y, padRight(stats.rate === null ? "---" : `${formatBytes(stats.rate)}/s`, 12), { fg: selectedFg, bg });
        cursor = this.drawText(buffer, cursor, y, padRight(formatOptionalFixed(stats.loss, 2, "%"), 9), { fg: selected ? selectedFg : stats.loss !== null && stats.loss > 0 ? color.yellow : fg, bg });
        cursor = this.drawText(buffer, cursor, y, padRight(formatOptionalFixed(stats.latency, 2, "ms"), 12), { fg: selectedFg, bg });
      } else {
        cursor = this.drawText(buffer, cursor, y, `${padRight("---", 12)}${padRight("---", 12)}${padRight("---", 9)}${padRight("---", 12)}`, { fg: selectedFg, bg });
      }
    }

    if (this.model.options.profilerMode) {
      this.drawText(buffer, cursor, y, padRight(formatProfiler(endpoint.processList), 14), { fg: selected ? selectedFg : color.magenta, bg });
    }
  }

  private drawHighlightedRoute(buffer: OptimizedBuffer, x: number, y: number, route: string, terms: string[], fg: RGBA, bg: RGBA, selected: boolean) {
    if (terms.length === 0 || selected) {
      return this.drawText(buffer, x, y, route, { fg, bg });
    }

    const lower = route.toLowerCase();
    const marks = new Array(route.length).fill(false);
    for (const term of terms) {
      const needle = term.toLowerCase();
      let index = lower.indexOf(needle);
      while (index >= 0) {
        for (let i = index; i < index + needle.length; i += 1) marks[i] = true;
        index = lower.indexOf(needle, index + 1);
      }
    }

    let cursor = x;
    let current = "";
    let marked = marks[0] ?? false;
    for (let i = 0; i < route.length; i += 1) {
      if (marks[i] !== marked) {
        cursor = this.drawText(buffer, cursor, y, current, { fg, bg, attrs: marked ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE });
        current = "";
        marked = marks[i] ?? false;
      }
      current += route[i];
    }
    return this.drawText(buffer, cursor, y, current, { fg, bg, attrs: marked ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE });
  }

  private drawStatusLine(buffer: OptimizedBuffer, width: number, y: number, totalPages: number, totalRows: number) {
    const pageText = `<${totalPages === 0 ? 0 : this.model.currentPage + 1}/${totalPages}>`;
    const flags = [
      statusFlag("T", this.model.options.countMode),
      statusFlag("L", this.model.options.detailMode),
      statusFlag("O", this.model.options.observeAllMode),
      statusFlag("E", this.model.options.profilerMode),
      statusFlag("S", this.model.options.serMode),
      statusFlag("A", this.model.options.activeMode),
      statusFlag("Y", this.model.options.pubsubMode),
      statusFlag("P", this.model.options.processMode),
      statusFlag("C", this.model.options.chartMode),
      statusFlag("I", splitFilter(this.model.filterText).length > 0),
    ].join(" ");
    this.drawText(buffer, 0, y, pageText, { fg: color.headerFg, bg: color.headerBg, attrs: TextAttributes.BOLD, width: pageText.length });
    const status = this.model.collectorStatuses
      .map((item) => `${shortSourceName(item.name)}:${item.ok ? "ok" : "err"}`)
      .join(" ");
    this.drawText(buffer, pageText.length + 1, y, `[ ${flags} ] | Total:${totalRows} Active:${this.model.activeCount} Rate:${formatBytes(this.model.totalRate)}/s src ${status}`, {
      fg: color.fg,
      bg: color.bg,
      width: Math.max(0, width - pageText.length - 1),
    });
  }

  private drawFilterBox(buffer: OptimizedBuffer, width: number, height: number, contentRows: number) {
    const boxWidth = clamp(Math.min(60, width - 4), 24, Math.max(24, width - 2));
    const boxHeight = 5;
    const x = Math.max(1, Math.floor((width - boxWidth) / 2));
    const y = Math.max(3, Math.floor((contentRows - boxHeight) / 2) + 2);
    const inner = boxWidth - 2;
    const title = "[ Filter Routes ]";
    const inputText = tail(this.model.filterText, Math.max(0, inner - 5));
    const rows = [
      `┌──${title}${"─".repeat(Math.max(0, inner - title.length - 2))}┐`,
      `│ > ${inputText}${" ".repeat(Math.max(0, inner - 4 - inputText.length))}│`,
      `├${"─".repeat(inner)}┤`,
      `│ ${padRight("Space: multi-term   Enter/Esc: close".slice(0, inner - 1), inner - 1)}│`,
      `└${"─".repeat(inner)}┘`,
    ];

    for (let i = 0; i < rows.length; i += 1) {
      if (y + i >= height) break;
      this.drawText(buffer, x, y + i, rows[i] ?? "", {
        fg: i === 1 ? color.yellow : i === 3 ? color.dim : color.boxBorder,
        bg: color.boxBg,
        attrs: i === 0 ? TextAttributes.BOLD : TextAttributes.NONE,
        width: boxWidth,
      });
    }
  }

  private drawDivider(buffer: OptimizedBuffer, x: number, y: number) {
    buffer.fillRect(this.x + x, this.y + y, 1, 1, color.dividerBg);
  }

  private drawText(
    buffer: OptimizedBuffer,
    x: number,
    y: number,
    text: string,
    options: { fg?: RGBA; bg?: RGBA; attrs?: number; width?: number } = {},
  ) {
    const width = options.width ?? text.length;
    if (width <= 0) return x;
    const bg = options.bg ?? transparent;
    if (options.bg) buffer.fillRect(this.x + x, this.y + y, width, 1, bg);
    buffer.drawText(text.slice(0, width), this.x + x, this.y + y, options.fg ?? color.fg, bg, options.attrs ?? TextAttributes.NONE);
    return x + Math.min(text.length, width);
  }
}

function statusFlag(label: string, enabled: boolean) {
  return enabled ? `_${label}_` : label;
}

function safeDimension(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function shortSourceName(name: string) {
  if (name === "discovery") return "disc";
  if (name === "process") return "ps";
  if (name === "prometheus") return "prom";
  if (name === "cyclonedds") return "dds";
  return name;
}

function renderProcessPanel(processList: ProcessInfo[], height: number, width: number) {
  const lines: string[] = [];
  for (const process of processList) {
    lines.push(center(`[ ${processTypeLabel(process.type)} ]`, width));
    lines.push(padRight(` ${process.host}@${process.ip}`, width));
    lines.push(padRight(` ${process.name}#${process.pid}`, width));
    lines.push("─".repeat(width));
    if (lines.length >= height) break;
  }
  return lines.slice(0, height);
}

function renderChartPanel(history: EndpointHistory, height: number, width: number, dotMode: boolean) {
  const charts = [
    renderMiniChart("Freq", history.freq, "Hz", width, 100000, dotMode),
    renderMiniChart("Rate", history.rate, "B/s", width, 1024, dotMode),
    renderMiniChart("Loss", history.loss, "%", width, 100000, dotMode),
    renderMiniChart("Latency", history.latency, "ms", width, 100000, dotMode),
  ];
  const lines: string[] = [];
  const chartHeight = Math.max(1, Math.floor((height - 4) / 4) - 2);
  for (const chart of charts) {
    lines.push(...chart.slice(0, chartHeight + 3));
    lines.push("");
  }
  return lines.slice(0, height);
}

function renderMiniChart(title: string, data: number[], unit: string, width: number, unitValue = 100000, dotMode = false) {
  const values = data.slice(-width);
  const max = values.length > 0 ? Math.max(...values) : 1;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const range = Math.max(1e-9, max - min || max * 0.1 || 1);
  const current = values.length > 0 ? (values.at(-1) ?? 0) : 0;
  const lines = [padRight(`${title}: ${formatNumber(current, unitValue)}${unit}   (0 - ${Math.max(width, HISTORY_SECONDS)}s)`, width + 8)];
  const chars = dotMode ? [" ", "⡀", "⡄", "⡆", "⡇"] : [" ", "▁", "▃", "▄", "▆", "█"];
  const rows = 4;

  for (let row = rows - 1; row >= 0; row -= 1) {
    const threshold = min + (range * row) / rows;
    const label = row === rows - 1 ? formatNumber(max, unitValue) : row === 0 ? formatNumber(min, unitValue) : "";
    const padded = [...Array(Math.max(0, width - values.length)).fill(0), ...values];
    let line = `${padLeft(label, 7)}│`;
    for (const value of padded) {
      if (value <= 0 && row > 0) {
        line += " ";
        continue;
      }
      if (value >= threshold) {
        const level = Math.min(chars.length - 1, Math.max(1, Math.ceil(((value - threshold) / range) * (chars.length - 1))));
        line += chars[level] ?? "█";
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  lines.push(`${" ".repeat(8)}${"─".repeat(width)}`);
  return lines;
}

function center(value: string, width: number) {
  if (value.length >= width) return value.slice(0, width);
  const left = Math.floor((width - value.length) / 2);
  return " ".repeat(left) + value + " ".repeat(width - value.length - left);
}

function tail(value: string, width: number) {
  const chars = Array.from(value);
  return chars.slice(Math.max(0, chars.length - width)).join("");
}

function moveSelection(model: MonitorModel, terminalHeight: number, delta: -1 | 1) {
  const rows = Math.max(3, (model.options.rows > 0 ? model.options.rows : terminalHeight) - 3);
  const total = model.visibleEndpoints().length;
  if (total === 0) {
    model.selectedLine = -1;
    return;
  }

  if (model.selectedLine < 0) {
    model.selectedLine = delta > 0 ? model.currentPage * rows : Math.min(total - 1, (model.currentPage + 1) * rows - 1);
  } else {
    model.selectedLine = clamp(model.selectedLine + delta, 0, total - 1);
  }

  model.currentPage = Math.floor(model.selectedLine / rows);
}

function normalizeKeyName(key: KeyEvent) {
  const name = key.name.toLowerCase();
  if (name === "return") return "enter";
  if (name === "esc") return "escape";
  if (name === " ") return "space";
  if (name === "arrowup") return "up";
  if (name === "arrowdown") return "down";
  if (name === "arrowleft") return "left";
  if (name === "arrowright") return "right";
  return name;
}

async function handleKey(key: KeyEvent, model: MonitorModel, terminalHeight: number, shutdown: () => void) {
  const name = normalizeKeyName(key);

  if (model.filterInputMode) {
    if (name === "enter" || name === "escape") model.filterInputMode = false;
    else if (name === "backspace") {
      model.filterText = Array.from(model.filterText).slice(0, -1).join("");
      model.currentPage = 0;
      model.selectedLine = -1;
    } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      model.filterText += key.sequence;
      model.currentPage = 0;
      model.selectedLine = -1;
    }
    return;
  }

  if (model.detailView) {
    if (name === "enter" || name === "escape") {
      model.detailView = null;
      return;
    }
    if (name === "q") {
      shutdown();
      return;
    }
  }

  if (name === "q" || name === "escape") shutdown();
  else if (name === "space") model.paused = !model.paused;
  else if (name === "left") {
    model.currentPage = Math.max(0, model.currentPage - 1);
    model.selectedLine = -1;
  } else if (name === "right") {
    const rows = Math.max(3, terminalHeight - 3);
    const totalPages = Math.max(1, Math.ceil(model.visibleEndpoints().length / rows));
    model.currentPage = Math.min(totalPages - 1, model.currentPage + 1);
    model.selectedLine = -1;
  } else if (name === "up") moveSelection(model, terminalHeight, -1);
  else if (name === "down") moveSelection(model, terminalHeight, 1);
  else if (name === "enter") {
    const endpoint = model.visibleEndpoints()[model.selectedLine];
    if (endpoint) {
      model.detailView = endpoint;
      model.lastJumpMessage = buildInspectCommand(endpoint, model.options);
    }
  } else if (name === "z") model.selectedLine = -1;
  else if (name === "t") model.options.countMode = !model.options.countMode;
  else if (name === "l") {
    model.options.detailMode = !model.options.detailMode;
    if (!model.options.detailMode) {
      model.options.observeAllMode = false;
      model.options.activeMode = false;
    }
  } else if (name === "o" && model.options.detailMode) model.options.observeAllMode = !model.options.observeAllMode;
  else if (name === "e") model.options.profilerMode = !model.options.profilerMode;
  else if (name === "s") model.options.serMode = !model.options.serMode;
  else if (name === "a" && model.options.detailMode) model.options.activeMode = !model.options.activeMode;
  else if (name === "y") model.options.pubsubMode = !model.options.pubsubMode;
  else if (name === "p") model.options.processMode = !model.options.processMode;
  else if (name === "c") model.options.chartMode = !model.options.chartMode;
  else if (name === "i") model.filterInputMode = true;

  await model.collect();
}

function parseArgs(args: string[]): MonitorOptions {
  const options: MonitorOptions = {
    urls: [],
    filter: "",
    blackMode: false,
    nativeMode: false,
    countMode: false,
    detailMode: false,
    observeAllMode: false,
    profilerMode: false,
    serMode: false,
    activeMode: false,
    pubsubMode: false,
    processMode: false,
    chartMode: false,
    presetMode: false,
    plainMode: false,
    dotMode: false,
    blobMode: false,
    rows: 0,
    columns: 0,
    chartWidth: 30,
    processWidth: 40,
    protoArgs: "",
    protoDir: process.env.PACIFIC_RIM_PROTO_DIR ?? process.env.VLINK_PROTO_DIR ?? "",
    fbsDir: process.env.PACIFIC_RIM_FBS_DIR ?? process.env.VLINK_FBS_DIR ?? "",
    locMode: false,
    projectRoot: process.cwd(),
    prometheusUrl:
      process.env.PR_MONITOR_PROMETHEUS_URL ??
      process.env.PROMETHEUS_URL ??
      platformValue(process.cwd(), "prometheus_url", "http://localhost:18180"),
    ros2SampleSeconds: Number.parseInt(process.env.PR_MONITOR_ROS2_SAMPLE_SECONDS ?? "1", 10),
    listRoutes: false,
    listProcesses: false,
  };

  const consume = (index: number) => {
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${args[index]}`);
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-u" || arg === "--urls") {
      while (args[i + 1] && !args[i + 1]?.startsWith("-")) {
        options.urls.push(args[i + 1] ?? "");
        i += 1;
      }
    } else if (arg === "-i" || arg === "--filter") {
      options.filter = consume(i);
      i += 1;
    } else if (arg === "-g" || arg === "--proto_args") {
      options.protoArgs = consume(i);
      i += 1;
    } else if (arg === "-d" || arg === "--proto_dir") {
      options.protoDir = consume(i);
      i += 1;
    } else if (arg === "-f" || arg === "--fbs_dir") {
      options.fbsDir = consume(i);
      i += 1;
    } else if (arg === "--rows") {
      options.rows = parseNumber(consume(i), "--rows");
      i += 1;
    } else if (arg === "--columns") {
      options.columns = parseNumber(consume(i), "--columns");
      i += 1;
    } else if (arg === "--chart_width") {
      options.chartWidth = parseNumber(consume(i), "--chart_width");
      i += 1;
    } else if (arg === "--process_width") {
      options.processWidth = parseNumber(consume(i), "--process_width");
      i += 1;
    } else if (arg === "--project-root") {
      options.projectRoot = consume(i);
      i += 1;
    } else if (arg === "--prometheus-url") {
      options.prometheusUrl = consume(i);
      i += 1;
    } else if (arg === "--ros2-sample-seconds") {
      options.ros2SampleSeconds = parseNumber(consume(i), "--ros2-sample-seconds");
      i += 1;
    } else if (arg === "--list-routes") {
      options.listRoutes = true;
    } else if (arg === "--list-processes" || arg === "--topology") {
      options.listProcesses = true;
    } else if (arg === "--plain") options.plainMode = true;
    else if (arg === "--dot") options.dotMode = true;
    else if (arg === "--loc" || arg === "-loc") {
      options.locMode = true;
      options.nativeMode = true;
    } else if (arg === "--help" || arg === "-h") printHelpAndExit();
    else if (arg === "--version" || arg === "-v") {
      console.log("pr-monitor 0.1.0");
      process.exit(0);
    } else if (arg.startsWith("-") && !arg.startsWith("--")) {
      for (const flag of arg.slice(1)) applyShortFlag(options, flag);
    }
  }

  return options;
}

function platformValue(rootDir: string, key: string, fallback: string) {
  const platformPath = join(rootDir, "deploy", "local", "platform.yaml");
  if (!existsSync(platformPath)) return fallback;
  const text = readFileSync(platformPath, "utf8");
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*["']?([^"'#\\n]+)`, "m");
  return pattern.exec(text)?.[1]?.trim() || fallback;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyShortFlag(options: MonitorOptions, flag: string) {
  switch (flag) {
    case "b": options.blobMode = true; break;
    case "k": options.blackMode = true; break;
    case "n": options.nativeMode = true; break;
    case "t": options.countMode = true; break;
    case "l": options.detailMode = true; break;
    case "o": options.observeAllMode = true; break;
    case "e": options.profilerMode = true; break;
    case "s": options.serMode = true; break;
    case "a": options.activeMode = true; break;
    case "y": options.pubsubMode = true; break;
    case "p": options.processMode = true; break;
    case "c": options.chartMode = true; break;
    case "x": options.presetMode = true; break;
    default: throw new Error(`Unknown flag -${flag}`);
  }
}

function parseNumber(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function printProcessList(endpoints: EndpointInfo[]) {
  const groups = new Map<string, { name: string; pid: number | null; host: string; ip: string; endpoints: EndpointInfo[] }>();

  for (const endpoint of endpoints) {
    const processes = endpoint.processList.length > 0 ? endpoint.processList : [fallbackProcess(endpoint)];
    for (const process of processes) {
      const key = `${process.name}:${process.pid || "project"}:${process.host}:${process.ip}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          name: process.name,
          pid: process.pid > 0 ? process.pid : null,
          host: process.host || hostname(),
          ip: process.ip || "127.0.0.1",
          endpoints: [],
        };
        groups.set(key, group);
      }
      group.endpoints.push(endpoint);
    }
  }

  for (const group of [...groups.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const pidText = group.pid === null ? "pid: ---" : `pid: ${group.pid}`;
    console.log(`${group.name} (${pidText}, host: ${group.host}, ip: ${group.ip})`);

    for (const section of [
      ["Publisher", TypeBits.publisher],
      ["Subscriber", TypeBits.subscriber],
      ["Server", TypeBits.server],
      ["Client", TypeBits.client],
      ["Setter", TypeBits.setter],
      ["Getter", TypeBits.getter],
    ] as const) {
      const [label, bit] = section;
      const items = uniqueEndpoints(group.endpoints.filter((endpoint) => (endpoint.type & bit) !== 0));
      if (items.length === 0) continue;
      console.log(`  ${label}:`);
      for (const endpoint of items) {
        console.log(`    ${endpoint.url}    ${endpoint.serType}`);
      }
    }
    console.log("");
  }
}

function printPlainSample(model: MonitorModel) {
  for (const status of model.collectorStatuses) {
    console.log(`collector ${status.name}: ${status.ok ? "ok" : "err"} ${status.message}`);
  }
  for (const endpoint of model.visibleEndpoints()) {
    const stats = model.stats.get(endpoint.url) ?? zeroStats();
    console.log(
      [
        typeLabel(endpoint.type, false),
        endpoint.url,
        `freq=${formatOptionalHz(stats.freq)}`,
        `rate=${formatOptionalBytes(stats.rate)}/s`,
        `loss=${formatOptionalFixed(stats.loss, 2, "%")}`,
        `latency=${formatOptionalFixed(stats.latency, 2, "ms")}`,
        `active=${stats.active ? "yes" : "no"}`,
        `source=${stats.source || "-"}`,
        `status=${stats.status}`,
      ].join(" "),
    );
  }
}

function fallbackProcess(endpoint: EndpointInfo): ProcessInfo {
  return {
    type: endpoint.type,
    host: hostname(),
    ip: "127.0.0.1",
    name: projectName(endpoint),
    pid: 0,
    profiler: null,
  };
}

function projectName(endpoint: EndpointInfo) {
  for (const source of endpoint.sources) {
    const service = source.match(/module\/service\/([^/]+)/)?.[1];
    if (service) return service;
    const pkg = source.match(/pkg\/idl\/([^/]+)/)?.[1];
    if (pkg) return `${pkg}_idl`;
  }
  const route = endpoint.url.replace(/^[a-z0-9+.-]+:\/\//, "");
  return route.split(/[/.:-]+/).filter(Boolean)[0] || "project";
}

function uniqueEndpoints(endpoints: EndpointInfo[]) {
  const seen = new Set<string>();
  const result: EndpointInfo[] = [];
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.url)) continue;
    seen.add(endpoint.url);
    result.push(endpoint);
  }
  return result.sort((left, right) => left.url.localeCompare(right.url));
}

function printHelpAndExit() {
  console.log(`pr-monitor

Usage:
  bun run monitor/pr-monitor/src/index.ts [options]

Options mirror the monitor workflow: -x preset, -l detail, -o observe all,
-p process panel, -c chart panel, -s schema column, -i route filter.
Runtime data is collected from project route YAML, local ps, Prometheus, and
ROS2 CLI when those sources are available. Missing samples are shown as ---.
Use --list-routes to print discovered project routes without starting the TUI.
Use --list-processes or --topology to print a vlink-list style process view.
`);
  process.exit(0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.presetMode) {
    options.detailMode = true;
    options.observeAllMode = true;
    options.processMode = true;
    options.chartMode = true;
  }
  if (!options.detailMode && options.observeAllMode) throw new Error("Observe all mode[-o] only use for Detail mode[-l].");
  if (!options.detailMode && options.activeMode) throw new Error("Active mode[-a] only use for Detail mode[-l].");
  if (options.chartWidth < 10 || options.chartWidth > 100) throw new Error("Invalid [chart_width], range 10 - 100.");
  if (options.processWidth < 20 || options.processWidth > 100) throw new Error("Invalid [process_width], range 20 - 100.");
  if (options.ros2SampleSeconds < 1 || options.ros2SampleSeconds > 10) throw new Error("Invalid [ros2-sample-seconds], range 1 - 10.");

  const model = new MonitorModel(options);
  await model.initialize();
  if (options.listRoutes) {
    for (const endpoint of model.visibleEndpoints()) {
      console.log(`${typeLabel(endpoint.type, false)} ${endpoint.url} ${endpoint.serType} ${endpoint.sources.join(",")}`);
    }
    return;
  }
  if (options.listProcesses) {
    await model.collect();
    printProcessList(model.visibleEndpoints());
    return;
  }
  if (options.plainMode) {
    const deadline = Date.now() + 35_000;
    do {
      await model.collect();
      if (model.collectorStatuses.some((status) => status.name === "ros2" && status.updatedAt > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    printPlainSample(model);
    return;
  }
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
    targetFps: 20,
    maxFps: 30,
    backgroundColor: color.bg,
  });
  const monitor = new MonitorRenderable(renderer, {
    model,
    flexGrow: 1,
    width: "100%",
    height: "100%",
  });

  renderer.root.add(monitor);
  renderer.focusRenderable(monitor);
  await model.collect();

  const collectTimer = setInterval(() => {
    void model.collect().finally(() => renderer.requestRender());
  }, COLLECT_INTERVAL_MS);

  const frameTimer = setInterval(() => {
    renderer.requestRender();
  }, FRAME_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(collectTimer);
    clearInterval(frameTimer);
    renderer.destroy();
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    void handleKey(key, model, renderer.height, shutdown).finally(() => renderer.requestRender());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
