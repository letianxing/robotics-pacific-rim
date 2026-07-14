"use client";

import type {
	DashboardSnapshot,
	RobotProfileCatalog,
} from "@dashboard/api/routers/dashboard";
import { Alert, AlertDescription } from "@dashboard/ui/components/alert";
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
	FieldError,
	FieldGroup,
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
import { cn } from "@dashboard/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Background,
	Controls,
	type Edge,
	type Node,
	Position,
	ReactFlow,
} from "@xyflow/react";
import {
	Activity,
	ArrowUpRight,
	Bot,
	Boxes,
	CircleAlert,
	CircleDot,
	GitBranch,
	Layers,
	Network,
	Plus,
	RadioTower,
	Route,
	Server,
} from "lucide-react";
import type { Route as NextRoute } from "next";
import { useRouter } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";
import { useId, useState } from "react";

import { PageContainer } from "@/components/layout/page-container";
import { DataTable, type DataTableRow } from "@/components/service-ops-table";
import { trpc } from "@/utils/trpc";

type ModuleSummary = DashboardSnapshot["modules"][number];
type CommunicationRoute = DashboardSnapshot["communication"]["routes"][number];
type RobotProfileSummary = RobotProfileCatalog["profiles"][number];
type ServiceNodeTone = "consumer" | "isolated" | "provider" | "transport";

interface RouteReference {
	routeName: string;
	serviceName: string;
}

interface ServiceCallRoute {
	direction: string;
	route: CommunicationRoute;
	targetRouteName: string;
}

interface ServiceCallRelationship {
	id: string;
	routes: ServiceCallRoute[];
	sourceService: string;
	targetService: string;
	transports: string[];
}

interface ServiceCallStats {
	incoming: number;
	module: ModuleSummary;
	outgoing: number;
	routeCount: number;
	serviceName: string;
}

interface ServiceCallEndpoints {
	sourceService: string;
	targetService: string;
}

interface RouteFlowNodeContent {
	detail: string;
	label: string;
	meta: string;
	tone: ServiceNodeTone;
}

interface RouteFlowNodeData extends Record<string, unknown> {
	label: ReactNode;
	tone: RouteFlowNodeContent["tone"];
}

type RouteFlowNode = Node<RouteFlowNodeData>;
type RouteFlowEdge = Edge<{ label: string }>;

interface RouteFlowGraph {
	edges: RouteFlowEdge[];
	nodes: RouteFlowNode[];
}

interface ServiceCallGraph extends RouteFlowGraph {
	externalCount: number;
	relationshipCount: number;
	serviceCount: number;
}
export type DashboardView =
	| "overview"
	| "modules"
	| "robots"
	| "communication"
	| "observability"
	| "routes"
	| "settings";

const viewCopy: Record<
	DashboardView,
	{
		description: string;
		title: string;
	}
> = {
	overview: {
		description:
			"Read-only project, communication, and observability snapshot.",
		title: "Operations dashboard",
	},
	modules: {
		description: "Module inventory, runtime templates, and build actions.",
		title: "Modules",
	},
	robots: {
		description: "Robot capability catalog and deployable module profiles.",
		title: "Robots",
	},
	communication: {
		description: "Transport mix and route bindings from module configs.",
		title: "Communication",
	},
	observability: {
		description: "Local readiness checks and quick links for the stack.",
		title: "Observability",
	},
	routes: {
		description: "Service call graph across module communication configs.",
		title: "Route Matrix",
	},
	settings: {
		description: "Dashboard shell and workspace configuration summary.",
		title: "Settings",
	},
};

const compactNumber = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

const MODULE_PROJECT_PREFIX_REGEX = /^module-/;
const SNAPSHOT_REFETCH_INTERVAL_MS = 2000;

const formatCount = (value: number): string => compactNumber.format(value);

const statusVariant = (
	status: string
): ComponentProps<typeof Badge>["variant"] => {
	if (status === "online") {
		return "default";
	}
	if (status === "degraded" || status === "observer-pending") {
		return "secondary";
	}
	return "outline";
};

const transportLabel = (route: CommunicationRoute): string =>
	route.bindings.map((binding) => binding.transport).join(" -> ");

const addressLabel = (route: CommunicationRoute): string =>
	route.bindings
		.map((binding) => binding.address)
		.filter(Boolean)
		.join(" | ");

const normalizedDirection = (route: CommunicationRoute): string => {
	const directions = [
		route.direction,
		...route.bindings.map((binding) => binding.direction),
	]
		.map((direction) => direction.trim().toLowerCase())
		.filter(Boolean);

	return directions[0] ?? "";
};

const serviceNameFromModule = (module: ModuleSummary): string => {
	const pathParts = module.root
		.replaceAll("\\", "/")
		.split("/")
		.filter(Boolean);
	return (
		pathParts.at(-1) ?? module.name.replace(MODULE_PROJECT_PREFIX_REGEX, "")
	);
};

const serviceNameFromRouteModule = (
	moduleName: string,
	modulesByName: Map<string, ModuleSummary>
): string => {
	const module = modulesByName.get(moduleName);
	return module
		? serviceNameFromModule(module)
		: moduleName.replace(MODULE_PROJECT_PREFIX_REGEX, "");
};

