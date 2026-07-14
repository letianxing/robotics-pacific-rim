"use client";

import type { DashboardSnapshot } from "@dashboard/api/routers/dashboard";
import { Badge } from "@dashboard/ui/components/badge";
import { Button } from "@dashboard/ui/components/button";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
} from "@dashboard/ui/components/command";
import { Spinner } from "@dashboard/ui/components/spinner";
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	ArrowRight,
	Bot,
	Boxes,
	CircleGauge,
	Network,
	RadioTower,
	Rocket,
	Route as RouteIcon,
	Search,
	Settings,
} from "lucide-react";
import type { Route as NextRoute } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { trpc } from "@/utils/trpc";

type ModuleSummary = DashboardSnapshot["modules"][number];
type CommunicationRoute = DashboardSnapshot["communication"]["routes"][number];

const navigationCommands = [
	{
		href: "/dashboard",
		icon: CircleGauge,
		keywords: "home overview operations",
		title: "Overview",
	},
	{
		href: "/dashboard/modules",
		icon: Boxes,
		keywords: "modules inventory build services",
		title: "Modules",
	},
	{
		href: "/dashboard/robots",
		icon: Bot,
		keywords: "robots profiles capabilities deploy bundles",
		title: "Robots",
	},
	{
		href: "/dashboard/communication",
		icon: Network,
		keywords: "communication transports bindings",
		title: "Communication",
	},
	{
		href: "/dashboard/observability",
		icon: Activity,
		keywords: "observability traces metrics logs",
		title: "Observability",
	},
	{
		href: "/dashboard/routes",
		icon: RadioTower,
		keywords: "routes matrix service topic",
		title: "Route Matrix",
	},
	{
		href: "/deploy",
		icon: Rocket,
		keywords: "deploy package machine robot ssh release",
		title: "Deploy",
	},
	{
		href: "/dashboard/settings",
		icon: Settings,
		keywords: "settings workspace configuration",
		title: "Settings",
	},
] as const;

const moduleUrlName = (project: ModuleSummary): string =>
	project.root.split("/").filter(Boolean).at(-1) ?? project.name;

const routeSubtitle = (route: CommunicationRoute): string =>
	[route.kind, route.module, route.messageType].filter(Boolean).join(" / ");

export function DashboardCommandMenu() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const snapshot = useQuery(trpc.dashboard.snapshot.queryOptions());

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "k") {
				return;
			}
			if (!(event.metaKey || event.ctrlKey)) {
				return;
			}
			event.preventDefault();
			setOpen((value) => !value);
		};

		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const moduleCommands = useMemo(
		() =>
			[...(snapshot.data?.modules ?? [])]
				.sort(
					(left, right) =>
						Number(right.critical) - Number(left.critical) ||
						left.root.localeCompare(right.root)
				)
				.slice(0, 12),
		[snapshot.data?.modules]
	);

	const routeCommands = useMemo(
		() => (snapshot.data?.communication.routes ?? []).slice(0, 12),
		[snapshot.data?.communication.routes]
	);

	const navigate = (href: string) => {
		setOpen(false);
		router.push(href as NextRoute);
	};

	return (
		<>
			<Button
				aria-label="Open command menu"
				className="hidden h-9 w-full max-w-[500px] justify-start gap-2 border-border/70 bg-card/76 px-3 font-normal text-muted-foreground text-sm shadow-xs backdrop-blur md:flex"
				onClick={() => setOpen(true)}
				type="button"
				variant="outline"
			>
				<Search />
				<span className="truncate">Search modules, routes, pages...</span>
				<Badge
					className="ml-auto h-5 border-border/70 bg-background/70 px-1.5 font-mono text-[11px]"
					variant="outline"
				>
					Cmd K
				</Badge>
			</Button>
			<Button
				aria-label="Open command menu"
				className="md:hidden"
				onClick={() => setOpen(true)}
				size="icon"
				type="button"
				variant="outline"
			>
				<Search />
			</Button>

			<CommandDialog
				description="Jump to dashboard pages, modules, and route views."
				onOpenChange={setOpen}
				open={open}
				title="Search dashboard"
			>
				<CommandInput placeholder="Search modules, routes, pages..." />
				<CommandList>
					<CommandEmpty>No matching destination.</CommandEmpty>

					<CommandGroup heading="Navigation">
						{navigationCommands.map((item) => {
							const Icon = item.icon;
							return (
								<CommandItem
									key={item.href}
									onSelect={() => navigate(item.href)}
									value={`${item.title} ${item.keywords}`}
								>
									<Icon />
									<span>{item.title}</span>
									<ArrowRight className="ml-auto opacity-0 transition-opacity group-data-selected/command-item:opacity-100" />
								</CommandItem>
							);
						})}
					</CommandGroup>

					<CommandSeparator />
					<CommandGroup heading="Modules">
						{snapshot.isLoading ? (
							<div className="flex items-center gap-2 px-2 py-3 text-muted-foreground text-sm">
								<Spinner />
								Loading project index
							</div>
						) : null}
						{moduleCommands.map((project) => {
							const href = `/dashboard/modules/${encodeURIComponent(moduleUrlName(project))}`;
							return (
								<CommandItem
									key={project.root}
									onSelect={() => navigate(href)}
									value={`${project.name} ${project.root} ${project.tags.join(" ")}`}
								>
									<Boxes />
									<div className="flex min-w-0 flex-col">
										<span className="truncate">{project.name}</span>
										<span className="truncate text-muted-foreground text-xs">
											{project.root}
										</span>
									</div>
									<CommandShortcut>
										{project.runtime ? "runtime" : project.projectType}
									</CommandShortcut>
								</CommandItem>
							);
						})}
					</CommandGroup>

					<CommandSeparator />
					<CommandGroup heading="Routes">
						{routeCommands.map((route) => (
							<CommandItem
								key={route.id}
								onSelect={() => navigate("/dashboard/routes")}
								value={`${route.name} ${routeSubtitle(route)} ${route.bindings
									.map((binding) => binding.address)
									.join(" ")}`}
							>
								<RouteIcon />
								<div className="flex min-w-0 flex-col">
									<span className="truncate">{route.name}</span>
									<span className="truncate text-muted-foreground text-xs">
										{routeSubtitle(route)}
									</span>
								</div>
								<CommandShortcut>{route.kind}</CommandShortcut>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</CommandDialog>
		</>
	);
}
