import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { publicProcedure, router } from "../index";

const MODULE_SERVICE_ROOT = path.join("module", "service");
const DEPLOY_MAX_BUFFER_BYTES = 1024 * 1024 * 50;
const DEFAULT_DEPLOY_USER = "jetson";
const DEFAULT_DEPLOY_PORT = 22;
const DEFAULT_ROS_DOMAIN_ID = 42;
const DEFAULT_LOGS_TAIL = 120;
const PR_COMMAND = "./pr";

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*[$]?$/;
const PLATFORM_PATTERN = /^linux\/(?:amd64|arm64|arm\/v7)$/;
const XML_TAG_PATTERN_CACHE = new Map<string, RegExp>();
const execFileAsync = promisify(execFile);

export interface DeployPackageSummary {
	description: string;
	moduleRoot: string;
	name: string;
	serviceName: string;
}

export interface DeployTargetInput {
	host: string;
	port?: number;
	user?: string;
}

export interface DeployImageBaseInput extends DeployTargetInput {
	domainId?: number;
	dryRun?: boolean;
	logsTail?: number;
	noCache?: boolean;
	noLogs?: boolean;
	password?: string;
	platform?: string;
	pull?: boolean;
}

export interface DeploySinglePackageImageInput extends DeployImageBaseInput {
	packageName: string;
}

export interface DeployImageInput extends DeployImageBaseInput {
	packageName?: string;
	packageNames?: string[];
}

export interface DeployImageCommand {
	args: string[];
	packageName: string;
}

export interface DeployPackageCommandResult {
	command: string;
	packageName: string;
	stderr: string;
	stdout: string;
}

export interface DeployCommandResult {
	command: string;
	deploy: {
		stderr: string;
		stdout: string;
	};
	deployments: DeployPackageCommandResult[];
	gitPull: {
		stderr: string;
		stdout: string;
	};
}

export type DeployOutputWriter = (chunk: string) => Promise<void> | void;

export type DeployCommandRunner = (
	command: string,
	args: string[],
	cwd: string,
	onChunk: DeployOutputWriter
) => Promise<{ stderr: string; stdout: string }>;

export interface StreamDeployOptions {
	repoRoot?: string;
	runCommand?: DeployCommandRunner;
}

const deployInput = z
	.object({
		domainId: z.number().int().min(0).max(232).default(DEFAULT_ROS_DOMAIN_ID),
		dryRun: z.boolean().default(false),
		host: z.string().trim().min(1),
		logsTail: z.number().int().min(0).max(5000).default(DEFAULT_LOGS_TAIL),
		noCache: z.boolean().default(false),
		noLogs: z.boolean().default(false),
		packageName: z.string().trim().min(1).optional(),
		packageNames: z.array(z.string().trim().min(1)).min(1).optional(),
		password: z.string().optional(),
		platform: z.string().trim().optional(),
		port: z.number().int().min(1).max(65_535).default(DEFAULT_DEPLOY_PORT),
		pull: z.boolean().default(false),
		user: z.string().trim().min(1).default(DEFAULT_DEPLOY_USER),
	})
	.refine((input) => input.packageName || input.packageNames?.length, {
		message: "Select at least one ROS package.",
		path: ["packageNames"],
	});

type DeployMutationInput = z.infer<typeof deployInput>;

export const parseDeployInput = (input: unknown): DeployMutationInput =>
	deployInput.parse(input);

const xmlTagPattern = (tagName: string): RegExp => {
	const cached = XML_TAG_PATTERN_CACHE.get(tagName);
	if (cached) {
		return cached;
	}
	const pattern = new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, "m");
	XML_TAG_PATTERN_CACHE.set(tagName, pattern);
	return pattern;
};

const parseXmlTag = (xml: string, tagName: string): string => {
	const match = xml.match(xmlTagPattern(tagName));
	return match?.[1]?.trim() ?? "";
};

export const parseRosPackageName = (xml: string): string =>
	parseXmlTag(xml, "name");

const parseRosPackageDescription = (xml: string): string =>
	parseXmlTag(xml, "description");

const findRepoRoot = (): string => {
	if (process.env.PACIFIC_RIM_REPO_ROOT) {
		return process.env.PACIFIC_RIM_REPO_ROOT;
	}
	const candidates = [
		path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../.."),
		path.resolve(/* turbopackIgnore: true */ process.cwd(), ".."),
		path.resolve(/* turbopackIgnore: true */ process.cwd(), "."),
	];
	for (const candidate of candidates) {
		const isRepoRoot =
			existsSync(path.join(candidate, "module")) &&
			existsSync(path.join(candidate, "infra")) &&
			existsSync(path.join(candidate, "pkg"));
		if (isRepoRoot) {
			return candidate;
		}
	}
	return path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../..");
};