const parseRouteReference = (value: string): RouteReference | null => {
	const parts = value.trim().split(".");
	const serviceName = parts.shift();
	const routeName = parts.join(".");
	if (!(serviceName && routeName)) {
		return null;
	}
	return { routeName, serviceName };
};

const isDependencyRoute = (direction: string): boolean =>
	direction.includes("client") ||
	direction.includes("subscribe") ||
	direction.includes("consumer") ||
	direction.includes("request") ||
	direction.includes("use");

const serviceCallTone = (stats: ServiceCallStats): ServiceNodeTone => {
	if (stats.incoming > 0 && stats.outgoing > 0) {
		return "transport";
	}
	if (stats.outgoing > 0) {
		return "consumer";
	}
	if (stats.incoming > 0) {
		return "provider";
	}
	return "isolated";
};

const serviceCallColumn = (stats: ServiceCallStats): number => {
	if (stats.outgoing > 0 && stats.incoming === 0) {
		return 0;
	}
	if (stats.outgoing > 0 && stats.incoming > 0) {
		return 1;
	}
	if (stats.incoming > 0) {
		return 2;
	}
	return 3;
};

const routeFlowNodeClass = (tone: RouteFlowNodeContent["tone"]): string =>
	cn(
		"w-[320px] rounded-lg border bg-card px-4 py-3 text-left shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_10%,transparent)]",
		tone === "consumer" &&
			"border-sky-200/80 bg-sky-50/70 dark:border-sky-900/50 dark:bg-sky-950/20",
		tone === "transport" && "border-border/70 bg-muted/55",
		tone === "provider" &&
			"border-emerald-200/80 bg-emerald-50/65 dark:border-emerald-900/50 dark:bg-emerald-950/20",
		tone === "isolated" && "border-border/60 bg-card/75"
	);

const routeFlowNodeLabel = (data: RouteFlowNodeContent) => (
	<div className={routeFlowNodeClass(data.tone)}>
		<div className="flex min-w-0 items-start justify-between gap-3">
			<div className="truncate font-semibold text-sm leading-5">
				{data.label}
			</div>
			<div
				className={cn(
					"mt-0.5 size-2 shrink-0 rounded-full",
					data.tone === "consumer" && "bg-sky-500",
					data.tone === "provider" && "bg-emerald-500",
					data.tone === "transport" && "bg-primary",
					data.tone === "isolated" && "bg-muted-foreground/45"
				)}
			/>
		</div>
		<div className="mt-1 truncate text-muted-foreground text-xs">
			{data.meta}
		</div>
		<div className="mt-2 truncate text-[11px] text-muted-foreground/90">
			{data.detail}
		</div>
	</div>
);

const routeFlowEdge = ({
	id,
	label,
	source,
	target,
}: {
	id: string;
	label: string;
	source: string;
	target: string;
}): RouteFlowEdge => ({
	id,
	source,
	target,
	type: "smoothstep",
	label,
	style: {
		stroke: "color-mix(in oklab, var(--muted-foreground) 62%, transparent)",
		strokeWidth: 1.8,
	},
	labelBgBorderRadius: 999,
	labelBgPadding: [8, 4],
	labelBgStyle: {
		fill: "var(--card)",
		fillOpacity: 0.96,
	},
	labelStyle: {
		fill: "var(--muted-foreground)",
		fontSize: 11,
		fontWeight: 600,
	},
});

const relationshipLabel = (relationship: ServiceCallRelationship): string => {
	const routeNames = [
		...new Set(relationship.routes.map((route) => route.targetRouteName)),
	];
	if (routeNames.length === 1 && relationship.routes.length === 1) {
		return `${relationship.routes[0]?.route.kind}: ${routeNames[0]}`;
	}
	return `${formatCount(relationship.routes.length)} routes`;
};

const routeFlowNodeType = (tone: ServiceNodeTone): RouteFlowNode["type"] => {
	if (tone === "consumer") {
		return "input";
	}
	if (tone === "provider") {
		return "output";
	}
	return "default";
};

const buildServiceCallIndexes = (snapshot: DashboardSnapshot) => {
	const serviceModules = snapshot.modules.filter((module) =>
		module.root.replaceAll("\\", "/").startsWith("module/service/")
	);
	const modules = serviceModules.length > 0 ? serviceModules : snapshot.modules;
	const modulesByName = new Map(
		snapshot.modules.map((module) => [module.name, module])
	);
	const statsByService = new Map<string, ServiceCallStats>();

	for (const module of modules) {
		const serviceName = serviceNameFromModule(module);
		statsByService.set(serviceName, {
			incoming: 0,
			module,
			outgoing: 0,
			routeCount: 0,
			serviceName,
		});
	}

	return { modulesByName, statsByService };
};

const serviceCallEndpoints = ({
	direction,
	reference,
	route,
	routeService,
}: {
	direction: string;
	reference: RouteReference;
	route: CommunicationRoute;
	routeService: string;
}): ServiceCallEndpoints | null => {
	if (routeService === reference.serviceName) {
		return null;
	}
	if (route.kind === "topic" && direction.includes("subscribe")) {
		return {
			sourceService: reference.serviceName,
			targetService: routeService,
		};
	}
	return {
		sourceService: routeService,
		targetService: reference.serviceName,
	};
};

