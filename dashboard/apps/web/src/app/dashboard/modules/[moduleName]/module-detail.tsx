"use client";

import type { ModuleDetail as ModuleDetailData } from "@dashboard/api/routers/dashboard";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@dashboard/ui/components/alert";
import { Badge } from "@dashboard/ui/components/badge";
import { Button } from "@dashboard/ui/components/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@dashboard/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@dashboard/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@dashboard/ui/components/empty";
import {
	Field,
	FieldDescription,
	FieldLabel,
} from "@dashboard/ui/components/field";
import { Input } from "@dashboard/ui/components/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@dashboard/ui/components/select";
import { Skeleton } from "@dashboard/ui/components/skeleton";
import { Spinner } from "@dashboard/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@dashboard/ui/components/table";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@dashboard/ui/components/tabs";
import { Textarea } from "@dashboard/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, Database, Network, Plus } from "lucide-react";
import type { Route as NextRoute } from "next";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageContainer } from "@/components/layout/page-container";
import { trpc } from "@/utils/trpc";

type CommunicationItem = ModuleDetailData["communication"][number];
type DataFormatItem = ModuleDetailData["dataFormats"][number];
type DetailTab = "communication" | "data";
type DirectionFilter = "all" | "subscribe-client" | "publish-server";
type KindFilter = "all" | "service" | "topic";
type TransportFilter = "all" | "ros2" | "nats" | "cyclonedds" | "fastdds";
type DataKindFilter = "all" | "proto" | "msg" | "srv" | "dds_idl";
type DataFormatCatalog = ModuleDetailData["dataFormatCatalog"];
type DataFormatCatalogService = DataFormatCatalog[number];
type DataFormatCatalogItem = DataFormatCatalogService["formats"][number];
type PublicInterfaceCatalog = ModuleDetailData["publicInterfaceCatalog"];
type PublicInterfaceCatalogService = PublicInterfaceCatalog[number];
type CommunicationKind = "service" | "topic";
type CommunicationMode = "provide" | "use";
type CommunicationProtocol = "cyclonedds" | "fastdds" | "nats" | "ros2";
type InterfaceDataFormatKind = Exclude<DataKindFilter, "all">;
interface ConsumerCommunicationInput {
	kind: CommunicationKind;
	providerService: string;
	routeName: string;
}
interface ProviderCommunicationInput {
	communication: CommunicationProtocol;
	dataService: string;
	format: InterfaceDataFormatKind;
	inputName: string;
	kind: CommunicationKind;
	name: string;
	outputName?: string;
}
interface DataFormatFieldDraft {
	id: string;
	name: string;
	type: string;
}
interface DataFormatFormValue {
	fields: DataFormatFieldDraft[];
	kind: InterfaceDataFormatKind;
	name: string;
	responseFields: DataFormatFieldDraft[];
}
interface ParsedDataFormatDraft {
	errors: string[];
	fields: DataFormatFieldDraft[];
	name?: string;
	responseFields: DataFormatFieldDraft[];
}
interface CreateDataFormatInput {
	fields: Array<{ name: string; type: string }>;
	kind: InterfaceDataFormatKind;
	name: string;
	responseFields?: Array<{ name: string; type: string }>;
}
type CommunicationChangeAction = "created" | "deleted";

const TRANSPORT_ALIASES: Record<Exclude<TransportFilter, "all">, string[]> = {
	ros2: ["ros2"],
	nats: ["nats"],
	fastdds: ["fastdds", "fastrtps"],
	cyclonedds: ["cyclonedds", "dds"],
};

const COMMENT_REGEX = /#.*/;
const INTERFACE_DATA_FORMATS: Record<
	CommunicationKind,
	InterfaceDataFormatKind[]
> = {
	service: ["proto", "srv", "dds_idl"],
	topic: ["proto", "msg", "dds_idl"],
};
const PROTO_SCALAR_FIELD_TYPES = [
	"double",
	"float",
	"int32",
	"int64",
	"uint32",
	"uint64",
	"sint32",
	"sint64",
	"fixed32",
	"fixed64",
	"sfixed32",
	"sfixed64",
	"bool",
	"string",
	"bytes",
];
const ROS2_SCALAR_FIELD_TYPES = [
	"bool",
	"byte",
	"char",
	"float32",
	"float64",
	"int8",
	"uint8",
	"int16",
	"uint16",
	"int32",
	"uint32",
	"int64",
	"uint64",
	"string",
	"wstring",
	"builtin_interfaces/Time",
	"builtin_interfaces/Duration",
];
const ROS2_NATIVE_MESSAGE_FIELD_TYPES = [
	"std_msgs/Header",
	"std_msgs/String",
	"std_msgs/Bool",
	"std_msgs/Int32",
	"std_msgs/Float32",
	"std_msgs/Float64",
	"std_msgs/UInt8MultiArray",
	"std_msgs/Float32MultiArray",
	"std_msgs/Float64MultiArray",
	"geometry_msgs/Point",
	"geometry_msgs/Vector3",
	"geometry_msgs/Quaternion",
	"geometry_msgs/Pose",
	"geometry_msgs/Twist",
	"geometry_msgs/Transform",
	"sensor_msgs/JointState",
	"sensor_msgs/Image",
	"sensor_msgs/Imu",
	"nav_msgs/Odometry",
];
const ROS2_STANDARD_SERVICE_TEMPLATES = [
	{
		label: "自定义 srv",
		name: "",
		requestFields: [],
		responseFields: [],
		value: "custom",
	},
	{
		label: "std_srvs/srv/Empty",
		name: "Empty",
		requestFields: [],
		responseFields: [],
		value: "std_srvs/srv/Empty",
	},
	{
		label: "std_srvs/srv/Trigger",
		name: "Trigger",
		requestFields: [],
		responseFields: [
			{ name: "success", type: "bool" },
			{ name: "message", type: "string" },
		],
		value: "std_srvs/srv/Trigger",
	},
	{
		label: "std_srvs/srv/SetBool",
		name: "SetBool",
		requestFields: [{ name: "data", type: "bool" }],
		responseFields: [
			{ name: "success", type: "bool" },
			{ name: "message", type: "string" },
		],
		value: "std_srvs/srv/SetBool",
	},
] as const;
const LINE_SPLIT_REGEX = /\r?\n/;
const PROTO_FIELD_LINE_REGEX =
	/^(?:(?:optional|required)\s+)?((?:repeated\s+)?(?:map\s*<[^>]+>|[A-Za-z_][A-Za-z0-9_.<>]*))\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+\s*;/;
const ROS2_SERVICE_TYPE_REFERENCE_REGEX = /(^|\/)srv\//;
const WHITESPACE_REGEX = /\s+/;
const FIELD_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DDS_LINE_COMMENT_REGEX = /\/\/.*/;
const TRAILING_SEMICOLON_REGEX = /;$/;

const hasAnyDirectionToken = (value: string, tokens: string[]): boolean =>
	tokens.some((token) => value.includes(token));

const directionText = (item: CommunicationItem): string =>
	[
		item.direction,
		item.role,
		...item.bindings.map((binding) => binding.direction),
	]
		.join(" ")
		.toLowerCase();

const directionMatches = (item: CommunicationItem, filter: DirectionFilter) => {
	if (filter === "all") {
		return true;
	}
	const normalized = directionText(item);
	if (filter === "subscribe-client") {
		if (item.kind === "topic") {
			return hasAnyDirectionToken(normalized, [
				"subscribe",
				"subscriber",
				"sub",
			]);
		}
		return hasAnyDirectionToken(normalized, ["client"]);
	}
	if (item.kind === "topic") {
		return hasAnyDirectionToken(normalized, ["publish", "publisher", "pub"]);
	}
	return hasAnyDirectionToken(normalized, ["server"]);
};

const transportMatches = (
	item: CommunicationItem,
	filter: TransportFilter
): boolean => {
	if (filter === "all" || item.transportFamilies.includes(filter)) {
		return true;
	}
	const normalized = [
		...item.transports,
		...item.bindings.flatMap((binding) => [
			binding.transport,
			binding.middleware,
			binding.standard,
		]),
	]
		.join(" ")
		.toLowerCase();
	return TRANSPORT_ALIASES[filter].some((alias) => normalized.includes(alias));
};

const containsText = (values: string[], query: string): boolean => {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return true;
	}
	return values.some((value) => value.toLowerCase().includes(normalized));
};

const buildReminderMessage = (moduleName: string): string =>
	`接口/消息已变更，需要重新 Build ${moduleName} 以刷新生成接口。`;

const communicationChangeLabel = (action: CommunicationChangeAction): string =>
	({ created: "新增", deleted: "删除" })[action];

const communicationModeLabel = (mode: "provide" | "use") =>
	mode === "provide" ? "对外提供接口、消息" : "调用或接收外部接口、消息";

const interfacePayloadLabel = (
	isService: boolean,
	isSingleServicePayload: boolean
) => {
	if (isSingleServicePayload) {
		return "输入/输出类型";
	}
	return isService ? "输入类型" : "消息类型";
};

const dataPreviewTitle = (
	isService: boolean,
	isSingleServicePayload: boolean
) => {
	if (isSingleServicePayload) {
		return "输入/输出预览";
	}
	return isService ? "输入预览" : "消息预览";
};

const dataSelectorGridClass = (
	isService: boolean,
	isSingleServicePayload: boolean
) => {
	if (!isService || isSingleServicePayload) {
		return "grid gap-3 sm:grid-cols-3";
	}
	return "grid gap-3 sm:grid-cols-2";
};

