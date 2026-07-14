import { Skeleton } from "@dashboard/ui/components/skeleton";
import { cn } from "@dashboard/ui/lib/utils";
import type { ReactNode } from "react";

function PageSkeleton() {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-4 w-80" />
			</div>
			<Skeleton className="h-36 w-full" />
			<Skeleton className="h-80 w-full" />
		</div>
	);
}

export function PageContainer({
	children,
	className,
	isLoading = false,
	pageDescription,
	pageHeaderAction,
	pageTitle,
}: {
	children: ReactNode;
	className?: string;
	isLoading?: boolean;
	pageDescription?: string;
	pageHeaderAction?: ReactNode;
	pageTitle?: ReactNode;
}) {
	const hasHeader = pageTitle || pageDescription || pageHeaderAction;

	return (
		<div
			className={cn(
				"mx-auto flex w-full max-w-[1560px] flex-1 flex-col px-4 py-5 md:px-7 md:py-6",
				className
			)}
		>
			{hasHeader ? (
				<div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
					<div className="flex min-w-0 flex-col gap-1.5">
						{pageTitle ? (
							<h1 className="truncate font-semibold text-[26px] leading-8 tracking-normal">
								{pageTitle}
							</h1>
						) : null}
						{pageDescription ? (
							<p className="max-w-3xl text-[15px] text-muted-foreground leading-6">
								{pageDescription}
							</p>
						) : null}
					</div>
					{pageHeaderAction ? (
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{pageHeaderAction}
						</div>
					) : null}
				</div>
			) : null}
			{isLoading ? <PageSkeleton /> : children}
		</div>
	);
}
