import { createEvlog } from "evlog/next";

export const { withEvlog, useLogger, log, createError } = createEvlog({
	service: "dashboard-web",
});