const emptyPayloadSelectorClass = (
	isService: boolean,
	isSingleServicePayload: boolean
) => {
	if (!isService || isSingleServicePayload) {
		return "min-h-32 border sm:col-span-3";
	}
	return "min-h-32 border sm:col-span-2";
};

const nameEndsWithToken = (name: string, token: string) =>
	name.toLowerCase().endsWith(token);

const isModulePrivateService = (serviceName: string) =>
	serviceName.toLowerCase() !== "common";

const isSelectableExternalService = (
	serviceName: string,
	currentServiceName: string
) => isModulePrivateService(serviceName) && serviceName !== currentServiceName;

const serviceNameFromModuleRoot = (root: string) =>
	root.split("/").at(-1) ?? "";

const protoServicePayloadOptions = (
	options: DataFormatCatalogItem[],
	token: "request" | "response"
) => {
	const filtered = options.filter((format) =>
		nameEndsWithToken(format.name, token)
	);
	return filtered.length > 0 ? filtered : options;
};

const selectedPublicProvider = (
	catalog: PublicInterfaceCatalog,
	currentServiceName: string,
	providerService: string,
	kind: CommunicationKind
) =>
	catalog.find(
		(provider) =>
			provider.service === providerService &&
			isSelectableExternalService(provider.service, currentServiceName) &&
			provider.interfaces.some((item) => item.kind === kind)
	) ??
	catalog.find(
		(provider) =>
			isSelectableExternalService(provider.service, currentServiceName) &&
			provider.interfaces.some((item) => item.kind === kind)
	);

const selectedPublicRoute = (
	provider: PublicInterfaceCatalogService | undefined,
	routeName: string,
	kind: CommunicationKind
) =>
	provider?.interfaces.find(
		(item) => item.kind === kind && item.name === routeName
	) ?? provider?.interfaces.find((item) => item.kind === kind);

const addDialogCreateDisabled = (
	activeTab: DetailTab,
	consumerMode: boolean,
	isPending: boolean,
	name: string,
	selectedInputFormat: DataFormatCatalogItem | undefined,
	selectedProvider: PublicInterfaceCatalogService | undefined,
	selectedConsumerRoute: CommunicationItem | undefined
) =>
	isPending ||
	(activeTab === "communication" &&
		(consumerMode
			? !(selectedProvider && selectedConsumerRoute)
			: !(name.trim() && selectedInputFormat)));

const newFieldDraft = (): DataFormatFieldDraft => ({
	id: crypto.randomUUID(),
	name: "",
	type: "string",
});

const dataFormatFieldPayload = (fields: DataFormatFieldDraft[]) =>
	fields
		.map((field) => ({
			name: field.name.trim(),
			type: field.type.trim(),
		}))
		.filter((field) => field.name && field.type);

const uniqueOptions = (values: string[]): string[] => [
	...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const communicationOptions: Array<{
	label: string;
	value: CommunicationProtocol;
}> = [
	{ label: "ROS2", value: "ros2" },
	{ label: "CycloneDDS", value: "cyclonedds" },
	{ label: "FastDDS", value: "fastdds" },
	{ label: "NATS", value: "nats" },
];

const communicationOptionsForFormat = (format: InterfaceDataFormatKind) =>
	format === "dds_idl"
		? communicationOptions.filter((option) =>
				["cyclonedds", "fastdds"].includes(option.value)
			)
		: communicationOptions;

const catalogDataTypeOptions = (
	catalog: DataFormatCatalog | undefined,
	kind: InterfaceDataFormatKind
): string[] => {
	if (!catalog) {
		return [];
	}
	return catalog.flatMap((service) =>
		service.formats
			.filter((format) => format.kind === kind)
			.flatMap((format) => {
				if (kind === "proto") {
					return [format.name];
				}
				return [format.name, `${service.service}/${format.name}`];
			})
	);
};

const dataFormatTypeOptions = (
	kind: InterfaceDataFormatKind,
	catalog?: DataFormatCatalog
): string[] => {
	if (kind === "proto") {
		return uniqueOptions([
			...PROTO_SCALAR_FIELD_TYPES,
			...PROTO_SCALAR_FIELD_TYPES.map((type) => `repeated ${type}`),
			...catalogDataTypeOptions(catalog, kind),
		]);
	}
	if (kind === "dds_idl") {
		const ddsIdlTypes = [
			"boolean",
			"octet",
			"short",
			"unsigned short",
			"long",
			"unsigned long",
			"long long",
			"unsigned long long",
			"float",
			"double",
			"string",
			"sequence<octet>",
			...catalogDataTypeOptions(catalog, kind),
		];
		return uniqueOptions(ddsIdlTypes);
	}
	const ros2BaseTypes = [
		...ROS2_SCALAR_FIELD_TYPES,
		...ROS2_NATIVE_MESSAGE_FIELD_TYPES,
		...catalogDataTypeOptions(catalog, "msg"),
	];
	return uniqueOptions([
		...ros2BaseTypes,
		...ros2BaseTypes.map((type) => `${type}[]`),
	]);
};

const isRos2ServiceTypeReference = (type: string): boolean => {
	const normalized = type.trim();
	return (
		ROS2_SERVICE_TYPE_REFERENCE_REGEX.test(normalized) ||
		normalized.startsWith("std_srvs/")
	);
};

const normalizeFieldTypes = (
	fields: DataFormatFieldDraft[],
	options: string[]
): DataFormatFieldDraft[] =>
	fields.map((field) => ({
		...field,
		type: options.includes(field.type)
			? field.type
			: (options[0] ?? field.type),
	}));

const parseRosDefinitionFields = (definition: string): DataFormatFieldDraft[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line) => line.replace(COMMENT_REGEX, "").trim())
		.filter(Boolean)
		.filter((line) => line !== "---")
		.map((line) => {
			const [type = "", name = ""] = line.split(WHITESPACE_REGEX);
			return {
				id: crypto.randomUUID(),
				name,
				type,
			};
		});

const validateRosDefinitionLines = (
	definition: string,
	allowSeparator: boolean
): string[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line, index) => ({
			line: line.replace(COMMENT_REGEX, "").trim(),
			lineNumber: index + 1,
		}))
		.filter((item) => item.line)
		.flatMap((item) => {
			if (allowSeparator && item.line === "---") {
				return [];
			}
			const parts = item.line.split(WHITESPACE_REGEX);
			if (parts.length < 2) {
				return [`第 ${item.lineNumber} 行缺少字段名：${item.line}`];
			}
			if (parts.length > 2) {
				return [`第 ${item.lineNumber} 行只能包含类型和字段名：${item.line}`];
			}
			if (isRos2ServiceTypeReference(parts[0] ?? "")) {
				return [
					`第 ${item.lineNumber} 行不能把 srv 类型作为字段类型：${parts[0] ?? ""}`,
				];
			}
			if (!FIELD_NAME_REGEX.test(parts[1] ?? "")) {
				return [`第 ${item.lineNumber} 行字段名不合法：${parts[1] ?? ""}`];
			}
			return [];
		});

const standardRos2ServiceTemplateFields = (
	fields: ReadonlyArray<{ name: string; type: string }>
): DataFormatFieldDraft[] =>
	fields.map((field) => ({
		id: crypto.randomUUID(),
		name: field.name,
		type: field.type,
	}));

const dataFormatFieldsEqualTemplate = (
	fields: DataFormatFieldDraft[],
	templateFields: ReadonlyArray<{ name: string; type: string }>
): boolean => {
	const payload = dataFormatFieldPayload(fields);
	return (
		payload.length === templateFields.length &&
		payload.every(
			(field, index) =>
				field.name === templateFields[index]?.name &&
				field.type === templateFields[index]?.type
		)
	);
};

const selectedStandardRos2ServiceTemplate = (
	value: DataFormatFormValue
): string => {
	if (value.kind !== "srv") {
		return "custom";
	}
	const matched = ROS2_STANDARD_SERVICE_TEMPLATES.find(
		(template) =>
			template.value !== "custom" &&
			value.name.trim() === template.name &&
			dataFormatFieldsEqualTemplate(value.fields, template.requestFields) &&
			dataFormatFieldsEqualTemplate(
				value.responseFields,
				template.responseFields
			)
	);
	return matched?.value ?? "custom";
};

const parseSrvDefinition = (definition: string) => {
	const requestLines: string[] = [];
	const responseLines: string[] = [];
	let inResponse = false;
	for (const line of definition.split(LINE_SPLIT_REGEX)) {
		if (line.trim() === "---") {
			inResponse = true;
			continue;
		}
		if (inResponse) {
			responseLines.push(line);
		} else {
			requestLines.push(line);
		}
	}
	return {
		fields: parseRosDefinitionFields(requestLines.join("\n")),
		responseFields: parseRosDefinitionFields(responseLines.join("\n")),
	};
};

const parseProtoDefinitionFields = (
	definition: string
): DataFormatFieldDraft[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line) => line.trim())
		.map((line) => line.match(PROTO_FIELD_LINE_REGEX))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({
			id: crypto.randomUUID(),
			name: match[2] ?? "",
			type: match[1] ?? "",
		}));

const parseDdsIdlDefinitionFields = (
	definition: string
): DataFormatFieldDraft[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line) => line.replace(DDS_LINE_COMMENT_REGEX, "").trim())
		.filter(Boolean)
		.filter((line) => !line.startsWith("struct "))
		.filter((line) => !line.startsWith("interface "))
		.filter((line) => !line.startsWith("module "))
		.filter((line) => !["{", "};", "}"].includes(line))
		.map((line) => line.replace(TRAILING_SEMICOLON_REGEX, ""))
		.map((line) => {
			const parts = line.split(WHITESPACE_REGEX);
			const name = parts.pop() ?? "";
			return {
				id: crypto.randomUUID(),
				name,
				type: parts.join(" "),
			};
		})
		.filter((field) => field.name && field.type);

