"use client";

import { Badge } from "@dashboard/ui/components/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@dashboard/ui/components/breadcrumb";
import { Button } from "@dashboard/ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@dashboard/ui/components/sheet";
import { cn } from "@dashboard/ui/lib/utils";
import {
	Activity,
	Bot,
	Boxes,
	CircleGauge,
	GitBranch,
	Menu,
	Network,
	RadioTower,
	Rocket,
	Settings,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { DashboardCommandMenu } from "@/components/layout/command-menu";
import { PacificRimLogo } from "@/components/layout/pacific-rim-logo";
import { ModeToggle } from "@/components/mode-toggle";

const mobileNavGroups = [
	{
		label: "General",
		items: [
			{ href: "/dashboard", icon: CircleGauge, title: "Overview" },
			{ href: "/dashboard/modules", icon: Boxes, title: "Modules" },
			{ href: "/dashboard/robots", icon: Bot, title: "Robots" },
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
			{ href: "/dashboard/routes", icon: RadioTower, title: "Route Matrix" },
			{ href: "/deploy", icon: Rocket, title: "Deploy" },
		],
	},
	{
		label: "Other",
		items: [{ href: "/dashboard/settings", icon: Settings, title: "Settings" }],
	},
] as const;

const titleFromPathname = (pathname: string): string => {
	if (pathname.includes("/dashboard/modules/")) {
		return "Module Detail";
	}
	if (pathname === "/dashboard/modules") {
		return "Modules";
	}
	if (pathname === "/dashboard/robots") {
		return "Robots";
	}
	if (pathname === "/dashboard/communication") {
		return "Communication";
	}
	if (pathname === "/dashboard/observability") {
		return "Observability";
	}
	if (pathname === "/dashboard/routes") {
		return "Route Matrix";
	}
	if (pathname === "/deploy") {
		return "Deploy";
	}
	if (pathname === "/dashboard/settings") {
		return "Settings";
	}
	return "Operations Dashboard";
};

export function DashboardHeader() {
	const pathname = usePathname();
	const [navigationOpen, setNavigationOpen] = useState(false);

	return (
		<header className="sticky top-0 flex h-16 shrink-0 items-center justify-between gap-3 border-border/70 border-b bg-background/72 px-3 backdrop-blur-xl md:px-5">
			<div className="flex min-w-0 items-center gap-3">
				<Sheet onOpenChange={setNavigationOpen} open={navigationOpen}>
					<SheetTrigger
						render={
							<Button
								aria-label="Open navigation"
								className="md:hidden"
								size="icon"
								variant="outline"
							/>
						}
					>
						<Menu />
					</SheetTrigger>
					<SheetContent className="w-[304px] bg-card p-0" side="left">
						<SheetHeader className="px-4 py-4 pr-12">
							<SheetTitle className="flex items-center gap-4">
								<span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-foreground shadow-xs">
									<PacificRimLogo className="size-10" />
								</span>
								<span className="min-w-0">
									<span className="block truncate font-bold text-xl leading-tight">
										Pacific-Rim
									</span>
									<span className="block truncate font-medium text-muted-foreground text-sm">
										Local control surface
									</span>
								</span>
							</SheetTitle>
						</SheetHeader>
						<nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3">
							{mobileNavGroups.map((group) => (
								<div className="flex flex-col gap-2" key={group.label}>
									<p className="px-3 font-semibold text-muted-foreground text-sm">
										{group.label}
									</p>
									<div className="flex flex-col gap-1">
										{group.items.map((item) => {
											const Icon = item.icon;
											const active =
												item.href === "/dashboard"
													? pathname === "/dashboard"
													: pathname === item.href ||
														pathname.startsWith(`${item.href}/`);
											return (
												<Link
													aria-current={active ? "page" : undefined}
													className={cn(
														"flex h-10 items-center gap-3 rounded-xl px-4 text-left font-medium text-base transition-[background-color,color,box-shadow] hover:bg-muted/60 hover:text-foreground",
														active
															? "bg-muted text-foreground shadow-xs ring-1 ring-foreground/5"
															: "text-foreground/70"
													)}
													href={item.href as Route}
													key={item.href}
													onClick={() => setNavigationOpen(false)}
												>
													<Icon className="size-5 shrink-0" />
													<span className="truncate">{item.title}</span>
												</Link>
											);
										})}
									</div>
								</div>
							))}
						</nav>
						<div className="mt-auto p-4">
							<div className="flex items-center gap-3 rounded-2xl bg-card p-2 transition-colors hover:bg-muted/70">
								<div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
									<GitBranch className="size-5" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2">
										<p className="truncate font-bold text-base leading-tight">
											Local Stack
										</p>
										<Badge
											className="h-5 rounded-md px-1.5"
											variant="secondary"
										>
											dev
										</Badge>
									</div>
									<p className="truncate font-medium text-muted-foreground text-sm">
										Module and route inventory
									</p>
								</div>
							</div>
						</div>
					</SheetContent>
				</Sheet>

				<Link className="flex items-center gap-2 md:hidden" href="/dashboard">
					<div className="flex size-9 items-center justify-center rounded-lg bg-foreground shadow-xs">
						<PacificRimLogo className="size-8" />
					</div>
				</Link>

				<Breadcrumb className="hidden min-w-0 md:block">
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink render={<Link href="/dashboard" />}>
								Dashboard
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="truncate font-semibold">
								{titleFromPathname(pathname)}
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</div>

			<div className="flex min-w-0 flex-1 justify-start px-1 md:px-6">
				<DashboardCommandMenu />
			</div>

			<div className="flex shrink-0 items-center gap-2">
				<Badge className="hidden sm:inline-flex" variant="outline">
					local
				</Badge>
				<ModeToggle />
			</div>
		</header>
	);
}
