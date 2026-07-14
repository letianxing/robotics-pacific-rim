import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { publicProcedure, router } from "../index";

const MODULE_SERVICE_ROOT = path.join("module", "service");
const IDL_ROOT = path.join("pkg", "idl");
const ROBOT_CAPABILITY_PATH = path.join("pkg", "robot", "capabilities.json");
const ROBOT_PROFILE_ROOT = path.join("deploy", "robot-profiles");
const SKIPPED_DIRS = new Set([
	".git",
	"node_modules",
	"out",
	"build",
	"install",
	"log",
]);
const CORE_PROJECTS = new Set([
	"module-smoke_001_service",
	"module-middleware_pub_test_service",
	"module-middleware_sub_test_service",
	"module-middleware_rpc_client_test_service",
	"module-middleware_rpc_server_test_service",
]);

const LEADING_SPACES_REGEX = /^ */;
const INLINE_COMMENT_REGEX = /\s+#.*$/;
const KEY_VALUE_REGEX = /^([A-Za-z0-9_.-]+):\s*(.*)$/;
const LINE_SPLIT_REGEX = /\r?\n/;
const ROUTE_KEY_REGEX = /^([A-Za-z0-9_./-]+):$/;
const UPPERCASE_REGEX = /[A-Z]/;
const MODULE_NAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PURE_NUMERIC_MODULE_NAME_REGEX = /^\d+(?:-\d+)*$/;
const DATA_FORMAT_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATA_FIELD_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTE_NAME_REGEX = /^(?:\/[A-Za-z0-9_./-]+|[A-Za-z_][A-Za-z0-9_./-]*)$/;
const PROTO_MESSAGE_REGEX = /^message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
const PROTO_FIELD_REGEX =
	/^(?:repeated\s+)?([A-Za-z_][A-Za-z0-9_.<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/;
const PROTO_PACKAGE_REGEX = /^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m;
const OPEN_BRACE_REGEX = /\{/g;
const CLOSE_BRACE_REGEX = /\}/g;
const ROS_COMMENT_REGEX = /#.*/;
const DDS_LINE_COMMENT_REGEX = /\/\/.*/;
const TRAILING_SEMICOLON_REGEX = /;$/;
const ROS2_SERVICE_TYPE_REFERENCE_REGEX = /(^|\/)srv\//;
const WHITESPACE_REGEX = /\s+/;
const execFileAsync = promisify(execFile);
const SNAPSHOT_CACHE_TTL_MS = 1000;
const CMAKE_PROJECT_NAME_REF = ["$", "{PROJECT_NAME}"].join("");

type CommunicationSection = "services" | "topics";
type CommunicationSource = "config" | "idl";
type DataFormatKind = "proto" | "msg" | "srv" | "dds_idl";
type RouteKind = "service" | "topic";
type RouteStatus = "configured" | "single-binding" | "observer-pending";
type TransportFamily = "cyclonedds" | "fastdds" | "nats" | "ros2";

interface ProjectJson {
	implicitDependencies?: unknown;
	name?: unknown;
	projectType?: unknown;
	root?: unknown;
	tags?: unknown;
	targets?: unknown;
}

export interface BindingSummary {
	address: string;
	direction: string;
	middleware: string;
	queueGroup: string;
	queueSize: string;
	transport: string;
}

export interface CommunicationRoute {
	bindings: BindingSummary[];
	configPath: string;
	direction: string;
	id: string;
	kind: RouteKind;
	messageType: string;
	module: string;
	name: string;
	status: RouteStatus;
}

export interface ModuleSummary {
	critical: boolean;
	dependencyCount: number;
	frameworks: string[];
	languages: string[];
	name: string;
	projectType: string;
	root: string;
	runtime: boolean;
	scope: string;
	tags: string[];
	targetNames: string[];
}

export interface ObservabilityEndpoint {
	href: string;
	id: string;
	label: string;
	url: string;
}

export interface EndpointStatus extends ObservabilityEndpoint {
	status: "online" | "degraded" | "offline";
	statusCode: number | null;
}

export interface TransportSummary {
	bindings: number;
	name: string;
	routes: number;
}

export interface DetailBindingSummary extends BindingSummary {
	standard: string;
}

export interface ModuleCommunicationItem {
	bindings: DetailBindingSummary[];
	definition: string;
	direction: string;
	format: string;
	id: string;
	kind: RouteKind;
	messageType: string;
	name: string;
	path: string;
	role: string;
	source: CommunicationSource;
	transportFamilies: TransportFamily[];
	transports: string[];
}

export interface DataFieldSummary {
	name: string;
	number: string;
	type: string;
}

export interface ModuleDataFormatItem {
	definition: string;
	fields: DataFieldSummary[];
	id: string;
	kind: DataFormatKind;
	name: string;
	path: string;
	source: string;
}

export interface ServiceDataFormatCatalog {
	formats: ModuleDataFormatItem[];
	service: string;
}

export interface ServicePublicInterfaceCatalog {
	interfaces: ModuleCommunicationItem[];
	service: string;
}

export interface ModuleDetail {
	communication: ModuleCommunicationItem[];
	configPath: string | null;
	dataFormatCatalog: ServiceDataFormatCatalog[];
	dataFormats: ModuleDataFormatItem[];
	idlRoot: string;
	module: ModuleSummary;
	publicInterfaceCatalog: ServicePublicInterfaceCatalog[];
}

export interface RobotCapabilitySignal {
	name: string;
	unit: string;
}

export interface RobotCapabilityContract {
	path: string;
	route: string;
	service: string;
	status: string;
}

export interface RobotCapability {
	contractStatus: string;
	contracts: RobotCapabilityContract[];
	family: string;
	id: string;
	recommendedIdlService: string;
	signals: RobotCapabilitySignal[];
	summary: string;
}

export interface RobotProfileService {
	capabilities: string[];
	notes: string;
	package: string;
	required: boolean;
	role: string;
	service: string;
}

export interface RobotProfileDeploy {
	defaultDomainId: number | null;
	rosDistro: string;
	targets: string[];
	transportFamilies: string[];
	verification: string[];
}

export interface RobotProfileAiNative {
	agentEntry: string;
	modulePolicy: string;
	skill: string;
}

export interface RobotProfile {
	aiNative: RobotProfileAiNative;
	capabilities: string[];
	deploy: RobotProfileDeploy;
	displayName: string;
	id: string;
	plannedServices: RobotProfileService[];
	robotClass: string;
	services: RobotProfileService[];
	status: string;
	summary: string;
}

export interface RobotProfileCatalog {
	activeProfiles: number;
	capabilities: RobotCapability[];
	capabilityPath: string;
	generatedAt: string;
	profileRoot: string;
	profiles: RobotProfile[];
	templateProfiles: number;
}

interface CachedSnapshot {
	createdAt: number;
	value: Awaited<ReturnType<typeof createSnapshotData>>;
}

interface ParsedLine {
	indent: number;
	lineNumber: number;
	raw: string;
	trimmed: string;
}

interface CommunicationParseState {
	currentBinding: Partial<BindingSummary> | null;
	currentList: "middlewares" | null;
	currentNested: "addresses" | null;
	currentRoute: CommunicationRoute | null;
	inCommunication: boolean;
	routes: CommunicationRoute[];
	section: CommunicationSection | null;
}

interface TransportCounter {
	bindings: number;
	routeIds: Set<string>;
}

const SUPPORTED_TRANSPORT_FAMILIES: TransportFamily[] = [
	"ros2",
	"cyclonedds",
	"fastdds",
	"nats",
];

const createModuleInput = z.object({
	name: z.string().trim().min(1),
	ros2: z.enum(["cpp", "go", "python"]).optional(),
	ros2Version: z
		.enum(["humble", "jazzy", "kilted", "lyrical", "rolling"])
		.optional(),
});

const moduleDetailInput = z.object({
	moduleName: z.string().min(1),
});

const communicationItemInput = moduleDetailInput.extend({
	definition: z.string().optional(),
	kind: z.enum(["service", "topic"]),
	name: z.string().min(1),
	path: z.string().min(1),
	source: z.enum(["config", "idl"]),
});

const dataFormatItemInput = moduleDetailInput.extend({
	definition: z.string().optional(),
	kind: z.enum(["proto", "msg", "srv", "dds_idl"]),
	name: z.string().min(1),
	path: z.string().min(1),
});

const dataFormatFieldInput = z.object({
	name: z.string().trim().min(1),
	type: z.string().trim().min(1),
});

const createDataFormatInput = moduleDetailInput.extend({
	fields: z.array(dataFormatFieldInput),
	kind: z.enum(["proto", "msg", "srv", "dds_idl"]),
	name: z.string().trim().min(1),
	responseFields: z.array(dataFormatFieldInput).optional(),
});

const createConsumerCommunicationInput = moduleDetailInput.extend({
	kind: z.enum(["service", "topic"]),
	providerService: z.string().min(1),
	routeName: z.string().min(1),
});

const createProviderCommunicationInput = moduleDetailInput.extend({
	communication: z.enum(["ros2", "nats", "cyclonedds", "fastdds"]),
	dataService: z.string().min(1),
	format: z.enum(["proto", "msg", "srv", "dds_idl"]),
	inputName: z.string().min(1),
	kind: z.enum(["service", "topic"]),
	name: z.string().trim().min(1),
	outputName: z.string().optional(),
});

const OBSERVABILITY_ENDPOINTS: ObservabilityEndpoint[] = [
	{
		id: "grafana",
		label: "Grafana",
		url: "http://localhost:16000/api/health",
		href: "http://localhost:16000",
	},
	{
		id: "prometheus",
		label: "Prometheus",
		url: "http://localhost:18180/-/ready",
		href: "http://localhost:18180",
	},
	{
		id: "loki",
		label: "Loki",
		url: "http://localhost:6200/ready",
		href: "http://localhost:6200",
	},
	{
		id: "tempo",
		label: "Tempo",
		url: "http://localhost:6400/ready",
		href: "http://localhost:6400",
	},
	{
		id: "otel",
		label: "OTel Collector",
		url: "http://localhost:26266",
		href: "http://localhost:26266",
	},
];

let cachedSnapshot: CachedSnapshot | undefined;

const countLeadingSpaces = (value: string): number => {
	const match = value.match(LEADING_SPACES_REGEX);
	return match?.[0].length ?? 0;
};

const scalarValue = (value: string): string => {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
};

const stripInlineComment = (line: string): string =>
	line.replace(INLINE_COMMENT_REGEX, "");

const yamlBlockFromLine = (text: string, startLine: number): string => {
	const lines = text.split(LINE_SPLIT_REGEX);
	const start = lines[startLine] ?? "";
	const startIndent = countLeadingSpaces(start);
	const block = [start];
	for (let index = startLine + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		if (trimmed && countLeadingSpaces(line) <= startIndent) {
			break;
		}
		block.push(line);
	}
	return block.join("\n").trimEnd();
};

const asStringArray = (value: unknown): string[] => {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
};

const asUnknownArray = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];

const asRecord = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
};

const asString = (value: unknown): string =>
	typeof value === "string" ? value : "";

const asBoolean = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

const asFiniteNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizePath = (value: string): string =>
	value.split(path.sep).join("/");