const buildServiceRelationships = ({
	modulesByName,
	routes,
	statsByService,
}: {
	modulesByName: Map<string, ModuleSummary>;
	routes: CommunicationRoute[];
	statsByService: Map<string, ServiceCallStats>;
}) => {
	const relationshipsById = new Map<string, ServiceCallRelationship>();
	let externalCount = 0;

	for (const route of routes) {
		const direction = normalizedDirection(route);
		if (!isDependencyRoute(direction)) {
			continue;
		}

		const reference = parseRouteReference(route.messageType);
		if (!reference) {
			continue;
		}

		const routeService = serviceNameFromRouteModule(
			route.module,
			modulesByName
		);
		const endpoints = serviceCallEndpoints({
			direction,
			reference,
			route,
			routeService,
		});
		if (!endpoints) {
			continue;
		}

		if (
			!(
				statsByService.has(endpoints.sourceService) &&
				statsByService.has(endpoints.targetService)
			)
		) {
			externalCount += 1;
			continue;
		}

		const id = `${endpoints.sourceService}->${endpoints.targetService}`;
		const relationship =
			relationshipsById.get(id) ??
			({
				id,
				routes: [],
				sourceService: endpoints.sourceService,
				targetService: endpoints.targetService,
				transports: [],
			} satisfies ServiceCallRelationship);

		relationship.routes.push({
			direction: direction || "configured",
			route,
			targetRouteName: reference.routeName,
		});

		for (const binding of route.bindings) {
			if (
				binding.transport &&
				!relationship.transports.includes(binding.transport)
			) {
				relationship.transports.push(binding.transport);
			}
		}
		relationshipsById.set(id, relationship);
	}

	return {
		relationships: [...relationshipsById.values()].sort((left, right) =>
			left.id.localeCompare(right.id)
		),
		externalCount,
	};
};

const applyRelationshipStats = (
	relationships: ServiceCallRelationship[],
	statsByService: Map<string, ServiceCallStats>
): void => {
	for (const relationship of relationships) {
		const sourceStats = statsByService.get(relationship.sourceService);
		const targetStats = statsByService.get(relationship.targetService);
		if (!(sourceStats && targetStats)) {
			continue;
		}
		sourceStats.outgoing += relationship.routes.length;
		sourceStats.routeCount += relationship.routes.length;
		targetStats.incoming += relationship.routes.length;
		targetStats.routeCount += relationship.routes.length;
	}
};

const buildServiceColumns = (
	statsByService: Map<string, ServiceCallStats>
): ServiceCallStats[][] => {
	const columns: ServiceCallStats[][] = [[], [], [], []];
	const sortedStats = [...statsByService.values()].sort((left, right) => {
		const leftColumn = serviceCallColumn(left);
		const rightColumn = serviceCallColumn(right);
		if (leftColumn !== rightColumn) {
			return leftColumn - rightColumn;
		}
		if (left.routeCount !== right.routeCount) {
			return right.routeCount - left.routeCount;
		}
		return left.serviceName.localeCompare(right.serviceName);
	});

	for (const stats of sortedStats) {
		columns[serviceCallColumn(stats)]?.push(stats);
	}

	return columns;
};

const buildServiceNodes = (columns: ServiceCallStats[][]): RouteFlowNode[] => {
	const nodes: RouteFlowNode[] = [];
	const columnWidth = 390;
	const rowHeight = 120;

	columns.forEach((statsColumn, columnIndex) => {
		statsColumn.forEach((stats, rowIndex) => {
			const tone = serviceCallTone(stats);
			nodes.push({
				id: stats.serviceName,
				type: routeFlowNodeType(tone),
				position: {
					x: columnIndex * columnWidth,
					y: rowIndex * rowHeight,
				},
				sourcePosition: Position.Right,
				targetPosition: Position.Left,
				style: {
					background: "transparent",
					border: 0,
					boxShadow: "none",
					padding: 0,
					width: 320,
				},
				data: {
					label: routeFlowNodeLabel({
						label: stats.serviceName,
						meta: `${formatCount(stats.outgoing)} out / ${formatCount(stats.incoming)} in`,
						detail: stats.module.name,
						tone,
					}),
					tone,
				},
				draggable: true,
			});
		});
	});

	return nodes;
};

const buildServiceCallGraph = (
	snapshot: DashboardSnapshot
): ServiceCallGraph => {
	const { modulesByName, statsByService } = buildServiceCallIndexes(snapshot);
	const { externalCount, relationships } = buildServiceRelationships({
		modulesByName,
		routes: snapshot.communication.routes,
		statsByService,
	});
	applyRelationshipStats(relationships, statsByService);
	const nodes = buildServiceNodes(buildServiceColumns(statsByService));

	const edges = relationships.map((relationship) =>
		routeFlowEdge({
			id: relationship.id,
			label: relationshipLabel(relationship),
			source: relationship.sourceService,
			target: relationship.targetService,
		})
	);

	return {
		edges,
		externalCount,
		nodes,
		relationshipCount: relationships.length,
		serviceCount: statsByService.size,
	};
};

const moduleTypeLabel = (project: ModuleSummary): string =>
	project.tags.find((tag) => tag.startsWith("type:"))?.replace("type:", "") ??
	"module";