const validateProtoDefinitionLines = (definition: string): string[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line, index) => ({
			line: line.replace(DDS_LINE_COMMENT_REGEX, "").trim(),
			lineNumber: index + 1,
		}))
		.filter((item) => item.line)
		.filter(
			(item) =>
				!(
					["{", "}", "};"].includes(item.line) ||
					item.line.startsWith("syntax ") ||
					item.line.startsWith("package ") ||
					item.line.startsWith("import ") ||
					item.line.startsWith("option ") ||
					item.line.startsWith("message ") ||
					item.line.startsWith("enum ") ||
					item.line.startsWith("oneof ")
				)
		)
		.flatMap((item) =>
			PROTO_FIELD_LINE_REGEX.test(item.line)
				? []
				: [`第 ${item.lineNumber} 行不是有效 proto 字段：${item.line}`]
		);

const validateDdsIdlDefinitionLines = (definition: string): string[] =>
	definition
		.split(LINE_SPLIT_REGEX)
		.map((line, index) => ({
			line: line.replace(DDS_LINE_COMMENT_REGEX, "").trim(),
			lineNumber: index + 1,
		}))
		.filter((item) => item.line)
		.filter(
			(item) =>
				!(
					["{", "};", "}"].includes(item.line) ||
					item.line.startsWith("struct ") ||
					item.line.startsWith("interface ") ||
					item.line.startsWith("module ")
				)
		)
		.flatMap((item) => {
			if (!item.line.endsWith(";")) {
				return [
					`第 ${item.lineNumber} 行 DDS IDL 字段需要以 ; 结尾：${item.line}`,
				];
			}
			const parts = item.line
				.replace(TRAILING_SEMICOLON_REGEX, "")
				.split(WHITESPACE_REGEX);
			if (parts.length < 2) {
				return [`第 ${item.lineNumber} 行缺少字段名：${item.line}`];
			}
			if (!FIELD_NAME_REGEX.test(parts.at(-1) ?? "")) {
				return [`第 ${item.lineNumber} 行字段名不合法：${parts.at(-1) ?? ""}`];
			}
			return [];
		});

const extractNamedDefinitionBlock = (
	definition: string,
	keyword: "message" | "struct"
): { body: string; name?: string } => {
	const match = definition.match(
		new RegExp(`\\b${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\{`)
	);
	if (!(match?.[1] && typeof match.index === "number")) {
		return { body: definition };
	}
	const bodyStart = match.index + match[0].length;
	let depth = 1;
	for (let index = bodyStart; index < definition.length; index += 1) {
		const char = definition[index];
		if (char === "{") {
			depth += 1;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					name: match[1],
					body: definition.slice(bodyStart, index),
				};
			}
		}
	}
	return {
		name: match[1],
		body: definition.slice(bodyStart),
	};
};

const parseDataFormatDefinitionDraft = (
	kind: InterfaceDataFormatKind,
	definition: string
): ParsedDataFormatDraft => {
	if (!definition.trim()) {
		return { errors: [], fields: [], responseFields: [] };
	}
	if (kind === "proto") {
		const block = extractNamedDefinitionBlock(definition, "message");
		const fields = parseProtoDefinitionFields(block.body);
		const errors = validateProtoDefinitionLines(block.body);
		return {
			errors:
				fields.length === 0 && errors.length === 0
					? ["没有解析到 proto 字段，请粘贴 message 定义或字段行。"]
					: errors,
			name: block.name,
			fields,
			responseFields: [],
		};
	}
	if (kind === "dds_idl") {
		const block = extractNamedDefinitionBlock(definition, "struct");
		const fields = parseDdsIdlDefinitionFields(block.body);
		const errors = validateDdsIdlDefinitionLines(block.body);
		return {
			errors:
				fields.length === 0 && errors.length === 0
					? ["没有解析到 DDS IDL 字段，请粘贴 struct 定义或字段行。"]
					: errors,
			name: block.name,
			fields,
			responseFields: [],
		};
	}
	if (kind === "srv") {
		const parsed = parseSrvDefinition(definition);
		const errors = validateRosDefinitionLines(definition, true);
		const separatorCount = definition
			.split(LINE_SPLIT_REGEX)
			.filter((line) => line.trim() === "---").length;
		return {
			...parsed,
			errors: [
				...errors,
				...(separatorCount > 1
					? ["srv 定义最多只能包含一个 --- 分隔符。"]
					: []),
				...(parsed.fields.length === 0 && parsed.responseFields.length === 0
					? ["没有解析到 srv 字段，请粘贴请求字段、--- 和响应字段。"]
					: []),
			],
		};
	}
	const fields = parseRosDefinitionFields(definition);
	const errors = validateRosDefinitionLines(definition, false);
	return {
		errors:
			fields.length === 0 && errors.length === 0
				? ["没有解析到 msg 字段，请粘贴 ROS2 msg 字段行。"]
				: errors,
		fields,
		responseFields: [],
	};
};

const dataFormatPastePlaceholder = (kind: InterfaceDataFormatKind): string => {
	if (kind === "proto") {
		return [
			"message RobotState {",
			"  string robot_id = 1;",
			"  repeated float joint_positions = 2;",
			"}",
		].join("\n");
	}
	if (kind === "dds_idl") {
		return [
			"struct RobotState {",
			"  string robot_id;",
			"  sequence<double> joint_positions;",
			"};",
		].join("\n");
	}
	if (kind === "srv") {
		return ["string robot_id", "---", "bool accepted", "string message"].join(
			"\n"
		);
	}
	return [
		"std_msgs/Header header",
		"string robot_id",
		"float64[] joint_positions",
	].join("\n");
};

const fieldsOrDraft = (
	fields: DataFormatFieldDraft[]
): DataFormatFieldDraft[] => (fields.length > 0 ? fields : [newFieldDraft()]);

const parsedFieldsFromDataFormatItem = (
	item: DataFormatItem
): DataFormatFieldDraft[] => {
	if (item.kind === "proto") {
		return parseProtoDefinitionFields(item.definition);
	}
	if (item.kind === "dds_idl") {
		return parseDdsIdlDefinitionFields(item.definition);
	}
	return parseRosDefinitionFields(item.definition);
};

const fieldsFromPaste = (
	parsedFields: DataFormatFieldDraft[],
	definition: string,
	currentFields: DataFormatFieldDraft[]
): DataFormatFieldDraft[] => {
	if (parsedFields.length > 0) {
		return parsedFields;
	}
	if (definition.trim()) {
		return currentFields;
	}
	return [newFieldDraft()];
};

const responseFieldsFromPaste = (
	value: DataFormatFormValue,
	parsed: ParsedDataFormatDraft,
	definition: string
): DataFormatFieldDraft[] => {
	if (value.kind !== "srv") {
		return value.responseFields;
	}
	return fieldsFromPaste(
		parsed.responseFields,
		definition,
		value.responseFields
	);
};

const pastePreviewStatusText = ({
	parsedFieldCount,
	pasteHasErrors,
	pastedDefinition,
}: {
	parsedFieldCount: number;
	pasteHasErrors: boolean;
	pastedDefinition: string;
}): string => {
	if (!pastedDefinition.trim()) {
		return "等待粘贴内容。";
	}
	if (pasteHasErrors) {
		return "解析失败，请按当前数据格式修正粘贴内容。";
	}
	if (parsedFieldCount > 0) {
		return `已解析 ${parsedFieldCount} 个字段。`;
	}
	return "还没有解析到字段，请检查当前数据格式和粘贴内容是否匹配。";
};

const initialDataFormatFormValue = (
	item?: DataFormatItem
): DataFormatFormValue => {
	if (!item) {
		return {
			kind: "proto",
			name: "",
			fields: [newFieldDraft()],
			responseFields: [newFieldDraft()],
		};
	}
	if (item.kind === "srv") {
		const parsed = parseSrvDefinition(item.definition);
		return {
			kind: "srv",
			name: item.name,
			fields: fieldsOrDraft(parsed.fields),
			responseFields: fieldsOrDraft(parsed.responseFields),
		};
	}
	const fields = parsedFieldsFromDataFormatItem(item);
	return {
		kind: item.kind,
		name: item.name,
		fields: fieldsOrDraft(fields),
		responseFields: [newFieldDraft()],
	};
};

const renderDataFormatDefinition = (value: DataFormatFormValue): string => {
	const fields = dataFormatFieldPayload(value.fields);
	if (value.kind === "proto") {
		return [
			`message ${value.name.trim()} {`,
			...fields.map(
				(field, index) => `  ${field.type} ${field.name} = ${index + 1};`
			),
			"}",
		].join("\n");
	}
	if (value.kind === "dds_idl") {
		return [
			`struct ${value.name.trim()} {`,
			...fields.map((field) => `  ${field.type} ${field.name};`),
			"};",
		].join("\n");
	}
	const request = fields
		.map((field) => `${field.type} ${field.name}`)
		.join("\n");
	if (value.kind === "srv") {
		const response = dataFormatFieldPayload(value.responseFields)
			.map((field) => `${field.type} ${field.name}`)
			.join("\n");
		return `${request}${request ? "\n" : ""}---${response ? `\n${response}` : ""}`;
	}
	return request;
};

const createDataFormatPayload = (
	value: DataFormatFormValue
): CreateDataFormatInput => ({
	kind: value.kind,
	name: value.name,
	fields: dataFormatFieldPayload(value.fields),
	responseFields:
		value.kind === "srv"
			? dataFormatFieldPayload(value.responseFields)
			: undefined,
});

const addDialogTitle = (activeTab: DetailTab) =>
	activeTab === "communication" ? "Add Interface" : "Add Data Format";