const toPackageName = (value: string): string => value.replaceAll("-", "_");

const toServiceName = (value: string): string => {
	const packageName = toPackageName(value);
	return packageName.endsWith("_service")
		? packageName
		: `${packageName}_service`;
};

const validateModuleName = (value: string): string => {
	const raw = value.trim();
	if (!raw) {
		throw new Error(
			"Invalid module name. Use lowercase kebab-case, for example: action-planner."
		);
	}
	if (UPPERCASE_REGEX.test(raw)) {
		throw new Error(
			`Invalid module name "${value}". Uppercase letters are not allowed.`
		);
	}
	if (
		!MODULE_NAME_REGEX.test(raw) ||
		PURE_NUMERIC_MODULE_NAME_REGEX.test(raw)
	) {
		throw new Error(
			`Invalid module name "${value}". Use lowercase kebab-case, start with a letter, and avoid underscores, spaces, duplicate separators, or pure numbers.`
		);
	}
	return raw;
};

const validateDataFormatName = (value: string): string => {
	const raw = value.trim();
	if (!DATA_FORMAT_NAME_REGEX.test(raw)) {
		throw new Error(
			`Invalid data format name "${value}". Use letters, numbers, and underscores, and start with a letter or underscore.`
		);
	}
	return raw;
};

const validateDataFieldName = (value: string): string => {
	const raw = value.trim();
	if (!DATA_FIELD_NAME_REGEX.test(raw)) {
		throw new Error(
			`Invalid field name "${value}". Use letters, numbers, and underscores, and start with a letter or underscore.`
		);
	}
	return raw;
};

const findRepoRoot = (): string => {
	if (process.env.PACIFIC_RIM_REPO_ROOT) {
		return process.env.PACIFIC_RIM_REPO_ROOT;
	}
	const candidates = [
		path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../.."),
		path.resolve(/* turbopackIgnore: true */ process.cwd(), ".."),
		path.resolve(/* turbopackIgnore: true */ process.cwd(), "."),
	];
	for (const candidate of candidates) {
		const isRepoRoot =
			existsSync(path.join(candidate, "module")) &&
			existsSync(path.join(candidate, "infra")) &&
			existsSync(path.join(candidate, "pkg"));
		if (isRepoRoot) {
			return candidate;
		}
	}
	return path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../..");
};

