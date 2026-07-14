"use client";

import { Badge } from "@dashboard/ui/components/badge";
import { Button } from "@dashboard/ui/components/button";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@dashboard/ui/components/sidebar";
import { cn } from "@dashboard/ui/lib/utils";
import {
	Activity,
	Bot,
	Boxes,
	CircleGauge,
	GitBranch,
	Network,
	RadioTower,
	Rocket,
	Settings,
	Sparkles,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { PacificRimLogo } from "@/components/layout/pacific-rim-logo";

const navGroups = [
	{
		label: "General",
		items: [
			{
				href: "/dashboard",
				icon: CircleGauge,
				title: "Overview",
			},
			{
				href: "/dashboard/modules",
				icon: Boxes,
				title: "Modules",
			},
			{
				href: "/dashboard/robots",
				icon: Bot,
				title: "Robots",
			},
			{
				href: "/dashboard/communication",
				icon: Network,
				title: "Communication",
			},
		],
	},
	{
		label: "Operations",
		items: [
			{
				href: "/dashboard/observability",
				icon: Activity,
				title: "Observability",
			},
			{
				href: "/dashboard/routes",
				icon: RadioTower,
				title: "Route Matrix",
			},
			{
				href: "/deploy",
				icon: Rocket,
				title: "Deploy",
			},
		],
	},
	{
		label: "Other",
		items: [
			{
				href: "/dashboard/settings",
				icon: Settings,
				title: "Settings",
			},
		],
	},
] as const;

const sidebarCollapsedStorageKey = "pacific-rim-dashboard-sidebar-collapsed";

type NavItem = (typeof navGroups)[number]["items"][number];

const isActiveNavItem = (pathname: string, href: NavItem["href"]) =>
	href === "/dashboard"
		? pathname === "/dashboard"
		: pathname === href || pathname.startsWith(`${href}/`);

export function AppSidebar() {
	const pathname = usePathname();
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		const stored = window.localStorage.getItem(sidebarCollapsedStorageKey);
		if (stored) {
			setCollapsed(stored === "true");
		}
	}, []);

	const toggleCollapsed = () => {
		setCollapsed((value) => {
			const nextValue = !value;
			window.localStorage.setItem(
				sidebarCollapsedStorageKey,
				String(nextValue)
			);
			return nextValue;
		});
	};

	return (
		<Sidebar state={collapsed ? "collapsed" : "expanded"}>
			<SidebarHeader
				className={
					collapsed ? "flex-col gap-2 px-3 py-4 lg:px-3 lg:py-4" : undefined
				}
			>
				<div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-foreground shadow-xs">
					<PacificRimLogo className="size-10" />
				</div>
				{collapsed ? null : (
					<div className="min-w-0 flex-1">
						<div className="truncate font-bold text-xl leading-tight">
							Pacific-Rim
						</div>
						<div className="truncate font-medium text-muted-foreground text-sm">
							Local control surface
						</div>
					</div>
				)}
				<Button
					aria-label="Toggle sidebar"
					aria-pressed={collapsed}
					className={cn(
						"shrink-0 rounded-xl border bg-background text-foreground shadow-xs hover:bg-muted/70",
						collapsed && "mx-auto size-10"
					)}
					onClick={toggleCollapsed}
					size="icon-lg"
					type="button"
					variant="outline"
				>
					<div className="flex flex-col gap-1">
						<span className="h-0.5 w-4 rounded-full bg-current" />
						<span
							className={cn(
								"h-0.5 rounded-full bg-current transition-all",
								collapsed ? "w-4" : "w-2.5"
							)}
						/>
					</div>
				</Button>
			</SidebarHeader>

			<SidebarContent className={collapsed ? "items-center px-3" : undefined}>
				{navGroups.map((group) => (
					<SidebarGroup
						className={collapsed ? "w-full items-center" : undefined}
						key={group.label}
					>
						{collapsed ? null : (
							<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						)}
						<SidebarMenu
							className={collapsed ? "w-full items-center" : undefined}
						>
							{group.items.map((item) => {
								const Icon = item.icon;
								const active = isActiveNavItem(pathname, item.href);
								return (
									<SidebarMenuItem
										className={collapsed ? "w-full" : undefined}
										key={item.href}
									>
										<SidebarMenuButton
											active={active}
											aria-current={active ? "page" : undefined}
											className={collapsed ? "mx-auto size-10" : undefined}
											collapsed={collapsed}
											render={<Link href={item.href as Route} />}
											title={item.title}
										>
											<Icon className="size-5 shrink-0" />
											{collapsed ? null : <span>{item.title}</span>}
										</SidebarMenuButton>
									</SidebarMenuItem>
								);
							})}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter>
				{collapsed ? (
					<div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted font-semibold text-base text-foreground uppercase">
						PR
					</div>
				) : (
					<div className="flex items-center gap-3 rounded-2xl bg-card p-2 transition-colors hover:bg-muted/70">
						<div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
							<GitBranch className="size-5" />
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex min-w-0 items-center gap-2">
								<p className="truncate font-bold text-base leading-tight">
									Local Stack
								</p>
								<Badge className="h-5 rounded-md px-1.5" variant="secondary">
									dev
								</Badge>
							</div>
							<p className="truncate font-medium text-muted-foreground text-sm">
								Module and route inventory
							</p>
						</div>
						<Sparkles className="size-4 shrink-0 text-muted-foreground" />
					</div>
				)}
			</SidebarFooter>
		</Sidebar>
	);
}