function Modal({
	children,
	onClose,
	title,
}: {
	children: ReactNode;
	onClose: () => void;
	title: string;
}) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open
		>
			<DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] min-w-0 overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	);
}

function AppSelect<T extends string>({
	disabled,
	emptyLabel = "暂无可选项",
	label,
	onValueChange,
	options,
	value,
}: {
	disabled?: boolean;
	emptyLabel?: string;
	label: string;
	onValueChange: (value: T) => void;
	options: Array<{ disabled?: boolean; label: string; value: T }>;
	value: T;
}) {
	const triggerId = useId();
	const visibleOptions =
		options.length > 0
			? options
			: [{ disabled: true, label: emptyLabel, value: "" as T }];

	return (
		<Field className="min-w-0">
			<FieldLabel htmlFor={triggerId}>{label}</FieldLabel>
			<Select
				disabled={disabled || options.length === 0}
				onValueChange={(nextValue) => {
					if (typeof nextValue === "string") {
						onValueChange(nextValue as T);
					}
				}}
				value={value}
			>
				<SelectTrigger className="w-full min-w-0" id={triggerId}>
					<SelectValue className="min-w-0 truncate" />
				</SelectTrigger>
				<SelectContent align="start" className="w-(--anchor-width)">
					<SelectGroup>
						{visibleOptions.map((option) => (
							<SelectItem
								disabled={option.disabled}
								key={option.value || option.label}
								value={option.value}
							>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	);
}

function DataDefinitionPreview({
	definition,
	title,
}: {
	definition: string | undefined;
	title: string;
}) {
	return (
		<Field className="min-h-40">
			<FieldLabel>{title}</FieldLabel>
			<pre className="min-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/25 p-3 font-mono text-muted-foreground text-xs leading-relaxed">
				{definition?.trim() || "暂无可预览的数据格式。"}
			</pre>
		</Field>
	);
}

function CommunicationBasicFields({
	communication,
	formatKind,
	consumerMode,
	isService,
	kind,
	mode,
	name,
	setCommunication,
	setKind,
	setMode,
	setName,
}: {
	communication: CommunicationProtocol;
	formatKind: InterfaceDataFormatKind;
	consumerMode: boolean;
	isService: boolean;
	kind: CommunicationKind;
	mode: CommunicationMode;
	name: string;
	setCommunication: (communication: CommunicationProtocol) => void;
	setKind: (kind: CommunicationKind) => void;
	setMode: (mode: CommunicationMode) => void;
	setName: (name: string) => void;
}) {
	const options = communicationOptionsForFormat(formatKind);
	return (
		<div className="flex flex-col gap-3">
			<div className="font-medium text-sm">接口/消息基础信息定义</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<AppSelect
					label="方向"
					onValueChange={setMode}
					options={[
						{
							label: communicationModeLabel("provide"),
							value: "provide",
						},
						{ label: communicationModeLabel("use"), value: "use" },
					]}
					value={mode}
				/>
				<AppSelect
					label="接口类型"
					onValueChange={setKind}
					options={[
						{ label: "接口调用", value: "service" },
						{ label: "消息流", value: "topic" },
					]}
					value={kind}
				/>
			</div>
			{consumerMode ? null : (
				<div className="grid gap-3 sm:grid-cols-2">
					<Field>
						<FieldLabel>接口/消息名</FieldLabel>
						<Input
							onChange={(event) => setName(event.target.value)}
							placeholder={isService ? "play_action" : "robot_state"}
							value={name}
						/>
					</Field>
					<AppSelect
						label="通信方式"
						onValueChange={setCommunication}
						options={options}
						value={communication}
					/>
				</div>
			)}
		</div>
	);
}

function InterfaceDataSelectors({
	allowedFormatKinds,
	disableServiceSelect,
	formatKind,
	inputFormatOptions,
	isService,
	isSingleServicePayload,
	normalizedInputName,
	normalizedOutputName,
	outputFormatOptions,
	selectedService,
	selectorGridClass,
	servicesWithFormat,
	setFormatKind,
	setInputName,
	setOutputName,
	setServiceName,
}: {
	allowedFormatKinds: InterfaceDataFormatKind[];
	disableServiceSelect?: boolean;
	formatKind: InterfaceDataFormatKind;
	inputFormatOptions: DataFormatCatalogItem[];
	isService: boolean;
	isSingleServicePayload: boolean;
	normalizedInputName: string;
	normalizedOutputName: string;
	outputFormatOptions: DataFormatCatalogItem[];
	selectedService: DataFormatCatalogService | undefined;
	selectorGridClass: string;
	servicesWithFormat: DataFormatCatalog;
	setFormatKind: (kind: InterfaceDataFormatKind) => void;
	setInputName: (name: string) => void;
	setOutputName: (name: string) => void;
	setServiceName: (name: string) => void;
}) {
	const resetSelectedFormats = () => {
		setInputName("");
		setOutputName("");
	};

	return (
		<div className={selectorGridClass}>
			<AppSelect
				label="数据格式"
				onValueChange={(value) => {
					setFormatKind(value);
					resetSelectedFormats();
				}}
				options={allowedFormatKinds.map((kindOption) => ({
					label: kindOption,
					value: kindOption,
				}))}
				value={formatKind}
			/>
			<AppSelect
				disabled={disableServiceSelect}
				label="所属服务"
				onValueChange={(value) => {
					setServiceName(value);
					resetSelectedFormats();
				}}
				options={servicesWithFormat.map((service) => ({
					label: service.service,
					value: service.service,
				}))}
				value={selectedService?.service ?? ""}
			/>
			{inputFormatOptions.length > 0 ? (
				<AppSelect
					label={interfacePayloadLabel(isService, isSingleServicePayload)}
					onValueChange={setInputName}
					options={inputFormatOptions.map((format) => ({
						label: format.name,
						value: format.name,
					}))}
					value={normalizedInputName}
				/>
			) : (
				<Empty
					className={emptyPayloadSelectorClass(
						isService,
						isSingleServicePayload
					)}
				>
					<EmptyHeader>
						<EmptyTitle>当前没有可选择的数据格式。</EmptyTitle>
						<EmptyDescription>
							请先在数据格式页创建 proto、msg 或 srv 定义。
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
			{isService &&
			!isSingleServicePayload &&
			outputFormatOptions.length > 0 ? (
				<AppSelect
					label="输出类型"
					onValueChange={setOutputName}
					options={outputFormatOptions.map((format) => ({
						label: format.name,
						value: format.name,
					}))}
					value={normalizedOutputName}
				/>
			) : null}
		</div>
	);
}

function DataPreviewSection({
	isService,
	isSingleServicePayload,
	selectedInputFormat,
	selectedOutputFormat,
}: {
	isService: boolean;
	isSingleServicePayload: boolean;
	selectedInputFormat: DataFormatCatalogItem | undefined;
	selectedOutputFormat: DataFormatCatalogItem | undefined;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="font-medium text-sm">数据预览</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<DataDefinitionPreview
					definition={selectedInputFormat?.definition}
					title={dataPreviewTitle(isService, isSingleServicePayload)}
				/>
				{isService && !isSingleServicePayload ? (
					<DataDefinitionPreview
						definition={selectedOutputFormat?.definition}
						title="输出预览"
					/>
				) : null}
			</div>
		</div>
	);
}

function ConsumerInterfaceSelectors({
	currentServiceName,
	kind,
	onRouteChange,
	onServiceChange,
	providerService,
	publicInterfaceCatalog,
	routeName,
}: {
	currentServiceName: string;
	kind: CommunicationKind;
	onRouteChange: (routeName: string) => void;
	onServiceChange: (serviceName: string) => void;
	providerService: string;
	publicInterfaceCatalog: PublicInterfaceCatalog;
	routeName: string;
}) {
	const providers = publicInterfaceCatalog.filter(
		(provider) =>
			isSelectableExternalService(provider.service, currentServiceName) &&
			provider.interfaces.some((item) => item.kind === kind)
	);
	const selectedProvider =
		providers.find((provider) => provider.service === providerService) ??
		providers[0];
	const interfaces =
		selectedProvider?.interfaces.filter((item) => item.kind === kind) ?? [];
	const selectedRoute =
		interfaces.find((item) => item.name === routeName) ?? interfaces[0];

	return (
		<div className="flex flex-col gap-3">
			<div className="font-medium text-sm">外部接口/消息选择</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<AppSelect
					label="所属服务"
					onValueChange={(value) => {
						onServiceChange(value);
						onRouteChange("");
					}}
					options={providers.map((provider) => ({
						label: provider.service,
						value: provider.service,
					}))}
					value={selectedProvider?.service ?? ""}
				/>
				<AppSelect
					label={kind === "service" ? "接口" : "消息"}
					onValueChange={onRouteChange}
					options={interfaces.map((item) => ({
						label: item.name,
						value: item.name,
					}))}
					value={selectedRoute?.name ?? ""}
				/>
			</div>
			{selectedRoute ? (
				<Alert>
					<Network />
					<AlertTitle>{selectedRoute.name}</AlertTitle>
					<AlertDescription>
						<div>{selectedRoute.messageType || selectedRoute.format}</div>
						<div>
							{selectedRoute.transports.join(", ") || "继承公共接口通信方式"}
						</div>
					</AlertDescription>
				</Alert>
			) : (
				<Empty className="min-h-24 border">
					<EmptyHeader>
						<EmptyTitle>
							当前没有可选择的外部{kind === "service" ? "接口" : "消息"}。
						</EmptyTitle>
						<EmptyDescription>
							共享接口目录中暂未发现可复用的外部定义。
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
		</div>
	);
}

function ProviderCommunicationFields({
	allowedFormatKinds,
	disableServiceSelect,
	formatKind,
	formatOptions,
	inputFormatOptions,
	isService,
	isSingleServicePayload,
	normalizedInputName,
	normalizedOutputName,
	outputFormatOptions,
	selectedInputFormat,
	selectedOutputFormat,
	selectedService,
	selectorGridClass,
	servicesWithFormat,
	setFormatKind,
	setInputName,
	setOutputName,
	setServiceName,
}: {
	allowedFormatKinds: InterfaceDataFormatKind[];
	disableServiceSelect?: boolean;
	formatKind: InterfaceDataFormatKind;
	formatOptions: DataFormatCatalogItem[];
	inputFormatOptions: DataFormatCatalogItem[];
	isService: boolean;
	isSingleServicePayload: boolean;
	normalizedInputName: string;
	normalizedOutputName: string;
	outputFormatOptions: DataFormatCatalogItem[];
	selectedInputFormat: DataFormatCatalogItem | undefined;
	selectedOutputFormat: DataFormatCatalogItem | undefined;
	selectedService: DataFormatCatalogService | undefined;
	selectorGridClass: string;
	servicesWithFormat: DataFormatCatalog;
	setFormatKind: (kind: InterfaceDataFormatKind) => void;
	setInputName: (name: string) => void;
	setOutputName: (name: string) => void;
	setServiceName: (name: string) => void;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="font-medium text-sm">输入输出定义</div>
			<InterfaceDataSelectors
				allowedFormatKinds={allowedFormatKinds}
				disableServiceSelect={disableServiceSelect}
				formatKind={formatKind}
				inputFormatOptions={inputFormatOptions}
				isService={isService}
				isSingleServicePayload={isSingleServicePayload}
				normalizedInputName={normalizedInputName}
				normalizedOutputName={normalizedOutputName}
				outputFormatOptions={outputFormatOptions}
				selectedService={selectedService}
				selectorGridClass={selectorGridClass}
				servicesWithFormat={servicesWithFormat}
				setFormatKind={setFormatKind}
				setInputName={setInputName}
				setOutputName={setOutputName}
				setServiceName={setServiceName}
			/>
			{formatOptions.length > 0 ? (
				<DataPreviewSection
					isService={isService}
					isSingleServicePayload={isSingleServicePayload}
					selectedInputFormat={selectedInputFormat}
					selectedOutputFormat={selectedOutputFormat}
				/>
			) : null}
		</div>
	);
}

function DataFormatFieldRows({
	fields,
	locked = false,
	onChange,
	title,
	typeOptions,
}: {
	fields: DataFormatFieldDraft[];
	locked?: boolean;
	onChange: (fields: DataFormatFieldDraft[]) => void;
	title: string;
	typeOptions: string[];
}) {
	const newTypedFieldDraft = (): DataFormatFieldDraft => ({
		...newFieldDraft(),
		type: typeOptions[0] ?? "",
	});
	const updateField = (id: string, key: "name" | "type", value: string) => {
		onChange(
			fields.map((field) =>
				field.id === id
					? {
							...field,
							[key]: value,
						}
					: field
			)
		);
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="font-medium text-sm">{title}</div>
			{fields.map((field) => (
				<div
					className={
						locked
							? "grid min-w-0 gap-2 sm:grid-cols-2"
							: "grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
					}
					key={field.id}
				>
					<AppSelect
						disabled={locked}
						label="数据类型"
						onValueChange={(value) => updateField(field.id, "type", value)}
						options={uniqueOptions([
							...(isRos2ServiceTypeReference(field.type) ? [] : [field.type]),
							...typeOptions,
						]).map((type) => ({
							label: type,
							value: type,
						}))}
						value={field.type}
					/>
					<Field>
						<FieldLabel>变量名</FieldLabel>
						<Input
							disabled={locked}
							onChange={(event) =>
								updateField(field.id, "name", event.target.value)
							}
							placeholder="robot_id"
							value={field.name}
						/>
					</Field>
					{locked ? null : (
						<Button
							className="self-end"
							onClick={() =>
								onChange(
									fields.length > 1
										? fields.filter((item) => item.id !== field.id)
										: [newTypedFieldDraft()]
								)
							}
							size="sm"
							type="button"
							variant="outline"
						>
							Delete
						</Button>
					)}
				</div>
			))}
			{locked ? null : (
				<Button
					className="w-fit"
					onClick={() => onChange([...fields, newTypedFieldDraft()])}
					size="sm"
					type="button"
					variant="outline"
				>
					Add Field
				</Button>
			)}
		</div>
	);
}

function DataFormatForm({
	allowKindChange,
	catalog,
	onChange,
	value,
}: {
	allowKindChange: boolean;
	catalog?: DataFormatCatalog;
	onChange: (value: DataFormatFormValue) => void;
	value: DataFormatFormValue;
}) {
	const [fieldInputMode, setFieldInputMode] = useState<"form" | "paste">(
		"form"
	);
	const [pastedDefinition, setPastedDefinition] = useState("");
	const typeOptions = dataFormatTypeOptions(value.kind, catalog);
	const srvTemplateValue = selectedStandardRos2ServiceTemplate(value);
	const standardSrvTemplateLocked =
		value.kind === "srv" && srvTemplateValue !== "custom";
	const handleKindChange = (kind: InterfaceDataFormatKind) => {
		const nextTypeOptions = dataFormatTypeOptions(kind, catalog);
		onChange({
			...value,
			kind,
			fields: normalizeFieldTypes(value.fields, nextTypeOptions),
			responseFields: normalizeFieldTypes(
				value.responseFields,
				nextTypeOptions
			),
		});
	};
	const handleSrvTemplateChange = (templateValue: string) => {
		const template = ROS2_STANDARD_SERVICE_TEMPLATES.find(
			(item) => item.value === templateValue
		);
		if (!template) {
			return;
		}
		if (template.value === "custom") {
			onChange({
				...value,
				kind: "srv",
				name: allowKindChange ? "" : value.name,
				fields: [newFieldDraft()],
				responseFields: [newFieldDraft()],
			});
			return;
		}
		onChange({
			...value,
			kind: "srv",
			name: allowKindChange ? template.name : value.name,
			fields: standardRos2ServiceTemplateFields(template.requestFields),
			responseFields: standardRos2ServiceTemplateFields(
				template.responseFields
			),
		});
	};
	const handlePasteDefinitionChange = (definition: string) => {
		setPastedDefinition(definition);
		const parsed = parseDataFormatDefinitionDraft(value.kind, definition);
		if (parsed.errors.length > 0) {
			return;
		}
		const nextFields = fieldsFromPaste(parsed.fields, definition, value.fields);
		const nextResponseFields = responseFieldsFromPaste(
			value,
			parsed,
			definition
		);
		onChange({
			...value,
			name: allowKindChange && parsed.name ? parsed.name : value.name,
			fields: nextFields,
			responseFields: nextResponseFields,
		});
	};
	const parsedPreview = parseDataFormatDefinitionDraft(
		value.kind,
		pastedDefinition
	);
	const parsedFieldCount =
		parsedPreview.fields.length +
		(value.kind === "srv" ? parsedPreview.responseFields.length : 0);
	const pasteHasErrors = parsedPreview.errors.length > 0;
	const pastePreviewMessage = pastePreviewStatusText({
		parsedFieldCount,
		pasteHasErrors,
		pastedDefinition,
	});
	const dataFormatKindOptions: Array<{
		label: InterfaceDataFormatKind;
		value: InterfaceDataFormatKind;
	}> = [
		{ label: "proto", value: "proto" },
		{ label: "msg", value: "msg" },
		{ label: "srv", value: "srv" },
		{ label: "dds_idl", value: "dds_idl" },
	];

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-3">
				<AppSelect
					disabled={!allowKindChange}
					label="数据格式"
					onValueChange={handleKindChange}
					options={dataFormatKindOptions}
					value={value.kind}
				/>
				<Field className="sm:col-span-2">
					<FieldLabel>名称</FieldLabel>
					<Input
						disabled={!allowKindChange}
						onChange={(event) =>
							onChange({
								...value,
								name: event.target.value,
							})
						}
						placeholder="RobotState"
						value={value.name}
					/>
				</Field>
			</div>
			{value.kind === "srv" ? (
				<AppSelect
					label="标准服务模板"
					onValueChange={handleSrvTemplateChange}
					options={ROS2_STANDARD_SERVICE_TEMPLATES.map((template) => ({
						label: template.label,
						value: template.value,
					}))}
					value={srvTemplateValue}
				/>
			) : null}
			<Tabs
				onValueChange={(next) => setFieldInputMode(next as "form" | "paste")}
				value={fieldInputMode}
			>
				<TabsList>
					<TabsTrigger value="form">表单选择</TabsTrigger>
					<TabsTrigger value="paste">粘贴解析</TabsTrigger>
				</TabsList>
				<TabsContent className="flex flex-col gap-4" value="form">
					<DataFormatFieldRows
						fields={value.fields}
						locked={standardSrvTemplateLocked}
						onChange={(fields) =>
							onChange({
								...value,
								fields,
							})
						}
						title={value.kind === "srv" ? "输入字段" : "字段定义"}
						typeOptions={typeOptions}
					/>
					{value.kind === "srv" ? (
						<DataFormatFieldRows
							fields={value.responseFields}
							locked={standardSrvTemplateLocked}
							onChange={(responseFields) =>
								onChange({
									...value,
									responseFields,
								})
							}
							title="输出字段"
							typeOptions={typeOptions}
						/>
					) : null}
				</TabsContent>
				<TabsContent className="flex flex-col gap-3" value="paste">
					<Field>
						<FieldLabel>粘贴数据结构</FieldLabel>
						<Textarea
							className="min-h-52 resize-y font-mono text-xs leading-5"
							onChange={(event) =>
								handlePasteDefinitionChange(event.target.value)
							}
							placeholder={dataFormatPastePlaceholder(value.kind)}
							value={pastedDefinition}
						/>
						<FieldDescription>
							支持粘贴 {value.kind}{" "}
							定义或字段片段；解析到字段后会同步更新表单和定义预览。
						</FieldDescription>
					</Field>
					<div className="rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
						{pastePreviewMessage}
					</div>
					{pasteHasErrors ? (
						<div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-xs">
							<div className="font-medium">格式有问题</div>
							<ul className="mt-2 list-disc space-y-1 pl-4">
								{parsedPreview.errors.map((error) => (
									<li key={error}>{error}</li>
								))}
							</ul>
						</div>
					) : null}
					{parsedFieldCount > 0 && !pasteHasErrors ? (
						<div className="overflow-hidden rounded-md border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>字段</TableHead>
										<TableHead>类型</TableHead>
										{value.kind === "srv" ? <TableHead>方向</TableHead> : null}
									</TableRow>
								</TableHeader>
								<TableBody>
									{parsedPreview.fields.map((field) => (
										<TableRow key={field.id}>
											<TableCell>{field.name}</TableCell>
											<TableCell className="font-mono text-xs">
												{field.type}
											</TableCell>
											{value.kind === "srv" ? (
												<TableCell>输入</TableCell>
											) : null}
										</TableRow>
									))}
									{value.kind === "srv"
										? parsedPreview.responseFields.map((field) => (
												<TableRow key={field.id}>
													<TableCell>{field.name}</TableCell>
													<TableCell className="font-mono text-xs">
														{field.type}
													</TableCell>
													<TableCell>输出</TableCell>
												</TableRow>
											))
										: null}
								</TableBody>
							</Table>
						</div>
					) : null}
				</TabsContent>
			</Tabs>
			<Field>
				<FieldLabel>定义预览</FieldLabel>
				<pre className="min-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
					{renderDataFormatDefinition(value)}
				</pre>
			</Field>
		</div>
	);
}

function CommunicationAddFields({
	allowedFormatKinds,
	communication,
	consumerMode,
	currentServiceName,
	formatKind,
	formatOptions,
	inputFormatOptions,
	isService,
	isSingleServicePayload,
	kind,
	mode,
	name,
	normalizedInputName,
	normalizedOutputName,
	outputFormatOptions,
	publicInterfaceCatalog,
	selectedConsumerRoute,
	selectedInputFormat,
	selectedOutputFormat,
	selectedProvider,
	selectedService,
	selectorGridClass,
	servicesWithFormat,
	setCommunication,
	setFormatKind,
	setInputName,
	setKind,
	setMode,
	setName,
	setOutputName,
	setProviderService,
	setRouteName,
	setServiceName,
}: {
	allowedFormatKinds: InterfaceDataFormatKind[];
	communication: CommunicationProtocol;
	consumerMode: boolean;
	currentServiceName: string;
	formatKind: InterfaceDataFormatKind;
	formatOptions: DataFormatCatalogItem[];
	inputFormatOptions: DataFormatCatalogItem[];
	isService: boolean;
	isSingleServicePayload: boolean;
	kind: CommunicationKind;
	mode: CommunicationMode;
	name: string;
	normalizedInputName: string;
	normalizedOutputName: string;
	outputFormatOptions: DataFormatCatalogItem[];
	publicInterfaceCatalog: PublicInterfaceCatalog;
	selectedConsumerRoute: CommunicationItem | undefined;
	selectedInputFormat: DataFormatCatalogItem | undefined;
	selectedOutputFormat: DataFormatCatalogItem | undefined;
	selectedProvider: PublicInterfaceCatalogService | undefined;
	selectedService: DataFormatCatalogService | undefined;
	selectorGridClass: string;
	servicesWithFormat: DataFormatCatalog;
	setCommunication: (communication: CommunicationProtocol) => void;
	setFormatKind: (kind: InterfaceDataFormatKind) => void;
	setInputName: (name: string) => void;
	setKind: (kind: CommunicationKind) => void;
	setMode: (mode: CommunicationMode) => void;
	setName: (name: string) => void;
	setOutputName: (name: string) => void;
	setProviderService: (serviceName: string) => void;
	setRouteName: (routeName: string) => void;
	setServiceName: (serviceName: string) => void;
}) {
	return (
		<>
			<CommunicationBasicFields
				communication={communication}
				consumerMode={consumerMode}
				formatKind={formatKind}
				isService={isService}
				kind={kind}
				mode={mode}
				name={name}
				setCommunication={setCommunication}
				setKind={setKind}
				setMode={setMode}
				setName={setName}
			/>
			{consumerMode ? (
				<ConsumerInterfaceSelectors
					currentServiceName={currentServiceName}
					kind={kind}
					onRouteChange={setRouteName}
					onServiceChange={setProviderService}
					providerService={selectedProvider?.service ?? ""}
					publicInterfaceCatalog={publicInterfaceCatalog}
					routeName={selectedConsumerRoute?.name ?? ""}
				/>
			) : (
				<ProviderCommunicationFields
					allowedFormatKinds={allowedFormatKinds}
					disableServiceSelect={true}
					formatKind={formatKind}
					formatOptions={formatOptions}
					inputFormatOptions={inputFormatOptions}
					isService={isService}
					isSingleServicePayload={isSingleServicePayload}
					normalizedInputName={normalizedInputName}
					normalizedOutputName={normalizedOutputName}
					outputFormatOptions={outputFormatOptions}
					selectedInputFormat={selectedInputFormat}
					selectedOutputFormat={selectedOutputFormat}
					selectedService={selectedService}
					selectorGridClass={selectorGridClass}
					servicesWithFormat={servicesWithFormat}
					setFormatKind={setFormatKind}
					setInputName={setInputName}
					setOutputName={setOutputName}
					setServiceName={setServiceName}
				/>
			)}
		</>
	);
}

function AddInterfaceDialog({
	activeTab,
	catalog,
	currentServiceName,
	isPending,
	onClose,
	onCreateConsumer,
	onCreateDataFormat,
	onCreateProvider,
	publicInterfaceCatalog,
}: {
	activeTab: DetailTab;
	catalog: DataFormatCatalog;
	currentServiceName: string;
	isPending: boolean;
	onClose: () => void;
	onCreateConsumer: (input: ConsumerCommunicationInput) => void;
	onCreateDataFormat: (input: CreateDataFormatInput) => void;
	onCreateProvider: (input: ProviderCommunicationInput) => void;
	publicInterfaceCatalog: PublicInterfaceCatalog;
}) {
	const [kind, setKind] = useState<CommunicationKind>("service");
	const [mode, setMode] = useState<CommunicationMode>("provide");
	const [name, setName] = useState("");
	const [communication, setCommunication] =
		useState<CommunicationProtocol>("cyclonedds");
	const [formatKind, setFormatKind] =
		useState<InterfaceDataFormatKind>("proto");
	const initialServiceName =
		catalog.find((service) => service.service === currentServiceName)
			?.service ?? currentServiceName;
	const [serviceName, setServiceName] = useState(initialServiceName);
	const initialProviderService =
		publicInterfaceCatalog.find((service) =>
			service.interfaces.some((item) => item.kind === "service")
		)?.service ?? "";
	const [providerService, setProviderService] = useState(
		initialProviderService
	);
	const [routeName, setRouteName] = useState("");
	const [inputName, setInputName] = useState("");
	const [outputName, setOutputName] = useState("");
	const [dataFormatForm, setDataFormatForm] = useState(
		initialDataFormatFormValue()
	);
	const isService = kind === "service";
	const consumerMode = mode === "use";
	const allowedFormatKinds = INTERFACE_DATA_FORMATS[kind];
	const normalizedFormatKind = allowedFormatKinds.includes(formatKind)
		? formatKind
		: allowedFormatKinds[0];
	const currentServiceCatalog = catalog.find(
		(service) => service.service === currentServiceName
	) ?? { formats: [], service: currentServiceName };
	const servicesWithFormat = currentServiceName ? [currentServiceCatalog] : [];
	const selectedService =
		servicesWithFormat.find((service) => service.service === serviceName) ??
		servicesWithFormat[0];
	const formatOptions =
		selectedService?.formats.filter(
			(format) => format.kind === normalizedFormatKind
		) ?? [];
	const inputFormatOptions =
		isService && normalizedFormatKind === "proto"
			? protoServicePayloadOptions(formatOptions, "request")
			: formatOptions;
	const outputFormatOptions =
		isService && normalizedFormatKind === "proto"
			? protoServicePayloadOptions(formatOptions, "response")
			: formatOptions;
	const normalizedInputName = inputName || inputFormatOptions[0]?.name || "";
	const normalizedOutputName =
		outputName || outputFormatOptions[0]?.name || normalizedInputName;
	const selectedInputFormat = inputFormatOptions.find(
		(format) => format.name === normalizedInputName
	);
	const selectedOutputFormat = outputFormatOptions.find(
		(format) => format.name === normalizedOutputName
	);
	const isSingleServicePayload = isService && normalizedFormatKind === "srv";
	const selectorGridClass = dataSelectorGridClass(
		isService,
		isSingleServicePayload
	);
	const title = addDialogTitle(activeTab);
	const handleKindChange = (nextKind: CommunicationKind) => {
		setKind(nextKind);
		const nextAllowedFormats = INTERFACE_DATA_FORMATS[nextKind];
		if (!nextAllowedFormats.includes(formatKind)) {
			const nextFormat = nextAllowedFormats[0];
			setFormatKind(nextFormat);
			if (
				nextFormat === "dds_idl" &&
				!["cyclonedds", "fastdds"].includes(communication)
			) {
				setCommunication("cyclonedds");
			}
		}
		setInputName("");
		setOutputName("");
		setRouteName("");
	};
	const handleFormatKindChange = (nextFormat: InterfaceDataFormatKind) => {
		setFormatKind(nextFormat);
		if (
			nextFormat === "dds_idl" &&
			!["cyclonedds", "fastdds"].includes(communication)
		) {
			setCommunication("cyclonedds");
		}
	};
	const handleModeChange = (nextMode: CommunicationMode) => {
		setMode(nextMode);
		if (nextMode === "provide") {
			setServiceName(currentServiceName);
			setInputName("");
			setOutputName("");
		}
	};
	const selectedProvider = selectedPublicProvider(
		publicInterfaceCatalog,
		currentServiceName,
		providerService,
		kind
	);
	const selectedConsumerRoute = selectedPublicRoute(
		selectedProvider,
		routeName,
		kind
	);
	const handleCreate = () => {
		if (activeTab === "data") {
			onCreateDataFormat(createDataFormatPayload(dataFormatForm));
			return;
		}
		if (consumerMode) {
			if (!(selectedProvider && selectedConsumerRoute)) {
				return;
			}
			onCreateConsumer({
				kind,
				providerService: selectedProvider.service,
				routeName: selectedConsumerRoute.name,
			});
			return;
		}
		if (!(selectedService && selectedInputFormat)) {
			return;
		}
		onCreateProvider({
			communication,
			dataService: selectedService.service,
			format: normalizedFormatKind,
			inputName: selectedInputFormat.name,
			kind,
			name: name.trim(),
			outputName: selectedOutputFormat?.name,
		});
	};

	return (
		<Modal onClose={onClose} title={title}>
			<form
				className="flex min-w-0 flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					handleCreate();
				}}
			>
				{activeTab === "communication" ? (
					<CommunicationAddFields
						allowedFormatKinds={allowedFormatKinds}
						communication={communication}
						consumerMode={consumerMode}
						currentServiceName={currentServiceName}
						formatKind={normalizedFormatKind}
						formatOptions={formatOptions}
						inputFormatOptions={inputFormatOptions}
						isService={isService}
						isSingleServicePayload={isSingleServicePayload}
						kind={kind}
						mode={mode}
						name={name}
						normalizedInputName={normalizedInputName}
						normalizedOutputName={normalizedOutputName}
						outputFormatOptions={outputFormatOptions}
						publicInterfaceCatalog={publicInterfaceCatalog}
						selectedConsumerRoute={selectedConsumerRoute}
						selectedInputFormat={selectedInputFormat}
						selectedOutputFormat={selectedOutputFormat}
						selectedProvider={selectedProvider}
						selectedService={selectedService}
						selectorGridClass={selectorGridClass}
						servicesWithFormat={servicesWithFormat}
						setCommunication={setCommunication}
						setFormatKind={handleFormatKindChange}
						setInputName={setInputName}
						setKind={handleKindChange}
						setMode={handleModeChange}
						setName={setName}
						setOutputName={setOutputName}
						setProviderService={setProviderService}
						setRouteName={setRouteName}
						setServiceName={setServiceName}
					/>
				) : (
					<DataFormatForm
						allowKindChange={true}
						catalog={catalog}
						onChange={setDataFormatForm}
						value={dataFormatForm}
					/>
				)}
				<div className="flex justify-end gap-2">
					<Button onClick={onClose} type="button" variant="outline">
						Cancel
					</Button>
					<Button
						disabled={addDialogCreateDisabled(
							activeTab,
							consumerMode,
							isPending,
							name,
							selectedInputFormat,
							selectedProvider,
							selectedConsumerRoute
						)}
						onClick={handleCreate}
						type="button"
					>
						{isPending ? (
							<>
								<Spinner data-icon="inline-start" />
								Creating
							</>
						) : (
							"Create"
						)}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

function CommunicationTable({
	items,
	onDelete,
}: {
	items: CommunicationItem[];
	onDelete: (item: CommunicationItem) => void;
}) {
	return (
		<Table className="min-w-[1440px] table-fixed">
			<TableHeader>
				<TableRow>
					<TableHead className="w-[280px]">Name</TableHead>
					<TableHead className="w-[104px]">Kind</TableHead>
					<TableHead className="w-[116px]">Source</TableHead>
					<TableHead className="w-[136px]">Direction</TableHead>
					<TableHead className="w-[156px]">Transport</TableHead>
					<TableHead className="w-[260px]">Type</TableHead>
					<TableHead className="w-[260px]">Address</TableHead>
					<TableHead className="w-[112px] text-right">Actions</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.length === 0 ? (
					<TableRow>
						<TableCell colSpan={8}>
							<Empty className="min-h-40 border">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<Network />
									</EmptyMedia>
									<EmptyTitle>No interfaces found.</EmptyTitle>
									<EmptyDescription>
										调整筛选条件或添加新的接口/消息定义。
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						</TableCell>
					</TableRow>
				) : (
					items.map((item) => (
						<TableRow key={item.id}>
							<TableCell className="min-w-0">
								<div className="flex min-w-0 flex-col">
									<span className="truncate font-semibold">{item.name}</span>
									<span className="truncate text-muted-foreground text-xs">
										{item.path}
									</span>
								</div>
							</TableCell>
							<TableCell>
								<Badge variant="outline">{item.kind}</Badge>
							</TableCell>
							<TableCell>
								<Badge
									variant={item.source === "config" ? "default" : "secondary"}
								>
									{item.source}
								</Badge>
							</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.direction || item.role || "configured"}
								</span>
							</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.transports.join(", ") || "n/a"}
								</span>
							</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.messageType || item.format || "n/a"}
								</span>
							</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.bindings
										.map((binding) => binding.address)
										.filter(Boolean)
										.join(" | ") || "configured"}
								</span>
							</TableCell>
							<TableCell className="min-w-[112px]">
								<div className="flex justify-end gap-2 whitespace-nowrap">
									<Button
										onClick={() => onDelete(item)}
										size="sm"
										type="button"
										variant="outline"
									>
										Delete
									</Button>
								</div>
							</TableCell>
						</TableRow>
					))
				)}
			</TableBody>
		</Table>
	);
}

function DataFormatTable({
	items,
	onDelete,
}: {
	items: DataFormatItem[];
	onDelete: (item: DataFormatItem) => void;
}) {
	return (
		<Table className="min-w-[1280px] table-fixed">
			<TableHeader>
				<TableRow>
					<TableHead className="w-[260px]">Name</TableHead>
					<TableHead className="w-[112px]">Kind</TableHead>
					<TableHead className="w-[140px]">Source</TableHead>
					<TableHead className="w-[340px]">Fields</TableHead>
					<TableHead className="w-[260px]">Path</TableHead>
					<TableHead className="w-[112px] text-right">Actions</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.length === 0 ? (
					<TableRow>
						<TableCell colSpan={6}>
							<Empty className="min-h-40 border">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<Database />
									</EmptyMedia>
									<EmptyTitle>No data formats found.</EmptyTitle>
									<EmptyDescription>
										调整筛选条件或创建新的 proto、msg、srv 定义。
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						</TableCell>
					</TableRow>
				) : (
					items.map((item) => (
						<TableRow key={item.id}>
							<TableCell className="min-w-0">
								<span className="block truncate font-semibold">
									{item.name}
								</span>
							</TableCell>
							<TableCell>
								<Badge variant="outline">{item.kind}</Badge>
							</TableCell>
							<TableCell>{item.source}</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.fields
										.slice(0, 8)
										.map((field) => `${field.name}: ${field.type}`)
										.join(", ") || "no fields"}
								</span>
							</TableCell>
							<TableCell className="min-w-0">
								<span className="block truncate text-muted-foreground">
									{item.path}
								</span>
							</TableCell>
							<TableCell className="min-w-[112px]">
								<div className="flex justify-end gap-2 whitespace-nowrap">
									<Button
										onClick={() => onDelete(item)}
										size="sm"
										type="button"
										variant="outline"
									>
										Delete
									</Button>
								</div>
							</TableCell>
						</TableRow>
					))
				)}
			</TableBody>
		</Table>
	);
}

