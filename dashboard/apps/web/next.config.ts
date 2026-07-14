import "@dashboard/env/web";
import path from "node:path";
import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const nextConfig: NextConfig = {
	allowedDevOrigins,
	typedRoutes: true,
	reactCompiler: true,
	turbopack: {
		ignoreIssue: [
			{
				path: /next\.config\.ts$/,
				title: /Encountered unexpected file in NFT list/,
			},
		],
		root: path.resolve(import.meta.dirname, "../.."),
	},
};

export default nextConfig;
