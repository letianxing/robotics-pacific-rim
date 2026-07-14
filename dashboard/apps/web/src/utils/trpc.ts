import type { AppRouter } from "@dashboard/api/routers/index";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { notifyError } from "@/utils/notify-error";

export const queryClient = new QueryClient({
	mutationCache: new MutationCache({
		onError: (error) => {
			notifyError(error);
		},
	}),
	queryCache: new QueryCache({
		onError: (error, query) => {
			notifyError(error, {
				action: {
					label: "retry",
					onClick: () => {
						query.invalidate();
					},
				},
			});
		},
	}),
});

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: "/api/trpc",
			async fetch(url, options) {
				const response = await fetch(url, {
					...options,
					credentials: "include",
				});
				if (!response.ok) {
					const body = await response.clone().text();
					notifyError({
						message: `HTTP ${response.status} ${response.statusText}`,
						status: response.status,
						url: String(url),
						body,
					});
				}
				return response;
			},
		}),
	],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
	client: trpcClient,
	queryClient,
});