export default function ModuleDetail({ moduleName }: { moduleName: string }) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const detail = useQuery(
		trpc.dashboard.moduleDetail.queryOptions({ moduleName })
	);
	const [activeTab, setActiveTab] = useState<DetailTab>("communication");
	const [direction, setDirection] = useState<DirectionFilter>("all");
	const [kind, setKind] = useState<KindFilter>("all");
	const [transport, setTransport] = useState<TransportFilter>("all");
	const [dataKind, setDataKind] = useState<DataKindFilter>("all");
	const [query, setQuery] = useState("");
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const [pendingBuildReason, setPendingBuildReason] = useState<string | null>(
		null
	);
	const refreshDetail = () => {
		queryClient.invalidateQueries(
			trpc.dashboard.moduleDetail.queryFilter({ moduleName })
		);
		queryClient.invalidateQueries(trpc.dashboard.snapshot.queryFilter());
	};
	const buildModule = useMutation(
		trpc.dashboard.buildModule.mutationOptions({
			onSuccess: () => {
				setPendingBuildReason(null);
				refreshDetail();
			},
		})
	);
	const remindToBuild = (action: CommunicationChangeAction) => {
		const message = buildReminderMessage(moduleName);
		setPendingBuildReason(message);
		toast.warning(message, {
			action: {
				label: "Build",
				onClick: () => {
					buildModule.mutate({ moduleName });
				},
			},
			description: `接口/消息已${communicationChangeLabel(action)}。`,
		});
	};
	const deleteCommunication = useMutation(
		trpc.dashboard.deleteCommunicationItem.mutationOptions({
			onSuccess: refreshDetail,
		})
	);
	const createConsumerCommunication = useMutation(
		trpc.dashboard.createConsumerCommunicationItem.mutationOptions({
			onSuccess: refreshDetail,
		})
	);
	const createProviderCommunication = useMutation(
		trpc.dashboard.createProviderCommunicationItem.mutationOptions({
			onSuccess: refreshDetail,
		})
	);
	const createDataFormat = useMutation(
		trpc.dashboard.createDataFormatItem.mutationOptions({
			onSuccess: refreshDetail,
		})
	);
	const deleteDataFormat = useMutation(
		trpc.dashboard.deleteDataFormatItem.mutationOptions({
			onSuccess: refreshDetail,
		})
	);
	const isSaving =
		createConsumerCommunication.isPending ||
		createProviderCommunication.isPending ||
		deleteCommunication.isPending ||
		createDataFormat.isPending ||
		deleteDataFormat.isPending;

	const communicationPayload = (item: CommunicationItem) => ({
		moduleName,
		name: item.name,
		kind: item.kind,
		source: item.source,
		path: item.path,
	});
	const dataFormatPayload = (item: DataFormatItem) => ({
		moduleName,
		name: item.name,
		kind: item.kind,
		path: item.path,
	});

	const handleDeleteCommunication = (item: CommunicationItem) => {
		deleteCommunication.mutate(communicationPayload(item), {
			onSuccess: () => remindToBuild("deleted"),
		});
	};

	const handleDeleteDataFormat = (item: DataFormatItem) => {
		deleteDataFormat.mutate(dataFormatPayload(item));
	};

	const handleCreateConsumer = (input: ConsumerCommunicationInput) => {
		createConsumerCommunication.mutate(
			{
				moduleName,
				...input,
			},
			{
				onSuccess: () => {
					remindToBuild("created");
					setAddDialogOpen(false);
				},
			}
		);
	};

	const handleCreateProvider = (input: ProviderCommunicationInput) => {
		createProviderCommunication.mutate(
			{
				moduleName,
				...input,
			},
			{
				onSuccess: () => {
					remindToBuild("created");
					setAddDialogOpen(false);
				},
			}
		);
	};

	const handleCreateDataFormat = (input: CreateDataFormatInput) => {
		createDataFormat.mutate(
			{
				moduleName,
				...input,
			},
			{
				onSuccess: () => setAddDialogOpen(false),
			}
		);
	};

	const communicationItems = useMemo(() => {
		const items = detail.data?.communication ?? [];
		return items.filter(
			(item) =>
				(kind === "all" || item.kind === kind) &&
				directionMatches(item, direction) &&
				transportMatches(item, transport) &&
				containsText(
					[item.name, item.messageType, item.path, item.transports.join(" ")],
					query
				)
		);
	}, [detail.data?.communication, direction, kind, query, transport]);

	const dataFormats = useMemo(() => {
		const items = detail.data?.dataFormats ?? [];
		return items.filter(
			(item) =>
				(dataKind === "all" || item.kind === dataKind) &&
				containsText(
					[
						item.name,
						item.path,
						item.source,
						item.fields.map((field) => `${field.name} ${field.type}`).join(" "),
					],
					query
				)
		);
	}, [dataKind, detail.data?.dataFormats, query]);

	if (detail.isLoading) {
		return (
			<PageContainer
				isLoading
				pageDescription="Loading module communication and data format inventory."
				pageTitle="Module detail"
			>
				<Skeleton className="h-96 w-full" />
			</PageContainer>
		);
	}

	if (!detail.data) {
		return (
			<PageContainer>
				<Empty className="min-h-[420px] border">
					<EmptyHeader>
						<EmptyTitle>Module unavailable</EmptyTitle>
						<EmptyDescription>{detail.error?.message}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</PageContainer>
		);
	}

	return (
		<>
			<PageContainer>
				<div className="mb-5 flex min-w-0 items-start gap-3 border-b pb-4">
					<Button
						aria-label="Back to modules"
						className="mt-0.5 -ml-2"
						onClick={() => router.push("/dashboard/modules" as NextRoute)}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<ArrowLeft />
					</Button>
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
							<h1 className="truncate font-semibold text-[24px] leading-8 tracking-normal">
								{detail.data.module.name}
							</h1>
							<div className="flex shrink-0 flex-wrap items-center gap-2">
								<Badge
									variant={detail.data.configPath ? "secondary" : "outline"}
								>
									{detail.data.configPath ? "模块配置已连接" : "模块配置未连接"}
								</Badge>
								<Badge variant="outline">共享接口目录已连接</Badge>
							</div>
						</div>
						<p className="truncate text-muted-foreground text-sm leading-5">
							{detail.data.module.root}
						</p>
					</div>
				</div>
				<Tabs
					className="min-h-[620px]"
					onValueChange={(value) => setActiveTab(value as DetailTab)}
					value={activeTab}
				>
					<Card>
						<CardHeader>
							<CardTitle>
								{activeTab === "communication"
									? "Communication Interfaces"
									: "Data Formats"}
							</CardTitle>
							<CardAction>
								<Button
									onClick={() => setAddDialogOpen(true)}
									size="sm"
									type="button"
								>
									<Plus data-icon="inline-start" />
									Add
								</Button>
							</CardAction>
							<CardDescription>
								{activeTab === "communication"
									? "Filter capabilities this module uses or provides."
									: "Filter proto, msg, srv, and dds_idl data formats available to interfaces."}
							</CardDescription>
							<TabsList className="mt-2">
								<TabsTrigger value="communication">
									<Network data-icon="inline-start" />
									接口/消息
								</TabsTrigger>
								<TabsTrigger value="data">
									<Database data-icon="inline-start" />
									数据格式
								</TabsTrigger>
							</TabsList>
						</CardHeader>
						<CardContent>
							<div className="flex flex-col gap-4">
								<TabsContent
									className="flex flex-col gap-4"
									value="communication"
								>
									{pendingBuildReason ? (
										<Alert>
											<CircleAlert />
											<AlertTitle>需要 Build</AlertTitle>
											<AlertDescription>{pendingBuildReason}</AlertDescription>
											<AlertAction>
												<Button
													disabled={buildModule.isPending}
													onClick={() => buildModule.mutate({ moduleName })}
													size="xs"
													type="button"
													variant="outline"
												>
													{buildModule.isPending ? (
														<>
															<Spinner data-icon="inline-start" />
															Building
														</>
													) : (
														"Build"
													)}
												</Button>
											</AlertAction>
										</Alert>
									) : null}
									<div className="grid gap-3 md:grid-cols-4">
										<AppSelect
											label="方向/角色"
											onValueChange={setDirection}
											options={[
												{ label: "全部", value: "all" },
												{
													label: "subscribe/client",
													value: "subscribe-client",
												},
												{ label: "publish/server", value: "publish-server" },
											]}
											value={direction}
										/>
										<AppSelect
											label="service/topic"
											onValueChange={setKind}
											options={[
												{ label: "全部", value: "all" },
												{ label: "service", value: "service" },
												{ label: "topic", value: "topic" },
											]}
											value={kind}
										/>
										<AppSelect
											label="通信方式"
											onValueChange={setTransport}
											options={[
												{ label: "全部", value: "all" },
												{ label: "ROS2", value: "ros2" },
												{ label: "NATS", value: "nats" },
												{ label: "CycloneDDS", value: "cyclonedds" },
												{ label: "FastDDS", value: "fastdds" },
											]}
											value={transport}
										/>
										<Field>
											<FieldLabel>模糊匹配</FieldLabel>
											<Input
												onChange={(event) => setQuery(event.target.value)}
												placeholder="service/topic name"
												value={query}
											/>
										</Field>
									</div>
									<CommunicationTable
										items={communicationItems}
										onDelete={handleDeleteCommunication}
									/>
								</TabsContent>
								<TabsContent className="flex flex-col gap-4" value="data">
									<div className="grid gap-3 md:grid-cols-[220px_1fr]">
										<AppSelect
											label="格式"
											onValueChange={setDataKind}
											options={[
												{ label: "全部", value: "all" },
												{ label: "proto", value: "proto" },
												{ label: "msg", value: "msg" },
												{ label: "srv", value: "srv" },
												{ label: "dds_idl", value: "dds_idl" },
											]}
											value={dataKind}
										/>
										<Field>
											<FieldLabel>模糊匹配</FieldLabel>
											<Input
												onChange={(event) => setQuery(event.target.value)}
												placeholder="message, field, or file name"
												value={query}
											/>
										</Field>
									</div>
									<DataFormatTable
										items={dataFormats}
										onDelete={handleDeleteDataFormat}
									/>
								</TabsContent>
							</div>
						</CardContent>
					</Card>
				</Tabs>
			</PageContainer>
			{addDialogOpen ? (
				<AddInterfaceDialog
					activeTab={activeTab}
					catalog={detail.data.dataFormatCatalog}
					currentServiceName={serviceNameFromModuleRoot(
						detail.data.module.root
					)}
					isPending={isSaving}
					onClose={() => setAddDialogOpen(false)}
					onCreateConsumer={handleCreateConsumer}
					onCreateDataFormat={handleCreateDataFormat}
					onCreateProvider={handleCreateProvider}
					publicInterfaceCatalog={detail.data.publicInterfaceCatalog}
				/>
			) : null}
		</>
	);
}