const normalizePath = (value: string): string =>
	value.split(path.sep).join("/");

export const readDeployPackages = async (
	repoRoot = findRepoRoot()
): Promise<DeployPackageSummary[]> => {
	const serviceRoot = path.join(repoRoot, MODULE_SERVICE_ROOT);
	if (!existsSync(serviceRoot)) {
		return [];
	}

	const entries = await readdir(serviceRoot, { withFileTypes: true });
	const packages: DeployPackageSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(serviceRoot, entry.name, "package.xml");
		if (!existsSync(packagePath)) {
			continue;
		}
		const xml = await readFile(packagePath, "utf8");
		const name = parseRosPackageName(xml);
		if (!PACKAGE_NAME_PATTERN.test(name)) {
			continue;
		}
		const moduleRoot = path.join(MODULE_SERVICE_ROOT, entry.name);
		packages.push({
			description: parseRosPackageDescription(xml),
			moduleRoot: normalizePath(moduleRoot),
			name,
			serviceName: entry.name,
		});
	}

	return packages.sort((left, right) => left.name.localeCompare(right.name));
};

export const validateDeployTarget = (
	input: DeployTargetInput
): Required<DeployTargetInput> => {
	const host = input.host.trim();
	if (!HOST_PATTERN.test(host)) {
		throw new Error(`Invalid deploy host "${input.host}".`);
	}

	const user = (input.user ?? DEFAULT_DEPLOY_USER).trim();
	if (!USER_PATTERN.test(user)) {
		throw new Error(`Invalid deploy user "${input.user ?? ""}".`);
	}

	const port = input.port ?? DEFAULT_DEPLOY_PORT;
	if (!(Number.isInteger(port) && port >= 1 && port <= 65_535)) {
		throw new Error(`Invalid deploy port "${port}".`);
	}

	return { host, port, user };
};