const moduleTypeBadgeClass = (type: string): string => {
	if (type === "robot-behavior") {
		return "border-sky-200/80 bg-sky-50/90 text-sky-800";
	}
	if (type === "robot-hardware") {
		return "border-amber-200/80 bg-amber-50/90 text-amber-800";
	}
	if (type === "internal-state") {
		return "border-violet-200/80 bg-violet-50/90 text-violet-800";
	}
	return "border-border/70 bg-muted/70 text-muted-foreground";
};

const moduleTypeDotClass = (type: string): string => {
	if (type === "robot-behavior") {
		return "bg-sky-500 ring-sky-100";
	}
	if (type === "robot-hardware") {
		return "bg-amber-500 ring-amber-100";
	}
	if (type === "internal-state") {
		return "bg-violet-500 ring-violet-100";
	}
	return "bg-muted-foreground ring-muted";
};

const moduleNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const uppercasePattern = /[A-Z]/;
const pureNumericModuleNamePattern = /^\d+(?:-\d+)*$/;

const moduleNameWarning = (value: string): string => {
	const name = value.trim();
	if (!name) {
		return "请输入 module 名，例如 action-planner。";
	}
	if (uppercasePattern.test(name)) {
		return "命名不能包含大写字母。";
	}
	if (
		!moduleNamePattern.test(name) ||
		pureNumericModuleNamePattern.test(name)
	) {
		return "使用 lowercase kebab-case：字母开头，只能包含小写字母、数字和单横线。";
	}
	return "";
};

const toServiceName = (value: string): string => {
	const packageName = value.trim().replaceAll("-", "_");
	return packageName.endsWith("_service")
		? packageName
		: `${packageName}_service`;
};

function LoadingDashboard() {
	return (
		<PageContainer
			isLoading
			pageDescription="Read-only project, communication, and observability snapshot."
			pageTitle="Operations dashboard"
		>
			<div className="grid gap-3 md:grid-cols-4">
				{["modules", "routes", "bindings", "health"].map((item) => (
					<Card key={item}>
						<CardHeader>
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-6 w-16" />
						</CardHeader>
					</Card>
				))}
			</div>
			<Skeleton className="h-80 w-full" />
		</PageContainer>
	);
}

function OverviewHero({ snapshot }: { snapshot: DashboardSnapshot }) {
	return (
		<section className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.85fr)]">
			<Card className="relative overflow-hidden border-primary/10 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--card)_94%,white),color-mix(in_oklab,var(--accent)_24%,var(--card)))]">
				<div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 bg-[radial-gradient(circle_at_100%_16%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_52%)]" />
				<CardHeader>
					<CardTitle className="text-lg">Pacific-Rim Control Surface</CardTitle>
					<CardDescription className="max-w-2xl">
						Workspace inventory, route bindings, and local stack readiness are
						grouped into one operational surface.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="rounded-lg border border-border/60 bg-card/70 px-4 py-3 shadow-xs">
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Boxes data-icon="inline-start" />
								Runtime
							</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{formatCount(snapshot.overview.runtimeModuleCount)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-card/70 px-4 py-3 shadow-xs">
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Route data-icon="inline-start" />
								Routes
							</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{formatCount(snapshot.overview.routeCount)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-card/70 px-4 py-3 shadow-xs">
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Activity data-icon="inline-start" />
								Online
							</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{formatCount(snapshot.overview.onlineObservabilityCount)}/5
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Workspace Status</CardTitle>
					<CardDescription>
						The left navigation mirrors the starter dashboard shell and keeps
						module operations one click away.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap gap-2">
						<Badge variant="secondary">
							{snapshot.communication.transports.length} transports
						</Badge>
						<Badge variant="outline">
							{snapshot.overview.issueCount} issues
						</Badge>
						<Badge variant="outline">{snapshot.modules.length} modules</Badge>
					</div>
				</CardContent>
			</Card>
		</section>
	);
}

function MetricCard({
	title,
	value,
	description,
	icon: Icon,
}: {
	title: string;
	value: string;
	description: string;
	icon: typeof Activity;
}) {
	return (
		<Card className="transition-transform hover:-translate-y-0.5">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardAction>
					<div className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
						<Icon data-icon="inline-start" />
					</div>
				</CardAction>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="font-semibold text-3xl leading-none tracking-normal">
					{value}
				</div>
			</CardContent>
		</Card>
	);
}

function ModuleTypeBadge({ type }: { type: string }) {
	return (
		<Badge className={moduleTypeBadgeClass(type)} variant="outline">
			{type}
		</Badge>
	);
}

function RuntimeStatus({ runtime }: { runtime: boolean }) {
	if (!runtime) {
		return <span className="text-muted-foreground text-sm">static</span>;
	}
	return (
		<span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
			<CircleDot
				className="text-emerald-600 drop-shadow-[0_0_8px_color-mix(in_oklab,oklch(0.7_0.16_150)_45%,transparent)]"
				data-icon="inline-start"
			/>
			runtime
		</span>
	);
}

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
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	);
}

