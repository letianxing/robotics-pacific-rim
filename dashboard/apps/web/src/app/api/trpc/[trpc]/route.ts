import { createContext } from "@dashboard/api/context";
import { appRouter } from "@dashboard/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { withEvlog } from "@/lib/evlog";

function handler(req: NextRequest) {
	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req,
		router: appRouter,
		createContext: () => createContext(req),
		onError({ error, path }) {
			console.error(
				`[dashboard-trpc] ${path ?? "unknown"} failed: ${error.message}`
			);
			if (error.cause) {
				console.error(error.cause);
			}
		},
	});
}
export const GET = withEvlog(handler);
export const POST = withEvlog(handler);