const validatePackageName = (packageName: string): string => {
	const name = packageName.trim();
	if (!PACKAGE_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid ROS package name "${packageName}".`);
	}
	return name;
};

export const normalizeDeployPackageNames = (
	input: Pick<DeployImageInput, "packageName" | "packageNames">
): string[] => {
	let packageNames: string[] = [];
	if (input.packageNames && input.packageNames.length > 0) {
		packageNames = input.packageNames;
	} else if (input.packageName) {
		packageNames = [input.packageName];
	}
	const names: string[] = [];
	const seenNames = new Set<string>();

	for (const packageName of packageNames) {
		const name = validatePackageName(packageName);
		if (!seenNames.has(name)) {
			seenNames.add(name);
			names.push(name);
		}
	}

	if (names.length === 0) {
		throw new Error("Select at least one ROS package.");
	}

	return names;
};

const normalizedPlatform = (platform: string | undefined): string | null => {
	const value = platform?.trim();
	if (!value) {
		return null;
	}
	if (!PLATFORM_PATTERN.test(value)) {
		throw new Error(`Invalid deploy platform "${value}".`);
	}
	return value;
};

export const buildDeployImageArgs = (
	input: DeploySinglePackageImageInput
): string[] => {
	const target = validateDeployTarget(input);
	const packageName = validatePackageName(input.packageName);
	const domainId = input.domainId ?? DEFAULT_ROS_DOMAIN_ID;
	const logsTail = input.logsTail ?? DEFAULT_LOGS_TAIL;
	if (!(Number.isInteger(domainId) && domainId >= 0 && domainId <= 232)) {
		throw new Error(`Invalid ROS_DOMAIN_ID "${domainId}".`);
	}
	if (!(Number.isInteger(logsTail) && logsTail >= 0 && logsTail <= 5000)) {
		throw new Error(`Invalid logs tail "${logsTail}".`);
	}

	const args = [
		"ros2:deploy",
		"--host",
		target.host,
		"--user",
		target.user,
		"--port",
		String(target.port),
		"--packages-select",
		packageName,
		"--domain-id",
		String(domainId),
		"--logs-tail",
		String(logsTail),
	];

	if (input.password) {
		args.push("--password", input.password);
	}
	const platform = normalizedPlatform(input.platform);
	if (platform) {
		args.push("--platform", platform);
	}
	if (input.pull) {
		args.push("--pull");
	}
	if (input.noCache) {
		args.push("--no-cache");
	}
	if (input.noLogs) {
		args.push("--no-logs");
	}
	if (input.dryRun) {
		args.push("--dry-run");
	}

	return args;
};

export const buildDeployImageCommands = (
	input: DeployImageInput
): DeployImageCommand[] =>
	normalizeDeployPackageNames(input).map((packageName) => ({
		args: buildDeployImageArgs({ ...input, packageName }),
		packageName,
	}));

const commandForDisplay = (command: string, args: string[]): string => {
	const displayArgs = args.map((arg, index) =>
		args[index - 1] === "--password" ? "<redacted>" : arg
	);
	return [command, ...displayArgs].join(" ");
};

const runCommand = async (
	command: string,
	args: string[],
	cwd: string
): Promise<{ stderr: string; stdout: string }> => {
	try {
		const { stderr, stdout } = await execFileAsync(command, args, {
			cwd,
			env: process.env,
			maxBuffer: DEPLOY_MAX_BUFFER_BYTES,
		});
		return { stderr, stdout };
	} catch (error) {
		const details = error as {
			message?: string;
			stderr?: string;
			stdout?: string;
		};
		const output = [details.stdout, details.stderr].filter(Boolean).join("\n");
		throw new Error(
			output ||
				details.message ||
				`Command failed: ${commandForDisplay(command, args)}`
		);
	}
};

const runCommandStreaming: DeployCommandRunner = (
	command,
	args,
	cwd,
	onChunk
) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const forwardChunk = (chunks: string[], chunk: string) => {
			chunks.push(chunk);
			Promise.resolve(onChunk(chunk)).catch(reject);
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			forwardChunk(stdoutChunks, chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			forwardChunk(stderrChunks, chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const stdout = stdoutChunks.join("");
			const stderr = stderrChunks.join("");
			if (code === 0) {
				resolve({ stderr, stdout });
				return;
			}
			const output = [stdout, stderr].filter(Boolean).join("\n");
			reject(
				new Error(
					output ||
						`Command failed (${code ?? "signal"}): ${commandForDisplay(command, args)}`
				)
			);
		});
	});

const assertPackagesExist = async (
	packageNames: string[],
	repoRoot: string
): Promise<void> => {
	const packages = await readDeployPackages(repoRoot);
	const availableNames = new Set(packages.map((item) => item.name));
	const missingPackageName = packageNames.find(
		(name) => !availableNames.has(name)
	);
	if (missingPackageName) {
		throw new Error(`Unknown deploy package "${missingPackageName}".`);
	}
};

const deployPackage = async (
	input: DeployMutationInput
): Promise<DeployCommandResult> => {
	const repoRoot = findRepoRoot();
	const commands = buildDeployImageCommands(input);
	await assertPackagesExist(
		commands.map((command) => command.packageName),
		repoRoot
	);

	const gitPull = await runCommand("git", ["pull", "origin", "main"], repoRoot);
	const deployments: DeployPackageCommandResult[] = [];
	for (const command of commands) {
		const deploy = await runCommand(PR_COMMAND, command.args, repoRoot);
		deployments.push({
			command: commandForDisplay(PR_COMMAND, command.args),
			packageName: command.packageName,
			stderr: deploy.stderr,
			stdout: deploy.stdout,
		});
	}

	return {
		command: deployments.map((deploy) => deploy.command).join("\n"),
		deploy: {
			stderr: deployments
				.map((deploy) => deploy.stderr.trim())
				.filter(Boolean)
				.join("\n\n"),
			stdout: deployments
				.map((deploy) => deploy.stdout.trim())
				.filter(Boolean)
				.join("\n\n"),
		},
		deployments,
		gitPull,
	};
};

export const streamDeployPackage = async (
	input: DeployImageInput,
	onChunk: DeployOutputWriter,
	options: StreamDeployOptions = {}
): Promise<void> => {
	const repoRoot = options.repoRoot ?? findRepoRoot();
	const run = options.runCommand ?? runCommandStreaming;
	const commands = buildDeployImageCommands(input);
	await assertPackagesExist(
		commands.map((command) => command.packageName),
		repoRoot
	);

	await onChunk("$ git pull origin main\n");
	await run("git", ["pull", "origin", "main"], repoRoot, onChunk);

	for (const command of commands) {
		await onChunk(`\n$ ${commandForDisplay(PR_COMMAND, command.args)}\n`);
		await run(PR_COMMAND, command.args, repoRoot, onChunk);
	}
};

export const deployRouter = router({
	deploy: publicProcedure
		.input(deployInput)
		.mutation(({ input }) => deployPackage(input)),
	packages: publicProcedure.query(() => readDeployPackages()),
});
