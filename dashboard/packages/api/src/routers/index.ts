import { protectedProcedure, publicProcedure, router } from "../index";
import { dashboardRouter } from "./dashboard";
import { deployRouter } from "./deploy";

export const appRouter = router({
	healthCheck: publicProcedure.query(() => "OK"),
	privateData: protectedProcedure.query(({ ctx }) => ({
		message: "This is private",
		user: ctx.session.user,
	})),
	dashboard: dashboardRouter,
	deploy: deployRouter,
});
export type AppRouter = typeof appRouter;
