import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";

export function DashboardShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-svh overflow-hidden bg-[radial-gradient(circle_at_18%_0%,color-mix(in_oklab,var(--accent)_48%,transparent),transparent_34%),linear-gradient(180deg,color-mix(in_oklab,var(--background)_96%,white),var(--background)_42%)] text-foreground">
			<AppSidebar />
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<DashboardHeader />
				<div className="min-h-0 flex-1 overflow-auto">{children}</div>
			</div>
		</div>
	);
}