const absoluteRepoPath = (
	repoRoot: string,
	relativePath: string,
	allowedRoots: string[]
): string => {
	const normalized = normalizePath(relativePath);
	if (normalized.startsWith("../") || path.isAbsolute(normalized)) {
		throw new Error(`Invalid path outside repository: ${relativePath}`);
	}
	if (!allowedRoots.some((root) => normalized.startsWith(`${root}/`))) {
		throw new Error(`Path is not editable from dashboard: ${relativePath}`);
	}
	const absolutePath = path.resolve(repoRoot, normalized);
	const relative = path.relative(repoRoot, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Invalid path outside repository: ${relativePath}`);
	}
	return absolutePath;
};

const replaceLineRange = (
	lines: string[],
	start: number,
	end: number,
	replacement: string | null
): string => {
	const replacementLines = replacement
		? replacement.trimEnd().split(LINE_SPLIT_REGEX)
		: [];
	lines.splice(start, end - start, ...replacementLines);
	return `${lines.join("\n").trimEnd()}\n`;
};

const lineInfo = (line: string) => {
	const withoutComment = stripInlineComment(line);
	return {
		indent: countLeadingSpaces(withoutComment),
		trimmed: withoutComment.trim(),
	};
};

const yamlChildBlockRange = (
	lines: string[],
	start: number,
	parentIndent: number,
	name: string
): [number, number] | null => {
	const childIndent = parentIndent + 2;
	for (let index = start + 1; index < lines.length; index += 1) {
		const current = lineInfo(lines[index] ?? "");
		if (current.trimmed && current.indent <= parentIndent) {
			return null;
		}
		if (!(current.indent === childIndent && current.trimmed === `${name}:`)) {
			continue;
		}
		let end = index + 1;
		for (; end < lines.length; end += 1) {
			const next = lineInfo(lines[end] ?? "");
			if (next.trimmed && next.indent <= childIndent) {
				break;
			}
		}
		return [index, end];
	}
	return null;
};

const communicationSectionStart = (
	lines: string[],
	section: CommunicationSection
): number | null => {
	let inCommunication = false;
	for (let index = 0; index < lines.length; index += 1) {
		const current = lineInfo(lines[index] ?? "");
		if (current.indent === 0 && current.trimmed === "communication:") {
			inCommunication = true;
			continue;
		}
		if (inCommunication && current.indent === 0 && current.trimmed) {
			return null;
		}
		if (
			inCommunication &&
			current.indent === 2 &&
			(current.trimmed === `${section}:` ||
				current.trimmed === `${section}: {}`)
		) {
			return index;
		}
	}
	return null;
};

const replaceYamlRouteBlock = (
	text: string,
	section: CommunicationSection,
	name: string,
	replacement: string | null
): string => {
	const lines = text.split(LINE_SPLIT_REGEX);
	const sectionStart = communicationSectionStart(lines, section);
	const range =
		sectionStart === null
			? null
			: yamlChildBlockRange(lines, sectionStart, 2, name);
	if (!range) {
		throw new Error(`Unable to locate ${section.slice(0, -1)} "${name}".`);
	}
	return replaceLineRange(lines, range[0], range[1], replacement);
};

const routeBlockExists = (
	lines: string[],
	sectionStart: number,
	parentIndent: number,
	name: string
): boolean =>
	yamlChildBlockRange(lines, sectionStart, parentIndent, name) !== null;

const ensureBlockSection = (
	lines: string[],
	sectionStart: number,
	section: CommunicationSection
): void => {
	const current = lineInfo(lines[sectionStart] ?? "");
	if (current.trimmed === `${section}: {}`) {
		lines[sectionStart] = `${" ".repeat(current.indent)}${section}:`;
	}
};

const ensureCommunicationSection = (
	lines: string[],
	communicationStart: number,
	section: CommunicationSection
): number => {
	const existingSectionStart = communicationSectionStart(lines, section);
	if (existingSectionStart !== null) {
		ensureBlockSection(lines, existingSectionStart, section);
		return existingSectionStart;
	}
	let sectionStart = communicationStart + 1;
	for (; sectionStart < lines.length; sectionStart += 1) {
		const current = lineInfo(lines[sectionStart] ?? "");
		if (current.trimmed && current.indent <= 0) {
			break;
		}
	}
	lines.splice(sectionStart, 0, `  ${section}:`);
	return sectionStart;
};

const routeInsertIndex = (lines: string[], sectionStart: number): number => {
	let insertAt = sectionStart + 1;
	while (insertAt < lines.length) {
		const current = lineInfo(lines[insertAt] ?? "");
		if (current.trimmed) {
			break;
		}
		lines.splice(insertAt, 1);
	}
	for (; insertAt < lines.length; insertAt += 1) {
		const current = lineInfo(lines[insertAt] ?? "");
		if (current.trimmed && current.indent <= 2) {
			break;
		}
	}
	return insertAt;
};

const appendYamlRouteBlock = (
	text: string,
	section: CommunicationSection,
	name: string,
	replacement: string
): string => {
	const trimmedText = text.trimEnd();
	const lines = trimmedText ? trimmedText.split(LINE_SPLIT_REGEX) : [];
	let communicationStart = lines.findIndex((line) => {
		const current = lineInfo(line);
		return current.indent === 0 && current.trimmed === "communication:";
	});
	if (communicationStart === -1) {
		if (lines.length > 0 && lines.at(-1)?.trim()) {
			lines.push("");
		}
		communicationStart = lines.length;
		lines.push("communication:");
	}

	const sectionStart = ensureCommunicationSection(
		lines,
		communicationStart,
		section
	);

	if (routeBlockExists(lines, sectionStart, 2, name)) {
		throw new Error(`${section.slice(0, -1)} "${name}" already exists.`);
	}

	const insertAt = routeInsertIndex(lines, sectionStart);
	lines.splice(insertAt, 0, ...replacement.trimEnd().split(LINE_SPLIT_REGEX));
	return `${lines.join("\n").trimEnd()}\n`;
};

const appendTopLevelYamlRouteBlock = (
	text: string,
	section: CommunicationSection,
	name: string,
	replacement: string
): string => {
	const trimmedText = text.trimEnd();
	const lines = trimmedText ? trimmedText.split(LINE_SPLIT_REGEX) : [];
	let sectionStart = lines.findIndex((line) => {
		const current = lineInfo(line);
		return current.indent === 0 && current.trimmed === `${section}:`;
	});
	if (sectionStart === -1) {
		if (lines.length > 0 && lines.at(-1)?.trim()) {
			lines.push("");
		}
		sectionStart = lines.length;
		lines.push(`${section}:`);
	}
	if (routeBlockExists(lines, sectionStart, 0, name)) {
		throw new Error(`${section.slice(0, -1)} "${name}" already exists.`);
	}

	let insertAt = sectionStart + 1;
	for (; insertAt < lines.length; insertAt += 1) {
		const current = lineInfo(lines[insertAt] ?? "");
		if (current.trimmed && current.indent <= 0) {
			break;
		}
	}
	lines.splice(insertAt, 0, ...replacement.trimEnd().split(LINE_SPLIT_REGEX));
	return `${lines.join("\n").trimEnd()}\n`;
};

const replaceTopLevelYamlBlock = (
	text: string,
	section: CommunicationSection,
	name: string,
	replacement: string | null
): string => {
	const lines = text.split(LINE_SPLIT_REGEX);
	const sectionStart = lines.findIndex((line) => {
		const current = lineInfo(line);
		return current.indent === 0 && current.trimmed === `${section}:`;
	});
	const range =
		sectionStart === -1
			? null
			: yamlChildBlockRange(lines, sectionStart, 0, name);
	if (!range) {
		throw new Error(`Unable to locate ${section.slice(0, -1)} "${name}".`);
	}
	return replaceLineRange(lines, range[0], range[1], replacement);
};

const replaceProtoMessageBlock = (
	text: string,
	name: string,
	replacement: string | null
): string => {
	const lines = text.split(LINE_SPLIT_REGEX);
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index]?.trim().startsWith(`message ${name}`)) {
			continue;
		}
		let depth = 0;
		let endIndex = index;
		for (; endIndex < lines.length; endIndex += 1) {
			const line = lines[endIndex] ?? "";
			depth += (line.match(OPEN_BRACE_REGEX) ?? []).length;
			depth -= (line.match(CLOSE_BRACE_REGEX) ?? []).length;
			if (depth <= 0 && endIndex > index) {
				endIndex += 1;
				break;
			}
		}
		const replacementLines = replacement
			? replacement.trimEnd().split(LINE_SPLIT_REGEX)
			: [];
		lines.splice(index, endIndex - index, ...replacementLines);
		return `${lines.join("\n").trimEnd()}\n`;
	}
	throw new Error(`Unable to locate proto message "${name}".`);
};

const appendProtoMessageBlock = (
	text: string,
	name: string,
	replacement: string
): string => {
	if (text.includes(`message ${name}`)) {
		throw new Error(`Proto message "${name}" already exists.`);
	}
	return `${text.trimEnd()}\n\n${replacement.trimEnd()}\n`;
};

const protoPackageFromDefinition = (
	definition: string,
	serviceName: string
): string => {
	const packageName = definition.match(PROTO_PACKAGE_REGEX)?.[1];
	return packageName ?? `pacific_rim.${serviceName}.protocols.pb`;
};

const publicTypeFromDataFormat = (
	format: ModuleDataFormatItem,
	serviceName: string
): string => {
	if (format.kind === "proto") {
		return `${protoPackageFromDefinition(format.definition, serviceName)}.${format.name}`;
	}
	if (format.kind === "dds_idl") {
		return `${serviceName}::${format.name}`;
	}
	if (format.kind === "srv") {
		return `${serviceName}/srv/${format.name}`;
	}
	return `${serviceName}/msg/${format.name}`;
};

const validateRouteName = (value: string): string => {
	const name = value.trim();
	if (!ROUTE_NAME_REGEX.test(name)) {
		throw new Error(
			`Invalid route name "${value}". Use letters, numbers, underscores, slashes, dots, or dashes. Names must start with a slash, letter, or underscore.`
		);
	}
	return name;
};

const routeReference = (serviceName: string, routeName: string): string =>
	routeName.startsWith("/") ? routeName : `${serviceName}.${routeName}`;

const ros2RouteAddress = (serviceName: string, routeName: string): string =>
	routeName.startsWith("/") ? routeName : `/${serviceName}/${routeName}`;

const renderProtoMessage = (
	name: string,
	fields: z.infer<typeof dataFormatFieldInput>[]
): string =>
	[
		`message ${name} {`,
		...fields.map(
			(field, index) =>
				`  ${field.type.trim()} ${validateDataFieldName(field.name)} = ${index + 1};`
		),
		"}",
	].join("\n");

const isRos2ServiceTypeReference = (type: string): boolean => {
	const normalized = type.trim();
	return (
		ROS2_SERVICE_TYPE_REFERENCE_REGEX.test(normalized) ||
		normalized.startsWith("std_srvs/")
	);
};

const renderRosFields = (
	fields: z.infer<typeof dataFormatFieldInput>[]
): string =>
	fields
		.map((field) => {
			const type = field.type.trim();
			if (isRos2ServiceTypeReference(type)) {
				throw new Error(`ROS2 fields cannot use srv type "${type}".`);
			}
			return `${type} ${validateDataFieldName(field.name)}`;
		})
		.join("\n");

const renderDdsIdlStruct = (
	name: string,
	fields: z.infer<typeof dataFormatFieldInput>[]
): string =>
	[
		`struct ${name} {`,
		...fields.map(
			(field) => `  ${field.type.trim()} ${validateDataFieldName(field.name)};`
		),
		"};",
	].join("\n");

const renderDataFormatDefinition = (
	input: z.infer<typeof createDataFormatInput>
): string => {
	const name = validateDataFormatName(input.name);
	if (input.kind === "proto") {
		return renderProtoMessage(name, input.fields);
	}
	if (input.kind === "srv") {
		const request = renderRosFields(input.fields);
		const response = renderRosFields(input.responseFields ?? []);
		return `${request}${request ? "\n" : ""}---${response ? `\n${response}` : ""}`;
	}
	if (input.kind === "dds_idl") {
		return renderDdsIdlStruct(name, input.fields);
	}
	return renderRosFields(input.fields);
};

const listFilesWithExtension = async (
	root: string,
	extension: string
): Promise<string[]> => {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
};

const ros2DefinitionDependencies = (
	content: string,
	serviceName: string
): string[] => {
	const dependencies = new Set<string>();
	for (const rawLine of content.split(LINE_SPLIT_REGEX)) {
		const line = rawLine.replace(ROS_COMMENT_REGEX, "").trim();
		if (!line || line === "---") {
			continue;
		}
		const [rawType = ""] = line.split(WHITESPACE_REGEX, 1);
		const type = rawType.replace(/<=\d+/g, "").replace(/\[[^\]]*\]/g, "");
		if (!type.includes("/")) {
			continue;
		}
		const [pkg = ""] = type.split("/");
		if (pkg && pkg !== serviceName) {
			dependencies.add(pkg);
		}
	}
	return [...dependencies].sort((left, right) => left.localeCompare(right));
};

const ros2InterfaceDependencies = async (
	packageDir: string,
	interfaceFiles: string[],
	serviceName: string
): Promise<string[]> => {
	const dependencies = new Set<string>();
	for (const interfaceFile of interfaceFiles) {
		const text = await readFile(path.join(packageDir, interfaceFile), "utf8");
		for (const dependency of ros2DefinitionDependencies(text, serviceName)) {
			dependencies.add(dependency);
		}
	}
	return [...dependencies].sort((left, right) => left.localeCompare(right));
};

const renderRos2PackageCMake = (
	serviceName: string,
	interfaceFiles: string[],
	dependencies: string[]
): string =>
	[
		"cmake_minimum_required(VERSION 3.8)",
		`project(${serviceName})`,
		"",
		"find_package(ament_cmake REQUIRED)",
		"find_package(rosidl_default_generators REQUIRED)",
		...dependencies.map((dependency) => `find_package(${dependency} REQUIRED)`),
		"",
		`rosidl_generate_interfaces(${CMAKE_PROJECT_NAME_REF}`,
		...interfaceFiles.map((file) => `  "${file}"`),
		dependencies.length ? `  DEPENDENCIES ${dependencies.join(" ")}` : "",
		")",
		"",
		"ament_export_dependencies(rosidl_default_runtime)",
		"ament_package()",
		"",
	]
		.filter((line, index, lines) => line || lines[index - 1] !== "")
		.join("\n");

const renderRos2PackageXml = (
	serviceName: string,
	dependencies: string[]
): string =>
	[
		'<?xml version="1.0"?>',
		'<package format="3">',
		`  <name>${serviceName}</name>`,
		"  <version>0.1.0</version>",
		`  <description>ROS2 interfaces for the ${serviceName} public contract.</description>`,
		'  <maintainer email="dev@example.com">Pacific-Rim Developers</maintainer>',
		"  <license>TODO</license>",
		"",
		"  <buildtool_depend>ament_cmake</buildtool_depend>",
		"  <build_depend>rosidl_default_generators</build_depend>",
		...dependencies.map((dependency) => `  <depend>${dependency}</depend>`),
		"",
		"  <exec_depend>rosidl_default_runtime</exec_depend>",
		"",
		"  <member_of_group>rosidl_interface_packages</member_of_group>",
		"",
		"  <export>",
		"    <build_type>ament_cmake</build_type>",
		"  </export>",
		"</package>",
		"",
	].join("\n");

const writeRos2PackageMetadata = async (
	repoRoot: string,
	serviceName: string
): Promise<void> => {
	const packageDir = path.join(
		repoRoot,
		IDL_ROOT,
		serviceName,
		"ros2",
		serviceName
	);
	const msgFiles = await listFilesWithExtension(
		path.join(packageDir, "msg"),
		".msg"
	);
	const srvFiles = await listFilesWithExtension(
		path.join(packageDir, "srv"),
		".srv"
	);
	const interfaceFiles = [
		...msgFiles.map((file) => `msg/${file}`),
		...srvFiles.map((file) => `srv/${file}`),
	].sort((left, right) => left.localeCompare(right));
	const cmakePath = path.join(packageDir, "CMakeLists.txt");
	const packageXmlPath = path.join(packageDir, "package.xml");
	if (!interfaceFiles.length) {
		await rm(cmakePath, { force: true });
		await rm(packageXmlPath, { force: true });
		return;
	}
	const dependencies = await ros2InterfaceDependencies(
		packageDir,
		interfaceFiles,
		serviceName
	);
	await writeFile(
		cmakePath,
		renderRos2PackageCMake(serviceName, interfaceFiles, dependencies),
		"utf8"
	);
	await writeFile(
		packageXmlPath,
		renderRos2PackageXml(serviceName, dependencies),
		"utf8"
	);
};

const walkForExtensions = async (
	root: string,
	extensions: readonly string[],
	maxDepth: number
): Promise<string[]> => {
	if (maxDepth < 0 || !existsSync(root)) {
		return [];
	}
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (SKIPPED_DIRS.has(entry.name)) {
			continue;
		}
		const absolutePath = path.join(root, entry.name);
		if (
			entry.isFile() &&
			extensions.some((item) => entry.name.endsWith(item))
		) {
			files.push(absolutePath);
			continue;
		}
		if (entry.isDirectory()) {
			files.push(
				...(await walkForExtensions(absolutePath, extensions, maxDepth - 1))
			);
		}
	}
	return files;
};

const walkForFiles = async (
	root: string,
	fileName: string,
	maxDepth: number
): Promise<string[]> => {
	if (maxDepth < 0 || !existsSync(root)) {
		return [];
	}
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (SKIPPED_DIRS.has(entry.name)) {
			continue;
		}
		const absolutePath = path.join(root, entry.name);
		if (entry.isFile() && entry.name === fileName) {
			files.push(absolutePath);
			continue;
		}
		if (entry.isDirectory()) {
			files.push(...(await walkForFiles(absolutePath, fileName, maxDepth - 1)));
		}
	}
	return files;
};

const findModuleConfigPath = (
	repoRoot: string,
	moduleRoot: string
): string | null => {
	const candidates = [
		path.join(repoRoot, moduleRoot, "src", "config", "config.yaml"),
		path.join(repoRoot, moduleRoot, "config", "config.yaml"),
		path.join(repoRoot, moduleRoot, "config.yaml"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const createModuleFromInput = async (
	input: z.infer<typeof createModuleInput>
) => {
	const repoRoot = findRepoRoot();
	const name = validateModuleName(input.name);
	const args = ["bin/create.mjs", "module", name];
	if (input.ros2) {
		args.push("--ros2", input.ros2);
	}
	if (input.ros2Version) {
		args.push("--ros2-version", input.ros2Version);
	}

	const { stderr, stdout } = await execFileAsync("node", args, {
		cwd: repoRoot,
		env: process.env,
	});
	cachedSnapshot = undefined;

	return {
		command: `node ${args.join(" ")}`,
		moduleRoot: normalizePath(
			path.join(MODULE_SERVICE_ROOT, toServiceName(name))
		),
		stderr,
		stdout,
	};
};

const readProjectSummaries = async (
	repoRoot: string
): Promise<ModuleSummary[]> => {
	const projectFiles = await walkForFiles(
		path.join(repoRoot, MODULE_SERVICE_ROOT),
		"project.json",
		1
	);

	const projects: ModuleSummary[] = [];
	for (const projectFile of projectFiles) {
		const raw = await readFile(projectFile, "utf8");
		const parsed = JSON.parse(raw) as ProjectJson;
		const tags = asStringArray(parsed.tags);
		const targets = asRecord(parsed.targets);
		const name =
			typeof parsed.name === "string"
				? parsed.name
				: path.basename(path.dirname(projectFile));
		const root =
			typeof parsed.root === "string"
				? parsed.root
				: path.relative(repoRoot, path.dirname(projectFile));
		const projectType =
			typeof parsed.projectType === "string" ? parsed.projectType : "unknown";
		const scope =
			tags.find((tag) => tag.startsWith("scope:"))?.replace("scope:", "") ??
			root.split(path.sep)[0] ??
			"unknown";
		const languages = tags
			.filter((tag) => tag.startsWith("language:"))
			.map((tag) => tag.replace("language:", ""));
		const frameworks = tags
			.filter((tag) => tag.startsWith("framework:") || tag.startsWith("ros2:"))
			.map((tag) => tag.replace("framework:", ""));
		const runtime =
			projectType === "application" || tags.includes("platform:runtime");

		projects.push({
			name,
			root,
			scope,
			projectType,
			runtime,
			tags,
			languages,
			frameworks,
			dependencyCount: asStringArray(parsed.implicitDependencies).length,
			targetNames: Object.keys(targets).sort(),
			critical: CORE_PROJECTS.has(name),
		});
	}

	return projects.sort((left, right) => left.root.localeCompare(right.root));
};

const parseKeyValue = (trimmedLine: string): [string, string] | null => {
	const match = trimmedLine.match(KEY_VALUE_REGEX);
	if (!match) {
		return null;
	}
	const [, key, value] = match;
	if (!key) {
		return null;
	}
	return [key, scalarValue(value ?? "")];
};

const addressFromBinding = (binding: Partial<BindingSummary>): string =>
	binding.address ?? "";

const transportFromBinding = (binding: Partial<BindingSummary>): string =>
	binding.transport ?? binding.middleware ?? "";

const routeStatusFromBindings = (bindingCount: number): RouteStatus => {
	if (bindingCount > 1) {
		return "observer-pending";
	}
	if (bindingCount === 1) {
		return "single-binding";
	}
	return "configured";
};

const appendBinding = (
	route: CommunicationRoute | null,
	binding: Partial<BindingSummary> | null
): void => {
	if (!(route && binding)) {
		return;
	}
	const transport = transportFromBinding(binding);
	if (!transport) {
		return;
	}
	const existing = route.bindings.find((item) => item.transport === transport);
	if (existing) {
		existing.middleware =
			existing.middleware || binding.middleware || transport;
		existing.address = existing.address || addressFromBinding(binding);
		existing.direction = existing.direction || binding.direction || "";
		existing.queueGroup = existing.queueGroup || binding.queueGroup || "";
		existing.queueSize = existing.queueSize || binding.queueSize || "";
		return;
	}
	route.bindings.push({
		transport,
		middleware: binding.middleware ?? transport,
		address: addressFromBinding(binding),
		direction: binding.direction ?? "",
		queueGroup: binding.queueGroup ?? "",
		queueSize: binding.queueSize ?? "",
	});
};

const completeRoute = (state: CommunicationParseState): void => {
	appendBinding(state.currentRoute, state.currentBinding);
	if (state.currentRoute) {
		state.currentRoute.status = routeStatusFromBindings(
			state.currentRoute.bindings.length
		);
		state.routes.push(state.currentRoute);
	}
	state.currentRoute = null;
	state.currentBinding = null;
	state.currentList = null;
	state.currentNested = null;
};

const createRoute = (
	configPath: string,
	moduleName: string,
	section: CommunicationSection,
	routeName: string
): CommunicationRoute => ({
	id: `${configPath}:${section}:${routeName}`,
	module: moduleName,
	configPath,
	kind: section === "services" ? "service" : "topic",
	name: routeName,
	direction: "",
	messageType: "",
	bindings: [],
	status: "configured",
});

const parsedCommunicationLine = (
	rawLine: string,
	lineNumber: number
): ParsedLine | null => {
	const line = stripInlineComment(rawLine);
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	return {
		indent: countLeadingSpaces(line),
		lineNumber,
		raw: line,
		trimmed,
	};
};

const updateCommunicationScope = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (line.indent !== 0) {
		return false;
	}
	if (state.inCommunication) {
		completeRoute(state);
	}
	state.inCommunication = line.trimmed === "communication:";
	state.section = null;
	return true;
};

const updateCommunicationSection = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (
		line.indent !== 2 ||
		!(line.trimmed === "services:" || line.trimmed === "topics:")
	) {
		return false;
	}
	completeRoute(state);
	state.section = line.trimmed === "services:" ? "services" : "topics";
	return true;
};

const startRoute = (
	state: CommunicationParseState,
	line: ParsedLine,
	configPath: string,
	moduleName: string
): boolean => {
	const routeKeyMatch = line.trimmed.match(ROUTE_KEY_REGEX);
	if (!(line.indent === 4 && routeKeyMatch && state.section)) {
		return false;
	}
	completeRoute(state);
	state.currentRoute = createRoute(
		configPath,
		moduleName,
		state.section,
		routeKeyMatch[1] ?? "unknown"
	);
	return true;
};

const updateRouteMetadata = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (!(state.currentRoute && line.indent === 6)) {
		return false;
	}
	state.currentList = null;
	state.currentNested = null;
	const pair = parseKeyValue(line.trimmed);
	if (pair?.[0] === "service_type" || pair?.[0] === "message_type") {
		state.currentRoute.messageType = pair[1];
	}
	if (pair?.[0] === "service_ref" || pair?.[0] === "topic_ref") {
		state.currentRoute.messageType = pair[1];
	}
	if (pair?.[0] === "direction") {
		state.currentRoute.direction = pair[1];
		if (state.currentBinding) {
			state.currentBinding.direction = pair[1];
		}
	}
	if (pair?.[0] === "middleware") {
		appendBinding(state.currentRoute, {
			direction: state.currentRoute.direction,
			middleware: pair[1],
			transport: pair[1],
		});
	}
	if (line.trimmed === "middlewares:") {
		state.currentList = "middlewares";
	}
	if (line.trimmed === "addresses:") {
		state.currentNested = "addresses";
	}
	return true;
};

const updateRouteListValue = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (
		!(
			state.currentRoute &&
			state.currentList === "middlewares" &&
			line.indent === 8 &&
			line.trimmed.startsWith("- ")
		)
	) {
		return false;
	}
	const transport = scalarValue(line.trimmed.slice(2));
	appendBinding(state.currentRoute, {
		direction: state.currentRoute.direction,
		middleware: transport,
		transport,
	});
	return true;
};

const updateAddressValue = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	const pair = parseKeyValue(line.trimmed);
	if (
		!(
			state.currentRoute &&
			state.currentNested === "addresses" &&
			line.indent === 8 &&
			pair
		)
	) {
		return false;
	}
	if (!state.currentRoute.messageType) {
		state.currentRoute.messageType = pair[1];
	}
	appendBinding(state.currentRoute, {
		address: pair[1],
		direction: state.currentRoute.direction,
		middleware: pair[0],
		transport: pair[0],
	});
	return true;
};

const startBinding = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (
		!(state.currentRoute && line.indent === 8 && line.trimmed.startsWith("- "))
	) {
		return false;
	}
	appendBinding(state.currentRoute, state.currentBinding);
	state.currentBinding = {};
	const pair = parseKeyValue(line.trimmed.slice(2).trim());
	if (pair?.[0] === "transport") {
		state.currentBinding.transport = pair[1];
	}
	state.currentBinding.direction = state.currentRoute.direction;
	return true;
};

const applyBindingValue = (
	binding: Partial<BindingSummary>,
	key: string,
	value: string
): void => {
	if (key === "transport") {
		binding.transport = value;
		return;
	}
	if (key === "middleware") {
		binding.middleware = value;
		binding.transport ??= value;
		return;
	}
	if (key === "subject" || key === "service" || key === "topic") {
		binding.address = value;
		return;
	}
	if (key === "direction") {
		binding.direction = value;
		return;
	}
	if (key === "queue_group") {
		binding.queueGroup = value;
		return;
	}
	if (key === "queue_size") {
		binding.queueSize = value;
	}
};

const updateBinding = (
	state: CommunicationParseState,
	line: ParsedLine
): boolean => {
	if (!(state.currentBinding && line.indent >= 10)) {
		return false;
	}
	const pair = parseKeyValue(line.trimmed);
	if (pair) {
		applyBindingValue(state.currentBinding, pair[0], pair[1]);
	}
	return true;
};

const parseCommunicationLine = (
	state: CommunicationParseState,
	line: ParsedLine,
	configPath: string,
	moduleName: string
): void => {
	if (updateCommunicationScope(state, line) || !state.inCommunication) {
		return;
	}
	if (updateCommunicationSection(state, line) || !state.section) {
		return;
	}
	if (startRoute(state, line, configPath, moduleName)) {
		return;
	}
	if (updateRouteMetadata(state, line)) {
		return;
	}
	if (updateRouteListValue(state, line)) {
		return;
	}
	if (updateAddressValue(state, line)) {
		return;
	}
	if (startBinding(state, line)) {
		return;
	}
	updateBinding(state, line);
};

const parseCommunicationRoutes = (
	text: string,
	configPath: string,
	moduleName: string
): CommunicationRoute[] => {
	const state: CommunicationParseState = {
		inCommunication: false,
		section: null,
		currentRoute: null,
		currentBinding: null,
		currentList: null,
		currentNested: null,
		routes: [],
	};

	for (const [lineNumber, rawLine] of text.split(LINE_SPLIT_REGEX).entries()) {
		const line = parsedCommunicationLine(rawLine, lineNumber);
		if (!line) {
			continue;
		}
		parseCommunicationLine(state, line, configPath, moduleName);
	}

	completeRoute(state);
	return state.routes;
};

interface DetailRouteDraft {
	bindings: DetailBindingSummary[];
	definition: string;
	direction: string;
	format: string;
	kind: RouteKind;
	messageType: string;
	name: string;
	path: string;
	role: string;
	routeBinding: Partial<DetailBindingSummary>;
	source: CommunicationSource;
}

interface DetailCommunicationParseState {
	currentBinding: Partial<DetailBindingSummary> | null;
	currentList: "middlewares" | null;
	currentNested: "addresses" | "contract" | "payload" | null;
	currentRoute: DetailRouteDraft | null;
	inCommunication: boolean;
	items: ModuleCommunicationItem[];
	section: CommunicationSection | null;
}

const transportFamily = (transport: string): TransportFamily | null => {
	const lower = transport.toLowerCase();
	if (lower.includes("nats")) {
		return "nats";
	}
	if (lower.includes("fastdds") || lower.includes("fastrtps")) {
		return "fastdds";
	}
	if (lower.includes("cyclonedds") || lower.includes("dds")) {
		return "cyclonedds";
	}
	if (lower.includes("ros2")) {
		return "ros2";
	}
	return null;
};

const transportFamiliesFromTransports = (
	transports: string[]
): TransportFamily[] => [
	...new Set(
		transports
			.map(transportFamily)
			.filter((family): family is TransportFamily => Boolean(family))
	),
];

const createDetailBinding = (
	transport: string,
	route: DetailRouteDraft
): Partial<DetailBindingSummary> => ({
	transport,
	middleware: transport,
	direction: route.direction,
	queueGroup: route.routeBinding.queueGroup ?? "",
	queueSize: route.routeBinding.queueSize ?? "",
});

const appendDetailTransport = (
	route: DetailRouteDraft | null,
	transport: string,
	address = ""
): void => {
	if (!(route && transport)) {
		return;
	}
	appendDetailBinding(route, {
		...createDetailBinding(transport, route),
		address,
	});
};

const applyDetailBindingValue = (
	binding: Partial<DetailBindingSummary>,
	key: string,
	value: string
): void => {
	if (key === "transport") {
		binding.transport = value;
		return;
	}
	if (key === "middleware") {
		binding.middleware = value;
		binding.transport ??= value;
		return;
	}
	if (key === "subject" || key === "service" || key === "topic") {
		binding.address = value;
		return;
	}
	if (key === "request" || key === "response") {
		binding.address = binding.address ? `${binding.address} / ${value}` : value;
		return;
	}
	if (key === "direction") {
		binding.direction = value;
		return;
	}
	if (key === "queue_group") {
		binding.queueGroup = value;
		return;
	}
	if (key === "queue_size") {
		binding.queueSize = value;
		return;
	}
	if (key === "standard") {
		binding.standard = value;
	}
};

const appendDetailBinding = (
	route: DetailRouteDraft | null,
	binding: Partial<DetailBindingSummary> | null
): void => {
	if (!(route && binding)) {
		return;
	}
	const transport = transportFromBinding(binding);
	if (!transport) {
		return;
	}
	const existing = route.bindings.find((item) => item.transport === transport);
	if (existing) {
		existing.middleware =
			existing.middleware || binding.middleware || transport;
		existing.address = existing.address || addressFromBinding(binding);
		existing.direction =
			existing.direction || binding.direction || route.direction;
		existing.queueGroup =
			existing.queueGroup ||
			binding.queueGroup ||
			route.routeBinding.queueGroup ||
			"";
		existing.queueSize =
			existing.queueSize ||
			binding.queueSize ||
			route.routeBinding.queueSize ||
			"";
		existing.standard = existing.standard || binding.standard || "";
		return;
	}
	route.bindings.push({
		transport,
		middleware: binding.middleware ?? transport,
		address: addressFromBinding(binding),
		direction: binding.direction ?? route.direction,
		queueGroup: binding.queueGroup ?? route.routeBinding.queueGroup ?? "",
		queueSize: binding.queueSize ?? route.routeBinding.queueSize ?? "",
		standard: binding.standard ?? "",
	});
};

const completeDetailRoute = (state: DetailCommunicationParseState): void => {
	appendDetailBinding(state.currentRoute, state.currentBinding);
	if (!state.currentRoute) {
		state.currentBinding = null;
		state.currentNested = null;
		return;
	}
	if (state.currentRoute.bindings.length === 0) {
		appendDetailBinding(state.currentRoute, state.currentRoute.routeBinding);
	}
	const transports = [
		...new Set(state.currentRoute.bindings.map((binding) => binding.transport)),
	];
	state.items.push({
		id: `${state.currentRoute.source}:${state.currentRoute.path}:${state.currentRoute.kind}:${state.currentRoute.name}`,
		name: state.currentRoute.name,
		kind: state.currentRoute.kind,
		source: state.currentRoute.source,
		path: state.currentRoute.path,
		definition: state.currentRoute.definition,
		role: state.currentRoute.role,
		direction: state.currentRoute.direction,
		format: state.currentRoute.format,
		messageType: state.currentRoute.messageType,
		bindings: state.currentRoute.bindings,
		transports,
		transportFamilies: transportFamiliesFromTransports(transports),
	});
	state.currentRoute = null;
	state.currentBinding = null;
	state.currentNested = null;
	state.currentList = null;
};

const createDetailRoute = (
	definition: string,
	source: CommunicationSource,
	pathValue: string,
	section: CommunicationSection,
	name: string
): DetailRouteDraft => ({
	name,
	kind: section === "services" ? "service" : "topic",
	source,
	path: pathValue,
	definition,
	role: "",
	direction: "",
	format: "",
	messageType: "",
	bindings: [],
	routeBinding: {},
});

const applyDetailRouteValue = (
	route: DetailRouteDraft,
	key: string,
	value: string
): void => {
	if (key === "service_ref" || key === "topic_ref") {
		route.messageType = value;
		route.format = route.format || "ref";
		return;
	}
	if (key === "data" || key === "data_format") {
		route.format = value;
		return;
	}
	if (key === "service_type" || key === "message_type" || key === "type") {
		route.messageType = value;
		return;
	}
	if (key === "format") {
		route.format = value;
		return;
	}
	if (key === "role") {
		route.role = value;
		return;
	}
	if (key === "direction") {
		route.direction = value;
		route.routeBinding.direction = value;
		return;
	}
	if (key === "queue_group" || key === "queue_size") {
		applyDetailBindingValue(route.routeBinding, key, value);
		return;
	}
	applyDetailBindingValue(route.routeBinding, key, value);
};

interface DetailParseLayout {
	bindingIndent: number;
	nestedValueIndent: number;
	routeIndent: number;
	sectionIndent: number;
	source: CommunicationSource;
	startsInCommunication: boolean;
	topLevelCommunication: boolean;
	valueIndent: number;
}

const createDetailParseState = (
	startsInCommunication: boolean
): DetailCommunicationParseState => ({
	inCommunication: startsInCommunication,
	section: null,
	currentRoute: null,
	currentBinding: null,
	currentNested: null,
	currentList: null,
	items: [],
});

const handleDetailTopLevel = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	if (!layout.topLevelCommunication || line.indent !== 0) {
		return false;
	}
	if (state.inCommunication) {
		completeDetailRoute(state);
	}
	state.inCommunication = line.trimmed === "communication:";
	state.section = null;
	return true;
};

const handleDetailSection = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	if (
		line.indent !== layout.sectionIndent ||
		!(line.trimmed === "services:" || line.trimmed === "topics:")
	) {
		return false;
	}
	completeDetailRoute(state);
	state.section = line.trimmed === "services:" ? "services" : "topics";
	return true;
};

const handleDetailRouteStart = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	text: string,
	pathValue: string,
	layout: DetailParseLayout
): boolean => {
	const routeKeyMatch = line.trimmed.match(ROUTE_KEY_REGEX);
	if (!(state.section && line.indent === layout.routeIndent && routeKeyMatch)) {
		return false;
	}
	completeDetailRoute(state);
	state.currentRoute = createDetailRoute(
		yamlBlockFromLine(text, line.lineNumber),
		layout.source,
		pathValue,
		state.section,
		routeKeyMatch[1] ?? "unknown"
	);
	return true;
};

const handleDetailRouteValue = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	if (!(state.currentRoute && line.indent === layout.valueIndent)) {
		return false;
	}
	state.currentNested = null;
	state.currentList = null;
	if (
		line.trimmed === "payload:" ||
		line.trimmed === "contract:" ||
		line.trimmed === "addresses:"
	) {
		state.currentNested = line.trimmed.slice(0, -1) as
			| "addresses"
			| "contract"
			| "payload";
		return true;
	}
	if (line.trimmed === "bindings:") {
		return true;
	}
	if (line.trimmed === "middlewares:") {
		state.currentList = "middlewares";
		return true;
	}
	const pair = parseKeyValue(line.trimmed);
	if (pair) {
		applyDetailRouteValue(state.currentRoute, pair[0], pair[1]);
	}
	return true;
};

const handleDetailNestedValue = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	const pair = parseKeyValue(line.trimmed);
	if (
		!(
			state.currentRoute &&
			state.currentNested &&
			line.indent === layout.nestedValueIndent &&
			pair
		)
	) {
		return false;
	}
	applyDetailRouteValue(state.currentRoute, pair[0], pair[1]);
	return true;
};

const handleDetailListValue = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	if (
		!(
			state.currentRoute &&
			state.currentList === "middlewares" &&
			line.indent === layout.nestedValueIndent &&
			line.trimmed.startsWith("- ")
		)
	) {
		return false;
	}
	appendDetailTransport(state.currentRoute, scalarValue(line.trimmed.slice(2)));
	return true;
};

const handleDetailAddressValue = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	const pair = parseKeyValue(line.trimmed);
	if (
		!(
			state.currentRoute &&
			state.currentNested === "addresses" &&
			line.indent === layout.nestedValueIndent &&
			pair
		)
	) {
		return false;
	}
	appendDetailTransport(state.currentRoute, pair[0], pair[1]);
	return true;
};

const handleDetailBindingStart = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	if (
		!(
			state.currentRoute &&
			line.indent === layout.bindingIndent &&
			line.trimmed.startsWith("- ")
		)
	) {
		return false;
	}
	appendDetailBinding(state.currentRoute, state.currentBinding);
	state.currentBinding = {};
	const bindingPair = parseKeyValue(line.trimmed.slice(2).trim());
	if (bindingPair) {
		applyDetailBindingValue(
			state.currentBinding,
			bindingPair[0],
			bindingPair[1]
		);
	}
	return true;
};

const handleDetailBindingValue = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	layout: DetailParseLayout
): boolean => {
	const pair = parseKeyValue(line.trimmed);
	if (
		!(state.currentBinding && line.indent >= layout.bindingIndent + 2 && pair)
	) {
		return false;
	}
	applyDetailBindingValue(state.currentBinding, pair[0], pair[1]);
	return true;
};

const parseDetailCommunicationLine = (
	state: DetailCommunicationParseState,
	line: ParsedLine,
	text: string,
	pathValue: string,
	layout: DetailParseLayout
): void => {
	if (
		handleDetailTopLevel(state, line, layout) ||
		!state.inCommunication ||
		handleDetailSection(state, line, layout) ||
		!state.section ||
		handleDetailRouteStart(state, line, text, pathValue, layout) ||
		!state.currentRoute ||
		handleDetailRouteValue(state, line, layout) ||
		handleDetailListValue(state, line, layout) ||
		handleDetailAddressValue(state, line, layout) ||
		handleDetailNestedValue(state, line, layout) ||
		handleDetailBindingStart(state, line, layout) ||
		handleDetailBindingValue(state, line, layout)
	) {
		return;
	}
};

const parseDetailCommunicationItems = (
	text: string,
	pathValue: string,
	layout: DetailParseLayout
): ModuleCommunicationItem[] => {
	const state = createDetailParseState(layout.startsInCommunication);

	for (const [lineNumber, rawLine] of text.split(LINE_SPLIT_REGEX).entries()) {
		const line = parsedCommunicationLine(rawLine, lineNumber);
		if (line) {
			parseDetailCommunicationLine(state, line, text, pathValue, layout);
		}
	}

	completeDetailRoute(state);
	return state.items;
};

const parseConfigCommunicationItems = (
	text: string,
	pathValue: string
): ModuleCommunicationItem[] =>
	parseDetailCommunicationItems(text, pathValue, {
		source: "config",
		startsInCommunication: false,
		topLevelCommunication: true,
		sectionIndent: 2,
		routeIndent: 4,
		valueIndent: 6,
		nestedValueIndent: 8,
		bindingIndent: 8,
	});

const parsePublicInterfaceItems = (
	text: string,
	pathValue: string
): ModuleCommunicationItem[] =>
	parseDetailCommunicationItems(text, pathValue, {
		source: "idl",
		startsInCommunication: true,
		topLevelCommunication: false,
		sectionIndent: 0,
		routeIndent: 2,
		valueIndent: 4,
		nestedValueIndent: 6,
		bindingIndent: 6,
	});

const moduleNameFromConfigPath = (configPath: string): string => {
	const parts = configPath.split(path.sep);
	if (parts[0] === "module" && parts[1] === "service" && parts[2]) {
		return `module-${parts[2]}`;
	}
	if (parts[0] === "module" && parts[1]) {
		return `module-${parts[1]}`;
	}
	if (parts[0] === "infra" && parts[1]) {
		return `infra-${parts[1]}`;
	}
	return parts.slice(0, 2).join("-");
};

const readCommunicationRoutes = async (
	repoRoot: string
): Promise<CommunicationRoute[]> => {
	const configFiles = await walkForFiles(
		path.join(repoRoot, "module"),
		"config.yaml",
		5
	);
	const routes: CommunicationRoute[] = [];

	for (const configFile of configFiles) {
		const raw = await readFile(configFile, "utf8");
		if (
			!(raw.includes("\ncommunication:") || raw.startsWith("communication:"))
		) {
			continue;
		}
		const relativePath = path.relative(repoRoot, configFile);
		routes.push(
			...parseCommunicationRoutes(
				raw,
				relativePath,
				moduleNameFromConfigPath(relativePath)
			)
		);
	}

	return routes.sort((left, right) =>
		`${left.module}:${left.name}`.localeCompare(`${right.module}:${right.name}`)
	);
};

const parseProtoFormats = (
	text: string,
	pathValue: string
): ModuleDataFormatItem[] => {
	const items: ModuleDataFormatItem[] = [];
	let current: ModuleDataFormatItem | null = null;
	let braceDepth = 0;
	let currentDefinitionLines: string[] = [];

	for (const rawLine of text.split(LINE_SPLIT_REGEX)) {
		const trimmed = rawLine.trim();
		if (!(trimmed && !trimmed.startsWith("//"))) {
			if (current) {
				currentDefinitionLines.push(rawLine);
			}
			continue;
		}
		if (!current) {
			const started = startProtoFormat(trimmed, pathValue);
			current = started.current;
			braceDepth = started.braceDepth;
			currentDefinitionLines = current ? [rawLine] : [];
			continue;
		}
		currentDefinitionLines.push(rawLine);
		braceDepth = updateProtoMessage(trimmed, current, braceDepth);
		if (braceDepth <= 0) {
			current.definition = currentDefinitionLines.join("\n").trimEnd();
			items.push(current);
			current = null;
			currentDefinitionLines = [];
		}
	}
	if (current) {
		current.definition = currentDefinitionLines.join("\n").trimEnd();
		items.push(current);
	}
	return items;
};

const startProtoFormat = (
	line: string,
	pathValue: string
): { braceDepth: number; current: ModuleDataFormatItem | null } => {
	const messageMatch = line.match(PROTO_MESSAGE_REGEX);
	if (messageMatch?.[1]) {
		return {
			braceDepth: 1,
			current: {
				id: `${pathValue}:proto:${messageMatch[1]}`,
				name: messageMatch[1],
				kind: "proto",
				source: "message",
				path: pathValue,
				definition: line,
				fields: [],
			},
		};
	}
	return { braceDepth: 0, current: null };
};

const updateProtoMessage = (
	line: string,
	current: ModuleDataFormatItem,
	braceDepth: number
): number => {
	const fieldMatch = line.match(PROTO_FIELD_REGEX);
	if (fieldMatch) {
		current.fields.push({
			type: fieldMatch[1] ?? "",
			name: fieldMatch[2] ?? "",
			number: fieldMatch[3] ?? "",
		});
	}
	return (
		braceDepth +
		(line.match(OPEN_BRACE_REGEX) ?? []).length -
		(line.match(CLOSE_BRACE_REGEX) ?? []).length
	);
};

const parseDdsIdlFields = (text: string): DataFieldSummary[] =>
	text
		.split(LINE_SPLIT_REGEX)
		.map((line) => line.replace(DDS_LINE_COMMENT_REGEX, "").trim())
		.filter(Boolean)
		.filter((line) => !line.startsWith("struct "))
		.filter((line) => !line.startsWith("interface "))
		.filter((line) => !line.startsWith("module "))
		.filter((line) => !["{", "};", "}"].includes(line))
		.map((line) => line.replace(TRAILING_SEMICOLON_REGEX, ""))
		.map((line, index) => {
			const parts = line.split(WHITESPACE_REGEX);
			const name = parts.pop() ?? "";
			return {
				type: parts.join(" "),
				name,
				number: String(index + 1),
			};
		})
		.filter((field) => field.type && field.name);

const parseRosFields = (text: string): DataFieldSummary[] =>
	text
		.split(LINE_SPLIT_REGEX)
		.map((line) => line.replace(ROS_COMMENT_REGEX, "").trim())
		.filter(Boolean)
		.filter((line) => !line.startsWith("---"))
		.map((line, index) => {
			const [type = "", name = ""] = line.split(WHITESPACE_REGEX);
			return {
				type,
				name: name || line,
				number: String(index + 1),
			};
		});

const parseDataFormatFile = async (
	file: string,
	repoRoot: string
): Promise<ModuleDataFormatItem[]> => {
	const text = await readFile(file, "utf8");
	const relativePath = normalizePath(path.relative(repoRoot, file));
	if (file.endsWith(".proto")) {
		return parseProtoFormats(text, relativePath);
	}
	if (file.endsWith(".idl")) {
		const name = path.basename(file, ".idl");
		return [
			{
				id: `${relativePath}:dds_idl`,
				name,
				kind: "dds_idl",
				source: "OMG DDS IDL",
				path: relativePath,
				definition: text.trimEnd(),
				fields: parseDdsIdlFields(text),
			},
		];
	}
	const kind: DataFormatKind = file.endsWith(".srv") ? "srv" : "msg";
	return [
		{
			id: `${relativePath}:${kind}`,
			name: path.basename(file, `.${kind}`),
			kind,
			source: kind === "srv" ? "ros2 service" : "ros2 message",
			path: relativePath,
			definition: text.trimEnd(),
			fields: parseRosFields(text),
		},
	];
};

const readIdlCommunicationItems = async (
	repoRoot: string,
	serviceName: string
): Promise<ModuleCommunicationItem[]> => {
	const publicPath = path.join(
		repoRoot,
		IDL_ROOT,
		serviceName,
		"public",
		"interfaces.yaml"
	);
	if (!existsSync(publicPath)) {
		return [];
	}
	return parsePublicInterfaceItems(
		await readFile(publicPath, "utf8"),
		normalizePath(path.relative(repoRoot, publicPath))
	);
};

const readModuleDataFormats = async (
	repoRoot: string,
	serviceName: string
): Promise<ModuleDataFormatItem[]> => {
	const idlRoot = path.join(repoRoot, IDL_ROOT, serviceName);
	const files = await walkForExtensions(
		idlRoot,
		[".proto", ".msg", ".srv", ".idl"],
		5
	);
	return (
		await Promise.all(
			files
				.sort((left, right) => left.localeCompare(right))
				.map((file) => parseDataFormatFile(file, repoRoot))
		)
	).flat();
};

const readDataFormatCatalog = async (
	repoRoot: string
): Promise<ServiceDataFormatCatalog[]> => {
	const idlRoot = path.join(repoRoot, IDL_ROOT);
	if (!existsSync(idlRoot)) {
		return [];
	}
	const entries = await readdir(idlRoot, { withFileTypes: true });
	const services = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	const catalog = await Promise.all(
		services.map(async (service) => ({
			service,
			formats: await readModuleDataFormats(repoRoot, service),
		}))
	);
	return catalog.filter((item) => item.formats.length > 0);
};

const readPublicInterfaceCatalog = async (
	repoRoot: string
): Promise<ServicePublicInterfaceCatalog[]> => {
	const idlRoot = path.join(repoRoot, IDL_ROOT);
	if (!existsSync(idlRoot)) {
		return [];
	}
	const entries = await readdir(idlRoot, { withFileTypes: true });
	const services = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	const catalog = await Promise.all(
		services.map(async (service) => ({
			service,
			interfaces: await readIdlCommunicationItems(repoRoot, service),
		}))
	);
	return catalog.filter((item) => item.interfaces.length > 0);
};

const isProviderCommunicationItem = (
	item: ModuleCommunicationItem
): boolean => {
	const direction = (item.direction || item.role).toLowerCase();
	if (!direction) {
		return true;
	}
	if (item.kind === "service") {
		return !["client", "consumer"].includes(direction);
	}
	return !["subscribe", "subscriber", "in", "consumer"].includes(direction);
};

const configItemDuplicatesPublicProvider = (
	item: ModuleCommunicationItem,
	serviceName: string,
	publicProviderKeys: Set<string>
): boolean => {
	if (item.source !== "config" || !isProviderCommunicationItem(item)) {
		return false;
	}
	const directKey = `${item.kind}:${item.name}`;
	const refKey = `${item.kind}:${item.messageType.replace(
		`${serviceName}.`,
		""
	)}`;
	return publicProviderKeys.has(directKey) || publicProviderKeys.has(refKey);
};

const mergeModuleCommunicationItems = (
	serviceName: string,
	configItems: ModuleCommunicationItem[],
	idlItems: ModuleCommunicationItem[]
): ModuleCommunicationItem[] => {
	const publicProviderKeys = new Set(
		idlItems
			.filter(isProviderCommunicationItem)
			.map((item) => `${item.kind}:${item.name}`)
	);
	return [
		...configItems.filter(
			(item) =>
				!configItemDuplicatesPublicProvider(
					item,
					serviceName,
					publicProviderKeys
				)
		),
		...idlItems,
	];
};

const readModuleDetail = async (
	input: z.infer<typeof moduleDetailInput>
): Promise<ModuleDetail> => {
	const repoRoot = findRepoRoot();
	const projects = await readProjectSummaries(repoRoot);
	const module =
		projects.find((project) => project.name === input.moduleName) ??
		projects.find(
			(project) => path.basename(project.root) === input.moduleName
		);
	if (!module) {
		throw new Error(`Unknown module "${input.moduleName}".`);
	}
	const serviceName = path.basename(module.root);
	const configPath = findModuleConfigPath(repoRoot, module.root);
	const configItems = configPath
		? parseConfigCommunicationItems(
				await readFile(configPath, "utf8"),
				normalizePath(path.relative(repoRoot, configPath))
			)
		: [];
	const [idlItems, dataFormats, dataFormatCatalog, publicInterfaceCatalog] =
		await Promise.all([
			readIdlCommunicationItems(repoRoot, serviceName),
			readModuleDataFormats(repoRoot, serviceName),
			readDataFormatCatalog(repoRoot),
			readPublicInterfaceCatalog(repoRoot),
		]);

	return {
		module,
		configPath: configPath
			? normalizePath(path.relative(repoRoot, configPath))
			: null,
		idlRoot: normalizePath(path.join(IDL_ROOT, serviceName)),
		communication: mergeModuleCommunicationItems(
			serviceName,
			configItems,
			idlItems
		),
		dataFormatCatalog,
		dataFormats,
		publicInterfaceCatalog,
	};
};

const readJsonRecord = async (file: string): Promise<Record<string, unknown>> =>
	asRecord(JSON.parse(await readFile(file, "utf8")));

const robotCapabilitySignalFromValue = (
	value: unknown
): RobotCapabilitySignal => {
	const record = asRecord(value);
	return {
		name: asString(record.name),
		unit: asString(record.unit),
	};
};

const robotCapabilityContractFromValue = (
	value: unknown
): RobotCapabilityContract => {
	const record = asRecord(value);
	return {
		service: asString(record.service),
		route: asString(record.route),
		path: asString(record.path),
		status: asString(record.status),
	};
};

const robotCapabilityFromValue = (value: unknown): RobotCapability => {
	const record = asRecord(value);
	return {
		id: asString(record.id),
		family: asString(record.family),
		summary: asString(record.summary),
		contractStatus: asString(record.contractStatus),
		recommendedIdlService: asString(record.recommendedIdlService),
		signals: asUnknownArray(record.signals)
			.map(robotCapabilitySignalFromValue)
			.filter((signal) => signal.name),
		contracts: asUnknownArray(record.contracts)
			.map(robotCapabilityContractFromValue)
			.filter((contract) => contract.path || contract.service),
	};
};

const robotProfileServiceFromValue = (
	value: unknown,
	defaultRequired: boolean
): RobotProfileService => {
	const record = asRecord(value);
	return {
		service: asString(record.service),
		package: asString(record.package),
		role: asString(record.role),
		required: asBoolean(record.required, defaultRequired),
		capabilities: asStringArray(record.capabilities),
		notes: asString(record.notes),
	};
};

const robotProfileDeployFromValue = (value: unknown): RobotProfileDeploy => {
	const record = asRecord(value);
	return {
		rosDistro: asString(record.rosDistro),
		defaultDomainId: asFiniteNumber(record.defaultDomainId),
		transportFamilies: asStringArray(record.transportFamilies),
		targets: asStringArray(record.targets),
		verification: asStringArray(record.verification),
	};
};

const robotProfileAiNativeFromValue = (
	value: unknown
): RobotProfileAiNative => {
	const record = asRecord(value);
	return {
		skill: asString(record.skill),
		agentEntry: asString(record.agentEntry),
		modulePolicy: asString(record.modulePolicy),
	};
};

const robotProfileFromValue = (value: unknown): RobotProfile => {
	const record = asRecord(value);
	return {
		id: asString(record.id),
		displayName: asString(record.displayName),
		status: asString(record.status),
		robotClass: asString(record.robotClass),
		summary: asString(record.summary),
		capabilities: asStringArray(record.capabilities),
		services: asUnknownArray(record.services)
			.map((service) => robotProfileServiceFromValue(service, true))
			.filter((service) => service.service),
		plannedServices: asUnknownArray(record.plannedServices)
			.map((service) => robotProfileServiceFromValue(service, false))
			.filter((service) => service.service),
		deploy: robotProfileDeployFromValue(record.deploy),
		aiNative: robotProfileAiNativeFromValue(record.aiNative),
	};
};

const readRobotProfiles = async (): Promise<RobotProfileCatalog> => {
	const repoRoot = findRepoRoot();
	const capabilityFile = path.join(repoRoot, ROBOT_CAPABILITY_PATH);
	const profileRoot = path.join(repoRoot, ROBOT_PROFILE_ROOT);
	const capabilityRecord = await readJsonRecord(capabilityFile);
	const capabilities = asUnknownArray(capabilityRecord.capabilities)
		.map(robotCapabilityFromValue)
		.filter((capability) => capability.id)
		.sort((left, right) => left.id.localeCompare(right.id));
	const entries = existsSync(profileRoot)
		? await readdir(profileRoot, { withFileTypes: true })
		: [];
	const profiles = (
		await Promise.all(
			entries
				.filter(
					(entry) =>
						entry.isFile() &&
						entry.name.endsWith(".json") &&
						entry.name !== "project.json"
				)
				.map((entry) =>
					readJsonRecord(path.join(profileRoot, entry.name)).then(
						robotProfileFromValue
					)
				)
		)
	)
		.filter((profile) => profile.id)
		.sort((left, right) => left.id.localeCompare(right.id));

	return {
		generatedAt: new Date().toISOString(),
		capabilityPath: normalizePath(path.relative(repoRoot, capabilityFile)),
		profileRoot: normalizePath(path.relative(repoRoot, profileRoot)),
		capabilities,
		profiles,
		activeProfiles: profiles.filter((profile) => profile.status === "active")
			.length,
		templateProfiles: profiles.filter(
			(profile) => profile.status === "template"
		).length,
	};
};

const readModuleProject = async (
	repoRoot: string,
	moduleName: string
): Promise<ModuleSummary> => {
	const projects = await readProjectSummaries(repoRoot);
	const module =
		projects.find((project) => project.name === moduleName) ??
		projects.find((project) => path.basename(project.root) === moduleName);
	if (!module) {
		throw new Error(`Unknown module "${moduleName}".`);
	}
	return module;
};

const writeCommunicationItem = async (
	input: z.infer<typeof communicationItemInput>
) => {
	const repoRoot = findRepoRoot();
	const filePath = absoluteRepoPath(repoRoot, input.path, [
		MODULE_SERVICE_ROOT,
		IDL_ROOT,
	]);
	const text = await readFile(filePath, "utf8");
	const section = input.kind === "service" ? "services" : "topics";
	const nextText =
		input.source === "config"
			? replaceYamlRouteBlock(
					text,
					section,
					input.name,
					input.definition ?? null
				)
			: replaceTopLevelYamlBlock(
					text,
					section,
					input.name,
					input.definition ?? null
				);
	await writeFile(filePath, nextText, "utf8");
	cachedSnapshot = undefined;
	return readModuleDetail({ moduleName: input.moduleName });
};

const writeDataFormatItem = async (
	input: z.infer<typeof dataFormatItemInput>
) => {
	const repoRoot = findRepoRoot();
	const module = await readModuleProject(repoRoot, input.moduleName);
	const serviceName = path.basename(module.root);
	const filePath = absoluteRepoPath(repoRoot, input.path, [IDL_ROOT]);
	if (input.kind === "proto") {
		const text = await readFile(filePath, "utf8");
		await writeFile(
			filePath,
			replaceProtoMessageBlock(text, input.name, input.definition ?? null),
			"utf8"
		);
	} else if (input.definition) {
		await writeFile(filePath, `${input.definition.trimEnd()}\n`, "utf8");
	} else {
		await rm(filePath);
	}
	if (input.kind === "msg" || input.kind === "srv") {
		await writeRos2PackageMetadata(repoRoot, serviceName);
	}
	cachedSnapshot = undefined;
	return readModuleDetail({ moduleName: input.moduleName });
};

const dataFormatFilePath = ({
	kind,
	name,
	repoRoot,
	serviceName,
}: {
	kind: DataFormatKind;
	name: string;
	repoRoot: string;
	serviceName: string;
}): string => {
	if (kind === "proto") {
		return path.join(
			repoRoot,
			IDL_ROOT,
			serviceName,
			"pb",
			`${serviceName}.proto`
		);
	}
	if (kind === "dds_idl") {
		return path.join(
			repoRoot,
			IDL_ROOT,
			serviceName,
			"dds",
			serviceName,
			`${name}.idl`
		);
	}
	return path.join(
		repoRoot,
		IDL_ROOT,
		serviceName,
		"ros2",
		serviceName,
		kind,
		`${name}.${kind}`
	);
};

const createDataFormatItem = async (
	input: z.infer<typeof createDataFormatInput>
) => {
	const repoRoot = findRepoRoot();
	const module = await readModuleProject(repoRoot, input.moduleName);
	const serviceName = path.basename(module.root);
	const name = validateDataFormatName(input.name);
	if (input.kind !== "srv" && input.fields.length === 0) {
		throw new Error(`${input.kind} requires at least one field.`);
	}
	const definition = renderDataFormatDefinition(input);
	const filePath = dataFormatFilePath({
		kind: input.kind,
		name,
		repoRoot,
		serviceName,
	});
	await mkdir(path.dirname(filePath), { recursive: true });
	if (input.kind === "proto") {
		const text = existsSync(filePath)
			? await readFile(filePath, "utf8")
			: [
					'syntax = "proto3";',
					"",
					`package pacific_rim.${serviceName}.protocols.pb;`,
					"",
				].join("\n");
		await writeFile(
			filePath,
			appendProtoMessageBlock(text, name, definition),
			"utf8"
		);
	} else {
		if (existsSync(filePath)) {
			throw new Error(`${input.kind} "${name}" already exists.`);
		}
		await writeFile(filePath, `${definition.trimEnd()}\n`, "utf8");
		if (input.kind === "msg" || input.kind === "srv") {
			await writeRos2PackageMetadata(repoRoot, serviceName);
		}
	}
	cachedSnapshot = undefined;
	return readModuleDetail({ moduleName: input.moduleName });
};

const createConsumerCommunicationItem = async (
	input: z.infer<typeof createConsumerCommunicationInput>
) => {
	const repoRoot = findRepoRoot();
	const projects = await readProjectSummaries(repoRoot);
	const module =
		projects.find((project) => project.name === input.moduleName) ??
		projects.find(
			(project) => path.basename(project.root) === input.moduleName
		);
	if (!module) {
		throw new Error(`Unknown module "${input.moduleName}".`);
	}
	const serviceName = path.basename(module.root);
	if (input.providerService === serviceName) {
		throw new Error("Consumer route must reference another service.");
	}

	const publicCatalog = await readPublicInterfaceCatalog(repoRoot);
	const provider = publicCatalog.find(
		(item) => item.service === input.providerService
	);
	const publicRoute = provider?.interfaces.find(
		(item) => item.kind === input.kind && item.name === input.routeName
	);
	if (!(provider && publicRoute)) {
		throw new Error(
			`Unknown public ${input.kind} "${routeReference(input.providerService, input.routeName)}".`
		);
	}

	const configPath =
		findModuleConfigPath(repoRoot, module.root) ??
		path.join(repoRoot, module.root, "config", "config.yaml");
	const existingText = existsSync(configPath)
		? await readFile(configPath, "utf8")
		: "";
	const section = input.kind === "service" ? "services" : "topics";
	const refKey = input.kind === "service" ? "service_ref" : "topic_ref";
	const direction = input.kind === "service" ? "client" : "subscribe";
	const middlewares = publicRoute.transportFamilies.length
		? publicRoute.transportFamilies
		: publicRoute.transports;
	const routeBlock = [
		`    ${input.routeName}:`,
		`      ${refKey}: ${routeReference(input.providerService, input.routeName)}`,
		`      direction: ${direction}`,
		middlewares.length ? "      middlewares:" : "",
		...middlewares.map((middleware) => `        - ${middleware}`),
	].join("\n");
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(
		configPath,
		appendYamlRouteBlock(existingText, section, input.routeName, routeBlock),
		"utf8"
	);
	cachedSnapshot = undefined;
	return readModuleDetail({ moduleName: input.moduleName });
};

const validateProviderCommunicationInput = (
	input: z.infer<typeof createProviderCommunicationInput>,
	serviceName: string
) => {
	if (input.dataService === "common") {
		throw new Error(
			"common is reserved for infra and cannot own module routes."
		);
	}
	if (input.dataService !== serviceName) {
		throw new Error(
			"Provider routes must use data formats owned by this service."
		);
	}
	if (input.kind === "service" && input.format === "msg") {
		throw new Error(
			"Service routes must use srv, proto, or dds_idl data formats."
		);
	}
	if (input.kind === "topic" && input.format === "srv") {
		throw new Error(
			"Topic routes must use msg, proto, or dds_idl data formats."
		);
	}
	if (
		input.format === "dds_idl" &&
		!["cyclonedds", "fastdds"].includes(input.communication)
	) {
		throw new Error(
			"DDS IDL routes must use cyclonedds or fastdds middleware."
		);
	}
};

const providerRouteAddressLine = (
	communication: z.infer<
		typeof createProviderCommunicationInput
	>["communication"],
	kind: RouteKind,
	serviceName: string,
	routeName: string
): string => {
	const address = routeReference(serviceName, routeName);
	if (communication === "nats") {
		return `      nats: robot.${kind === "service" ? "rpc" : "topic"}.${address}`;
	}
	if (communication === "ros2") {
		return `      ros2: ${ros2RouteAddress(serviceName, routeName)}`;
	}
	if (communication === "fastdds") {
		return `      fastdds: ${address}`;
	}
	return `      cyclonedds: ${address}`;
};

const providerPublicRouteBlock = ({
	input,
	inputFormat,
	outputFormat,
	routeName,
	serviceName,
}: {
	input: z.infer<typeof createProviderCommunicationInput>;
	inputFormat: ModuleDataFormatItem;
	outputFormat: ModuleDataFormatItem | undefined;
	routeName: string;
	serviceName: string;
}): string => {
	const role = input.kind === "service" ? "server" : "publisher";
	const responseType =
		input.kind === "service" && input.format === "proto" && outputFormat
			? publicTypeFromDataFormat(outputFormat, input.dataService)
			: "";
	return [
		`  ${routeName}:`,
		`    role: ${role}`,
		`    direction: ${role === "server" ? "server" : "publish"}`,
		`    data: ${input.format}`,
		`    type: ${publicTypeFromDataFormat(inputFormat, input.dataService)}`,
		responseType ? `    response_type: ${responseType}` : "",
		"    addresses:",
		providerRouteAddressLine(
			input.communication,
			input.kind,
			serviceName,
			routeName
		),
	]
		.filter(Boolean)
		.join("\n");
};

const createProviderCommunicationItem = async (
	input: z.infer<typeof createProviderCommunicationInput>
) => {
	const repoRoot = findRepoRoot();
	const module = await readModuleProject(repoRoot, input.moduleName);
	const serviceName = path.basename(module.root);
	const routeName = validateRouteName(input.name);
	validateProviderCommunicationInput(input, serviceName);

	const catalog = await readDataFormatCatalog(repoRoot);
	const serviceFormats = catalog.find(
		(item) => item.service === input.dataService
	);
	const inputFormat = serviceFormats?.formats.find(
		(item) => item.kind === input.format && item.name === input.inputName
	);
	const outputFormat = serviceFormats?.formats.find(
		(item) => item.kind === input.format && item.name === input.outputName
	);
	if (!inputFormat) {
		throw new Error(
			`Unknown ${input.format} data format "${input.dataService}.${input.inputName}".`
		);
	}
	if (input.kind === "service" && input.format === "proto" && !outputFormat) {
		throw new Error(
			"Proto service routes require both input and output types."
		);
	}

	const section = input.kind === "service" ? "services" : "topics";

	const publicPath = path.join(
		repoRoot,
		IDL_ROOT,
		serviceName,
		"public",
		"interfaces.yaml"
	);
	await mkdir(path.dirname(publicPath), { recursive: true });
	const publicText = existsSync(publicPath)
		? await readFile(publicPath, "utf8")
		: "";
	const nextPublicText = appendTopLevelYamlRouteBlock(
		publicText,
		section,
		routeName,
		providerPublicRouteBlock({
			input,
			inputFormat,
			outputFormat,
			routeName,
			serviceName,
		})
	);

	await writeFile(publicPath, nextPublicText, "utf8");
	cachedSnapshot = undefined;
	return readModuleDetail({ moduleName: input.moduleName });
};

const buildModule = async (input: z.infer<typeof moduleDetailInput>) => {
	const repoRoot = findRepoRoot();
	const projects = await readProjectSummaries(repoRoot);
	const module =
		projects.find((project) => project.name === input.moduleName) ??
		projects.find(
			(project) => path.basename(project.root) === input.moduleName
		);
	if (!module) {
		throw new Error(`Unknown module "${input.moduleName}".`);
	}
	const args = ["bin/generate-interface-scaffold.mjs", module.root];
	const { stderr, stdout } = await execFileAsync("node", args, {
		cwd: repoRoot,
		env: process.env,
		maxBuffer: 1024 * 1024 * 20,
	});
	cachedSnapshot = undefined;
	return {
		command: `node ${args.join(" ")}`,
		stderr,
		stdout,
	};
};

const checkEndpoint = async (
	endpoint: ObservabilityEndpoint
): Promise<EndpointStatus> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 900);
	try {
		const response = await fetch(endpoint.url, {
			signal: controller.signal,
		});
		return {
			...endpoint,
			status: response.ok ? "online" : "degraded",
			statusCode: response.status,
		};
	} catch {
		return {
			...endpoint,
			status: "offline",
			statusCode: null,
		};
	} finally {
		clearTimeout(timeout);
	}
};

const summarizeTransports = (
	routes: CommunicationRoute[]
): TransportSummary[] => {
	const transportMap = new Map<string, TransportCounter>();
	for (const family of SUPPORTED_TRANSPORT_FAMILIES) {
		transportMap.set(family, {
			routeIds: new Set<string>(),
			bindings: 0,
		});
	}
	for (const route of routes) {
		for (const binding of route.bindings) {
			const name = transportFamily(binding.transport) ?? binding.transport;
			const current = transportMap.get(name) ?? {
				routeIds: new Set<string>(),
				bindings: 0,
			};
			current.bindings += 1;
			current.routeIds.add(route.id);
			transportMap.set(name, current);
		}
	}
	return [...transportMap.entries()]
		.map(([name, value]) => ({
			name,
			bindings: value.bindings,
			routes: value.routeIds.size,
		}))
		.sort((left, right) => {
			if (right.bindings !== left.bindings) {
				return right.bindings - left.bindings;
			}
			return transportSortIndex(left.name) - transportSortIndex(right.name);
		});
};

const transportSortIndex = (name: string): number => {
	const index = SUPPORTED_TRANSPORT_FAMILIES.indexOf(name as TransportFamily);
	return index >= 0 ? index : SUPPORTED_TRANSPORT_FAMILIES.length;
};

const createSnapshotData = async () => {
	const repoRoot = findRepoRoot();
	const [projects, routes, endpointStatuses] = await Promise.all([
		readProjectSummaries(repoRoot),
		readCommunicationRoutes(repoRoot),
		Promise.all(OBSERVABILITY_ENDPOINTS.map(checkEndpoint)),
	]);

	const runtimeModules = projects.filter((project) => project.runtime);
	const criticalModules = projects.filter((project) => project.critical);
	const serviceRoutes = routes.filter((route) => route.kind === "service");
	const topicRoutes = routes.filter((route) => route.kind === "topic");
	const offlineEndpoints = endpointStatuses.filter(
		(endpoint) => endpoint.status !== "online"
	);

	return {
		generatedAt: new Date().toISOString(),
		repoRoot,
		overview: {
			projectCount: projects.length,
			runtimeModuleCount: runtimeModules.length,
			criticalModuleCount: criticalModules.length,
			routeCount: routes.length,
			serviceRouteCount: serviceRoutes.length,
			topicRouteCount: topicRoutes.length,
			bindingCount: routes.reduce(
				(total, route) => total + route.bindings.length,
				0
			),
			onlineObservabilityCount: endpointStatuses.filter(
				(endpoint) => endpoint.status === "online"
			).length,
			issueCount: offlineEndpoints.length,
			issues: offlineEndpoints.map((endpoint) => ({
				severity: endpoint.status === "offline" ? "warning" : "info",
				title: `${endpoint.label} is ${endpoint.status}`,
				detail: endpoint.statusCode
					? `HTTP ${endpoint.statusCode}`
					: "No local readiness response",
				source: endpoint.href,
			})),
			quickLinks: OBSERVABILITY_ENDPOINTS.map(({ id, label, href }) => ({
				id,
				label,
				href,
			})),
		},
		observability: endpointStatuses,
		modules: projects,
		communication: {
			routes,
			transports: summarizeTransports(routes),
			metricsState:
				endpointStatuses.find((endpoint) => endpoint.id === "prometheus")
					?.status === "online"
					? "prometheus-online"
					: "static-snapshot",
		},
	};
};

const createSnapshot = async () => {
	const now = Date.now();
	if (
		cachedSnapshot &&
		now - cachedSnapshot.createdAt < SNAPSHOT_CACHE_TTL_MS
	) {
		return cachedSnapshot.value;
	}
	const value = await createSnapshotData();
	cachedSnapshot = {
		createdAt: now,
		value,
	};
	return value;
};

export type DashboardSnapshot = Awaited<ReturnType<typeof createSnapshotData>>;

export const dashboardRouter = router({
	buildModule: publicProcedure
		.input(moduleDetailInput)
		.mutation(({ input }) => buildModule(input)),
	createModule: publicProcedure
		.input(createModuleInput)
		.mutation(({ input }) => createModuleFromInput(input)),
	createConsumerCommunicationItem: publicProcedure
		.input(createConsumerCommunicationInput)
		.mutation(({ input }) => createConsumerCommunicationItem(input)),
	createProviderCommunicationItem: publicProcedure
		.input(createProviderCommunicationInput)
		.mutation(({ input }) => createProviderCommunicationItem(input)),
	createDataFormatItem: publicProcedure
		.input(createDataFormatInput)
		.mutation(({ input }) => createDataFormatItem(input)),
	deleteCommunicationItem: publicProcedure
		.input(communicationItemInput)
		.mutation(({ input }) => writeCommunicationItem(input)),
	deleteDataFormatItem: publicProcedure
		.input(dataFormatItemInput)
		.mutation(({ input }) => writeDataFormatItem(input)),
	editCommunicationItem: publicProcedure
		.input(communicationItemInput.required({ definition: true }))
		.mutation(({ input }) => writeCommunicationItem(input)),
	editDataFormatItem: publicProcedure
		.input(dataFormatItemInput.required({ definition: true }))
		.mutation(({ input }) => writeDataFormatItem(input)),
	moduleDetail: publicProcedure
		.input(moduleDetailInput)
		.query(({ input }) => readModuleDetail(input)),
	robotProfiles: publicProcedure.query(readRobotProfiles),
	snapshot: publicProcedure.query(createSnapshot),
});