function SelectField<T extends string>({
	id,
	label,
	onValueChange,
	options,
	value,
}: {
	id: string;
	label: string;
	onValueChange: (value: T) => void;
	options: Array<{ label: string; value: T }>;
	value: T;
}) {
	const triggerId = useId();

	return (
		<Field>
			<FieldLabel htmlFor={triggerId}>{label}</FieldLabel>
			<Select
				id={id}
				onValueChange={(nextValue) => {
					if (nextValue) {
						onValueChange(nextValue as T);
					}
				}}
				value={value}
			>
				<SelectTrigger className="w-full" id={triggerId}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="start" className="w-(--anchor-width)">
					<SelectGroup>
						{options.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	);
}

function CreateModuleDialog({ onClose }: { onClose: () => void }) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [ros2, setRos2] = useState<"cpp" | "go" | "python">("cpp");
	const [ros2Version, setRos2Version] = useState<
		"humble" | "jazzy" | "kilted" | "lyrical" | "rolling"
	>("jazzy");
	const warning = moduleNameWarning(name);
	const createModule = useMutation(
		trpc.dashboard.createModule.mutationOptions({
			onSuccess: (result) => {
				queryClient.invalidateQueries(trpc.dashboard.snapshot.queryFilter());
				onClose();
				router.push(
					`/dashboard/modules/${encodeURIComponent(pathModuleName(result.moduleRoot))}` as NextRoute
				);
			},
		})
	);

	return (
		<Modal onClose={onClose} title="Create Module">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (warning || createModule.isPending) {
						return;
					}
					createModule.mutate({ name: name.trim(), ros2, ros2Version });
				}}
			>
				<FieldGroup>
					<Field data-invalid={warning ? "true" : undefined}>
						<FieldLabel htmlFor="module-name">Module name</FieldLabel>
						<Input
							aria-invalid={Boolean(warning)}
							id="module-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="action-planner"
							value={name}
						/>
						{warning ? (
							<FieldError>{warning}</FieldError>
						) : (
							<FieldDescription>
								将执行 node bin/create.mjs module {name.trim()}，目录为
								module/service/{toServiceName(name)}。
							</FieldDescription>
						)}
					</Field>
					<div className="grid gap-3 sm:grid-cols-2">
						<SelectField
							id="module-language"
							label="Runtime template"
							onValueChange={setRos2}
							options={[
								{ label: "ROS2 C++", value: "cpp" },
								{ label: "ROS2 Python", value: "python" },
								{ label: "ROS2 Go", value: "go" },
							]}
							value={ros2}
						/>
						<SelectField
							id="module-distro"
							label="ROS2 distro"
							onValueChange={setRos2Version}
							options={[
								{ label: "jazzy", value: "jazzy" },
								{ label: "humble", value: "humble" },
								{ label: "kilted", value: "kilted" },
								{ label: "lyrical", value: "lyrical" },
								{ label: "rolling", value: "rolling" },
							]}
							value={ros2Version}
						/>
					</div>
					{createModule.error ? (
						<Alert variant="destructive">
							<AlertDescription>{createModule.error.message}</AlertDescription>
						</Alert>
					) : null}
					<div className="flex justify-end gap-2">
						<Button onClick={onClose} type="button" variant="outline">
							Cancel
						</Button>
						<Button
							disabled={Boolean(warning) || createModule.isPending}
							type="submit"
						>
							{createModule.isPending ? (
								<>
									<Spinner data-icon="inline-start" />
									Creating
								</>
							) : (
								"Create"
							)}
						</Button>
					</div>
				</FieldGroup>
			</form>
		</Modal>
	);
}

const pathModuleName = (moduleRoot: string): string =>
	moduleRoot.split("/").filter(Boolean).at(-1) ?? moduleRoot;

