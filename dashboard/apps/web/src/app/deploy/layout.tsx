import { DashboardShell } from "@/components/layout/dashboard-shell";

export default function DeployLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <DashboardShell>{children}</DashboardShell>;
}