function Overview({ snapshot }: { snapshot: DashboardSnapshot }) {
	const { overview } = snapshot;
	const hasIssues = overview.issueCount > 0;

	return (
		<section className="flex flex-col gap-4" id="observability">
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<MetricCard
					description={`${formatCount(overview.criticalModuleCount)} critical modules tracked`}
					icon={Server}
					title="Runtime Modules"
					value={formatCount(overview.runtimeModuleCount)}
				/>
				<MetricCard
					description={`${formatCount(overview.serviceRouteCount)} RPC, ${formatCount(overview.topicRouteCount)} topics`}
					icon={Route}
					title="Communication Routes"
					value={formatCount(overview.routeCount)}
				/>
				<MetricCard
					description="Configured ROS2/NATS/CycloneDDS surfaces"
					icon={Network}
					title="Route Bindings"
					value={formatCount(overview.bindingCount)}
				/>
				<MetricCard
					description={
						hasIssues
							? `${formatCount(overview.issueCount)} local endpoint issues`
							: "local stack is reachable"
					}
					icon={Activity}
					title="Observability"
					value={`${formatCount(overview.onlineObservabilityCount)}/5`}
				/>
			</div>

			<div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
				<Card>
					<CardHeader>
						<CardTitle>Key Exceptions</CardTitle>
						<CardDescription>
							Local readiness checks for the observability stack and collector.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{overview.issues.length === 0 ? (
							<Empty className="min-h-32 border border-dashed">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<Activity />
									</EmptyMedia>
									<EmptyTitle>No readiness issues detected.</EmptyTitle>
									<EmptyDescription>
										Local observability endpoints are reachable.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<div className="flex flex-col gap-2">
								{overview.issues.map((issue) => (
									<div
										className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5"
										key={`${issue.title}:${issue.source}`}
									>
										<div className="min-w-0">
											<div className="flex items-center gap-2 font-medium">
												<CircleAlert data-icon="inline-start" />
												<span className="truncate">{issue.title}</span>
											</div>
											<div className="truncate text-muted-foreground">
												{issue.detail}
											</div>
										</div>
										<Badge variant="outline">{issue.severity}</Badge>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Quick Links</CardTitle>
						<CardDescription>
							Jump to deeper logs, traces, metrics, and dashboards.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="grid gap-2 sm:grid-cols-2">
							{overview.quickLinks.map((link) => (
								<Button
									key={link.id}
									nativeButton={false}
									render={
										<a
											href={link.href}
											rel="noreferrer noopener"
											target="_blank"
										>
											{link.label}
											<ArrowUpRight data-icon="inline-end" />
										</a>
									}
									variant="outline"
								/>
							))}
						</div>
					</CardContent>
				</Card>
			</div>
		</section>
	);
}

const moduleUrlName = (project: ModuleSummary): string =>
	project.root.split("/").filter(Boolean).at(-1) ?? project.name;

function Modules({
	modules,
	onCreate,
}: {
	modules: ModuleSummary[];
	onCreate: () => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const buildModule = useMutation(
		trpc.dashboard.buildModule.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries(trpc.dashboard.snapshot.queryFilter());
			},
		})
	);
	const displayedModules = [...modules].sort(
		(left, right) =>
			Number(right.critical) - Number(left.critical) ||
			left.root.localeCompare(right.root)
	);
	const buildButton = (project: ModuleSummary) =>
		(() => {
			const moduleName = moduleUrlName(project);
			const isBuilding =
				buildModule.isPending &&
				buildModule.variables?.moduleName === moduleName;

			return (
				<Button
					aria-label={`Build ${project.name}`}
					className="rounded-lg"
					disabled={buildModule.isPending}
					onClick={(event) => {
						event.stopPropagation();
						buildModule.mutate({
							moduleName,
						});
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					{isBuilding ? (
						<>
							<Spinner data-icon="inline-start" />
							Building
						</>
					) : (
						"Build"
					)}
				</Button>
			);
		})();
	const moduleRows: DataTableRow[] = displayedModules.map((project) => {
		const href = `/dashboard/modules/${encodeURIComponent(moduleUrlName(project))}`;
		const type = moduleTypeLabel(project);
		const runtime = project.runtime ? "runtime" : "static";
		const stackLabel =
			[...project.languages, ...project.frameworks].join(", ") || "n/a";
		const compactStackLabel =
			[...project.languages, ...project.frameworks].slice(0, 3).join(", ") ||
			"n/a";
		const targetLabel = project.targetNames.join(", ") || "none";

		return {
			actions: buildButton(project),
			cells: [
				<div className="flex min-w-0 items-start gap-3" key="module">
					<span
						className={cn(
							"mt-1.5 size-2 rounded-full ring-4",
							moduleTypeDotClass(type)
						)}
					/>
					<div className="flex min-w-0 flex-col">
						<span className="block truncate font-semibold">{project.name}</span>
						<span
							className="block truncate text-muted-foreground/70 text-xs"
							title={project.root}
						>
							{project.root}
						</span>
					</div>
				</div>,
				<ModuleTypeBadge key="type" type={type} />,
				<RuntimeStatus key="runtime" runtime={project.runtime} />,
				<span
					className="block truncate text-muted-foreground"
					key="stack"
					title={stackLabel}
				>
					{compactStackLabel}
				</span>,
				<span
					className="font-mono text-[13px] text-muted-foreground"
					key="deps"
				>
					{formatCount(project.dependencyCount)}
				</span>,
				<span
					className="block truncate text-muted-foreground"
					key="targets"
					title={targetLabel}
				>
					{targetLabel}
				</span>,
			],
			columnValues: {
				Deps: formatCount(project.dependencyCount),
				Module: `${project.name} ${project.root}`,
				Runtime: runtime,
				Stack: compactStackLabel,
				Targets: targetLabel,
				Type: type,
			},
			detailAriaLabel: `Open ${project.name}`,
			id: project.name,
			onClick: () => router.push(href as NextRoute),
			searchText: `${project.name} ${project.root} ${type} ${runtime} ${stackLabel} ${targetLabel}`,
		};
	});

	return (
		<section className="grid gap-6" id="modules">
			<DataTable
				columnAlignments={{
					Actions: "right",
					Deps: "center",
				}}
				columns={["Module", "Type", "Runtime", "Stack", "Deps", "Targets"]}
				description={
					buildModule.data?.command ??
					buildModule.error?.message ??
					"Critical modules first; static inventory until CI/runtime probes are connected."
				}
				filterLabels={["Type", "Runtime", "Stack"]}
				headerAction={
					<Button
						className="rounded-lg shadow-xs"
						onClick={onCreate}
						size="sm"
						type="button"
					>
						<Plus data-icon="inline-start" />
						Create
					</Button>
				}
				rows={moduleRows}
				title={`${displayedModules.length} Modules`}
			/>
		</section>
	);
}

function TransportMix({ snapshot }: { snapshot: DashboardSnapshot }) {
	const { communication } = snapshot;

	return (
		<section className="grid gap-4 xl:grid-cols-[360px_1fr]">
			<Card>
				<CardHeader>
					<CardTitle>Transport Mix</CardTitle>
					<CardDescription>
						{communication.metricsState === "prometheus-online"
							? "Prometheus is reachable; observer metrics can be layered next."
							: "Static route snapshot; dynamic observer metrics are pending."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-2">
						{communication.transports.map((transport) => (
							<div
								className="flex items-center justify-between rounded-lg border border-border/60 bg-card/70 px-3 py-3 shadow-xs"
								key={transport.name}
							>
								<div className="flex items-center gap-2">
									<RadioTower data-icon="inline-start" />
									<span className="font-medium">{transport.name}</span>
								</div>
								<div className="text-muted-foreground">
									{formatCount(transport.routes)} routes /{" "}
									{formatCount(transport.bindings)} bindings
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Communication Summary</CardTitle>
					<CardDescription>
						Configured transport families and binding volume.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-4">
							<div className="text-muted-foreground text-sm">Transports</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{formatCount(communication.transports.length)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-4">
							<div className="text-muted-foreground text-sm">Routes</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{formatCount(communication.routes.length)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-4">
							<div className="text-muted-foreground text-sm">State</div>
							<div className="mt-2 font-semibold text-2xl leading-none">
								{communication.metricsState === "prometheus-online"
									? "online"
									: "static"}
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
		</section>
	);
}

function RouteMatrix({ snapshot }: { snapshot: DashboardSnapshot }) {
	const displayedRoutes = snapshot.communication.routes.slice(0, 16);
	const serviceGraph = buildServiceCallGraph(snapshot);

	return (
		<section className="flex flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Service Call Graph</CardTitle>
					<CardDescription>
						Analyzed from all module/service communication references.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
							<div className="text-muted-foreground text-xs">
								Module services
							</div>
							<div className="mt-1 font-semibold text-xl leading-none">
								{formatCount(serviceGraph.serviceCount)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
							<div className="text-muted-foreground text-xs">
								Call relations
							</div>
							<div className="mt-1 font-semibold text-xl leading-none">
								{formatCount(serviceGraph.relationshipCount)}
							</div>
						</div>
						<div className="rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
							<div className="text-muted-foreground text-xs">External refs</div>
							<div className="mt-1 font-semibold text-xl leading-none">
								{formatCount(serviceGraph.externalCount)}
							</div>
						</div>
					</div>
					<div className="route-flow-surface h-[540px] overflow-hidden rounded-xl border border-border/70 bg-background">
						<ReactFlow
							colorMode="system"
							edges={serviceGraph.edges}
							fitView
							fitViewOptions={{ padding: 0.1 }}
							maxZoom={1.25}
							minZoom={0.4}
							nodes={serviceGraph.nodes}
							nodesConnectable={false}
							nodesDraggable
							nodesFocusable
							panOnDrag
							proOptions={{ hideAttribution: true }}
						>
							<Background gap={20} />
							<Controls showInteractive={false} />
						</ReactFlow>
					</div>
					<style global jsx>{`
						.route-flow-surface .react-flow__node {
							background: transparent;
							border: 0;
							box-shadow: none;
							padding: 0;
						}

						.route-flow-surface .react-flow__handle {
							opacity: 0;
							pointer-events: none;
						}

						.route-flow-surface .react-flow__edge-path {
							stroke-linecap: round;
							stroke-linejoin: round;
						}

						.route-flow-surface .react-flow__edge-text {
							paint-order: stroke;
							stroke: var(--card);
							stroke-width: 3px;
						}
					`}</style>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Route Details</CardTitle>
					<CardDescription>
						Route table from module communication config files.
					</CardDescription>
				</CardHeader>
				<CardContent className="px-0">
					<div className="overflow-x-auto">
						<Table className="min-w-[860px]">
							<TableHeader>
								<TableRow>
									<TableHead>Route</TableHead>
									<TableHead>Kind</TableHead>
									<TableHead>Transport</TableHead>
									<TableHead>Address</TableHead>
									<TableHead>Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{displayedRoutes.map((route) => (
									<TableRow key={route.id}>
										<TableCell>
											<div className="flex flex-col">
												<span className="font-semibold">{route.name}</span>
												<span className="text-muted-foreground text-xs">
													{route.messageType || route.module}
												</span>
											</div>
										</TableCell>
										<TableCell>
											<Badge variant="outline">{route.kind}</Badge>
										</TableCell>
										<TableCell>
											<span className="text-muted-foreground">
												{transportLabel(route)}
											</span>
										</TableCell>
										<TableCell>
											<span className="block max-w-[360px] truncate text-muted-foreground">
												{addressLabel(route) || "configured"}
											</span>
										</TableCell>
										<TableCell>
											<Badge variant={statusVariant(route.status)}>
												{route.status}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>
		</section>
	);
}

function SettingsSummary() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Settings</CardTitle>
				<CardDescription>
					Dashboard chrome follows the referenced shadcn starter while keeping
					Pacific-Rim module and transport configuration data source-driven.
				</CardDescription>
			</CardHeader>
		</Card>
	);
}

const robotProfileBadgeVariant = (
	status: string
): ComponentProps<typeof Badge>["variant"] =>
	status === "active" ? "default" : "secondary";

const serviceRequirementLabel = (profile: RobotProfileSummary): string => {
	const required = profile.services.filter(
		(service) => service.required
	).length;
	const optional = profile.services.length - required;
	return `${required} required${optional ? ` / ${optional} optional` : ""}`;
};

function RobotProfiles() {
	const catalog = useQuery(trpc.dashboard.robotProfiles.queryOptions());

	if (catalog.isLoading) {
		return <Skeleton className="h-80 w-full" />;
	}

	if (!catalog.data) {
		return (
			<Empty className="min-h-80 border border-dashed">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CircleAlert />
					</EmptyMedia>
					<EmptyTitle>Robot profiles unavailable</EmptyTitle>
					<EmptyDescription>
						The robot capability catalog could not be loaded.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<section className="flex flex-col gap-4">
			<div className="grid gap-4 md:grid-cols-3">
				<Card>
					<CardHeader>
						<CardDescription>Profiles</CardDescription>
						<CardTitle className="flex items-center gap-2 text-3xl">
							<Bot className="size-6" />
							{catalog.data.profiles.length}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card>
					<CardHeader>
						<CardDescription>Active / Templates</CardDescription>
						<CardTitle className="text-3xl">
							{catalog.data.activeProfiles} / {catalog.data.templateProfiles}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card>
					<CardHeader>
						<CardDescription>Capabilities</CardDescription>
						<CardTitle className="flex items-center gap-2 text-3xl">
							<Layers className="size-6" />
							{catalog.data.capabilities.length}
						</CardTitle>
					</CardHeader>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Robot Profiles</CardTitle>
					<CardDescription>
						Module bundles mapped to robot capability IDs and deployment intent.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Profile</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Robot Class</TableHead>
									<TableHead>Services</TableHead>
									<TableHead>Capabilities</TableHead>
									<TableHead>Deploy</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{catalog.data.profiles.map((profile) => (
									<TableRow key={profile.id}>
										<TableCell className="min-w-64 align-top">
											<div className="font-semibold">
												{profile.displayName || profile.id}
											</div>
											<div className="text-muted-foreground text-sm">
												{profile.summary}
											</div>
										</TableCell>
										<TableCell className="align-top">
											<Badge variant={robotProfileBadgeVariant(profile.status)}>
												{profile.status}
											</Badge>
										</TableCell>
										<TableCell className="align-top">
											{profile.robotClass}
										</TableCell>
										<TableCell className="min-w-56 align-top">
											<div>{serviceRequirementLabel(profile)}</div>
											<div className="text-muted-foreground text-sm">
												{profile.plannedServices.length} planned
											</div>
										</TableCell>
										<TableCell className="min-w-80 align-top">
											<div className="flex flex-wrap gap-1.5">
												{profile.capabilities.slice(0, 8).map((capability) => (
													<Badge
														className="rounded-md"
														key={capability}
														variant="outline"
													>
														{capability}
													</Badge>
												))}
												{profile.capabilities.length > 8 ? (
													<Badge className="rounded-md" variant="secondary">
														+{profile.capabilities.length - 8}
													</Badge>
												) : null}
											</div>
										</TableCell>
										<TableCell className="align-top">
											<div>{profile.deploy.rosDistro || "unset"}</div>
											<div className="text-muted-foreground text-sm">
												domain {profile.deploy.defaultDomainId ?? "unset"}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>
		</section>
	);
}

export default function Dashboard({
	view = "overview",
}: {
	view?: DashboardView;
}) {
	const snapshot = useQuery(
		trpc.dashboard.snapshot.queryOptions(undefined, {
			refetchInterval: SNAPSHOT_REFETCH_INTERVAL_MS,
			refetchIntervalInBackground: true,
			refetchOnWindowFocus: true,
			staleTime: 0,
		})
	);
	const [createDialogOpen, setCreateDialogOpen] = useState(false);

	if (snapshot.isLoading) {
		return <LoadingDashboard />;
	}

	if (!snapshot.data) {
		return (
			<PageContainer>
				<Empty className="min-h-80 border border-dashed">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CircleAlert />
						</EmptyMedia>
						<EmptyTitle>Dashboard unavailable</EmptyTitle>
						<EmptyDescription>
							The project snapshot could not be loaded.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</PageContainer>
		);
	}

	const copy = viewCopy[view];
	const showPageHeader = view !== "modules";
	const content = {
		overview: (
			<>
				<OverviewHero snapshot={snapshot.data} />
				<Overview snapshot={snapshot.data} />
			</>
		),
		modules: (
			<Modules
				modules={snapshot.data.modules}
				onCreate={() => setCreateDialogOpen(true)}
			/>
		),
		robots: <RobotProfiles />,
		communication: <TransportMix snapshot={snapshot.data} />,
		observability: <Overview snapshot={snapshot.data} />,
		routes: <RouteMatrix snapshot={snapshot.data} />,
		settings: <SettingsSummary />,
	} satisfies Record<DashboardView, ReactNode>;

	return (
		<>
			<PageContainer
				pageDescription={showPageHeader ? copy.description : undefined}
				pageHeaderAction={
					showPageHeader ? (
						<>
							<Badge variant="outline">
								<GitBranch data-icon="inline-start" />
								{snapshot.data.modules.length} modules
							</Badge>
							<Badge variant="secondary">
								Updated{" "}
								{new Date(snapshot.data.generatedAt).toLocaleTimeString()}
							</Badge>
						</>
					) : undefined
				}
				pageTitle={showPageHeader ? copy.title : undefined}
			>
				<div className="flex flex-col gap-4">{content[view]}</div>
			</PageContainer>
			{createDialogOpen ? (
				<CreateModuleDialog onClose={() => setCreateDialogOpen(false)} />
			) : null}
		</>
	);
}
