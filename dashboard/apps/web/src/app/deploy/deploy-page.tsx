"use client";

import type { DeployPackageSummary } from "@dashboard/api/routers/deploy";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@dashboard/ui/components/alert";
import { Badge } from "@dashboard/ui/components/badge";
import { Button } from "@dashboard/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@dashboard/ui/components/card";
import { Checkbox } from "@dashboard/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@dashboard/ui/components/empty";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@dashboard/ui/components/field";
import { Input } from "@dashboard/ui/components/input";
import { ScrollArea } from "@dashboard/ui/components/scroll-area";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@dashboard/ui/components/select";
import { Separator } from "@dashboard/ui/components/separator";
import { Skeleton } from "@dashboard/ui/components/skeleton";
import { Spinner } from "@dashboard/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CircleAlert,
	Database,
	GitPullRequestArrow,
	Package,
	RefreshCw,
	Rocket,
	Server,
	Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PageContainer } from "@/components/layout/page-container";
import { trpc } from "@/utils/trpc";

const machineStorageKey = "pacific-rim-dashboard-deploy-machine";
const hostPattern = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

interface MachineConfig {
	domainId: string;
	host: string;
	password: string;
	platform: string;
	port: string;
	user: string;
}

type DeployStreamEvent =
	| { text: string; type: "chunk" }
	| { message: string; type: "error" }
	| { type: "done" };

type DeployStreamEventHandler = (event: DeployStreamEvent) => void;

const defaultMachine: MachineConfig = {
	domainId: "42",
	host: "",
	password: "",
	platform: "auto",
	port: "22",
	user: "jetson",
};

function safeInteger(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isStoredMachine(
	value: unknown
): value is Omit<MachineConfig, "password"> {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.domainId === "string" &&
		typeof record.host === "string" &&
		typeof record.platform === "string" &&
		typeof record.port === "string" &&
		typeof record.user === "string"
	);
}

function loadMachine(): MachineConfig {
	try {
		const raw = window.localStorage.getItem(machineStorageKey);
		const parsed = raw ? JSON.parse(raw) : null;
		return isStoredMachine(parsed)
			? { ...defaultMachine, ...parsed, password: "" }
			: defaultMachine;
	} catch {
		return defaultMachine;
	}
}

function storeMachine(machine: MachineConfig): void {
	const { password: _password, ...storedMachine } = machine;
	window.localStorage.setItem(machineStorageKey, JSON.stringify(storedMachine));
}

function packageLabel(item: DeployPackageSummary): string {
	return item.name === item.serviceName
		? item.name
		: `${item.name} (${item.serviceName})`;
}

function parseDeployStreamLine(
	line: string,
	onEvent: DeployStreamEventHandler
): void {
	if (line.trim()) {
		onEvent(JSON.parse(line) as DeployStreamEvent);
	}
}

function flushDeployStreamBuffer(
	buffer: string,
	onEvent: DeployStreamEventHandler
): string {
	let remaining = buffer;
	let lineEnd = remaining.indexOf("\n");
	while (lineEnd >= 0) {
		parseDeployStreamLine(remaining.slice(0, lineEnd), onEvent);
		remaining = remaining.slice(lineEnd + 1);
		lineEnd = remaining.indexOf("\n");
	}
	return remaining;
}

async function readDeployStream(
	response: Response,
	onEvent: DeployStreamEventHandler
): Promise<void> {
	if (!response.ok) {
		throw new Error(await response.text());
	}
	if (!response.body) {
		throw new Error("Deploy stream response is empty.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = flushDeployStreamBuffer(buffer, onEvent);
		if (done) {
			break;
		}
	}
	parseDeployStreamLine(buffer, onEvent);
}

function DeployPageLoading() {
	return (
		<PageContainer isLoading pageTitle="Deploy">
			<Skeleton className="h-96 w-full" />
		</PageContainer>
	);
}

function DeployOutput({
	isDeploying,
	output,
}: {
	isDeploying: boolean;
	output: string;
}) {
	const outputEndRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		outputEndRef.current?.scrollIntoView({ block: "end" });
	});

	return (
		<Card className="min-h-[460px]">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Terminal data-icon="inline-start" />
					Output
				</CardTitle>
				<CardDescription>
					{isDeploying
						? "Streaming deployment output."
						: "git pull and deploy output."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{output || isDeploying ? (
					<ScrollArea className="h-[560px] min-h-[360px] rounded-md border bg-muted/30">
						<pre className="min-h-[560px] whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed">
							{output}
							<span ref={outputEndRef} />
						</pre>
					</ScrollArea>
				) : (
					<Empty className="min-h-[360px] border border-dashed">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Database />
							</EmptyMedia>
							<EmptyTitle>No deployment has run.</EmptyTitle>
							<EmptyDescription>Output will appear here.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</CardContent>
		</Card>
	);
}

function PackagePicker({
	allPackageNames,
	allSelected,
	packageItems,
	selectedPackageSet,
	selectedPackageSummaries,
	onToggleAll,
	onTogglePackage,
}: {
	allPackageNames: string[];
	allSelected: boolean;
	packageItems: DeployPackageSummary[];
	selectedPackageSet: Set<string>;
	selectedPackageSummaries: DeployPackageSummary[];
	onToggleAll: () => void;
	onTogglePackage: (packageName: string, checked: boolean) => void;
}) {
	return (
		<FieldSet>
			<div className="flex items-center justify-between gap-2">
				<FieldLegend className="mb-0">Packages</FieldLegend>
				<Button
					disabled={allPackageNames.length === 0}
					onClick={onToggleAll}
					size="sm"
					type="button"
					variant="outline"
				>
					{allSelected ? "Clear" : "Select all"}
				</Button>
			</div>
			<ScrollArea className="h-60 rounded-md border bg-background">
				<FieldGroup className="gap-0 p-1" data-slot="checkbox-group">
					{packageItems.map((item) => {
						const checked = selectedPackageSet.has(item.name);
						const checkboxId = `deploy-package-${item.name}`;
						return (
							<Field
								className="rounded-md px-3 py-2 transition-colors hover:bg-muted/60 has-data-checked:bg-muted/45"
								data-checked={checked ? "true" : undefined}
								key={item.name}
								orientation="horizontal"
							>
								<Checkbox
									aria-label={`Select ${packageLabel(item)}`}
									checked={checked}
									id={checkboxId}
									onCheckedChange={(nextChecked) =>
										onTogglePackage(item.name, nextChecked)
									}
								/>
								<FieldContent>
									<FieldLabel
										className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"
										htmlFor={checkboxId}
									>
										<span className="font-medium">{item.name}</span>
										{item.name === item.serviceName ? null : (
											<Badge variant="outline">{item.serviceName}</Badge>
										)}
									</FieldLabel>
									<FieldDescription className="text-sm">
										{item.moduleRoot}
									</FieldDescription>
									{item.description ? (
										<FieldDescription className="text-sm">
											{item.description}
										</FieldDescription>
									) : null}
								</FieldContent>
							</Field>
						);
					})}
				</FieldGroup>
			</ScrollArea>
			<FieldDescription className="flex items-center gap-2">
				<Package data-icon="inline-start" />
				{selectedPackageSummaries.length} selected
			</FieldDescription>
		</FieldSet>
	);
}

function MachineConfigFields({
	hostWarning,
	machine,
	onMachineChange,
}: {
	hostWarning: string;
	machine: MachineConfig;
	onMachineChange: (machine: MachineConfig) => void;
}) {
	return (
		<FieldSet>
			<FieldLegend>Machine</FieldLegend>
			<Field data-invalid={hostWarning ? "true" : undefined}>
				<FieldLabel htmlFor="deploy-host">Machine host</FieldLabel>
				<Input
					aria-invalid={Boolean(hostWarning)}
					autoComplete="url"
					id="deploy-host"
					onChange={(event) =>
						onMachineChange({ ...machine, host: event.target.value })
					}
					placeholder="192.168.1.20"
					value={machine.host}
				/>
				{hostWarning ? <FieldError>{hostWarning}</FieldError> : null}
			</Field>

			<div className="grid gap-3 sm:grid-cols-2">
				<Field>
					<FieldLabel htmlFor="deploy-user">SSH user</FieldLabel>
					<Input
						autoComplete="username"
						id="deploy-user"
						onChange={(event) =>
							onMachineChange({ ...machine, user: event.target.value })
						}
						value={machine.user}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="deploy-port">SSH port</FieldLabel>
					<Input
						id="deploy-port"
						inputMode="numeric"
						onChange={(event) =>
							onMachineChange({ ...machine, port: event.target.value })
						}
						value={machine.port}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="deploy-domain">ROS domain</FieldLabel>
					<Input
						id="deploy-domain"
						inputMode="numeric"
						onChange={(event) =>
							onMachineChange({ ...machine, domainId: event.target.value })
						}
						value={machine.domainId}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="deploy-platform">Platform</FieldLabel>
					<Select
						onValueChange={(platform) => {
							if (platform) {
								onMachineChange({ ...machine, platform });
							}
						}}
						value={machine.platform}
					>
						<SelectTrigger className="w-full" id="deploy-platform">
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="start" className="w-(--anchor-width)">
							<SelectGroup>
								<SelectItem value="auto">Auto</SelectItem>
								<SelectItem value="linux/arm64">linux/arm64</SelectItem>
								<SelectItem value="linux/amd64">linux/amd64</SelectItem>
								<SelectItem value="linux/arm/v7">linux/arm/v7</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
			</div>

			<Field>
				<FieldLabel htmlFor="deploy-password">SSH password</FieldLabel>
				<Input
					autoComplete="current-password"
					id="deploy-password"
					onChange={(event) =>
						onMachineChange({ ...machine, password: event.target.value })
					}
					placeholder="Optional"
					type="password"
					value={machine.password}
				/>
			</Field>
		</FieldSet>
	);
}

function DeployStatusAlerts({
	deployError,
	packagesError,
}: {
	deployError: string;
	packagesError?: string;
}) {
	if (!(packagesError || deployError)) {
		return null;
	}

	return (
		<FieldSet>
			<FieldLegend>Status</FieldLegend>
			{packagesError ? (
				<Alert variant="destructive">
					<CircleAlert data-icon="inline-start" />
					<AlertTitle>Package discovery failed</AlertTitle>
					<AlertDescription>{packagesError}</AlertDescription>
				</Alert>
			) : null}
			{deployError ? (
				<Alert variant="destructive">
					<CircleAlert data-icon="inline-start" />
					<AlertTitle>Deploy failed</AlertTitle>
					<AlertDescription>{deployError}</AlertDescription>
				</Alert>
			) : null}
		</FieldSet>
	);
}

function DeployActions({
	canDeploy,
	isDeploying,
	isFetchingPackages,
	onRefresh,
	onStartDeploy,
}: {
	canDeploy: boolean;
	isDeploying: boolean;
	isFetchingPackages: boolean;
	onRefresh: () => void;
	onStartDeploy: () => void;
}) {
	return (
		<div className="flex flex-wrap justify-end gap-2">
			<Button
				disabled={isFetchingPackages}
				onClick={onRefresh}
				type="button"
				variant="outline"
			>
				{isFetchingPackages ? (
					<Spinner data-icon="inline-start" />
				) : (
					<RefreshCw data-icon="inline-start" />
				)}
				Refresh
			</Button>
			<Button disabled={!canDeploy} onClick={onStartDeploy} type="button">
				{isDeploying ? (
					<>
						<Spinner data-icon="inline-start" />
						Deploying
					</>
				) : (
					<>
						<Rocket data-icon="inline-start" />
						Start Deploy
					</>
				)}
			</Button>
		</div>
	);
}

export function DeployPage() {
	const queryClient = useQueryClient();
	const packages = useQuery(trpc.deploy.packages.queryOptions());
	const [selectedPackages, setSelectedPackages] = useState<string[]>([]);
	const [deployError, setDeployError] = useState("");
	const [deployOutput, setDeployOutput] = useState("");
	const [isDeploying, setIsDeploying] = useState(false);
	const [machine, setMachine] = useState<MachineConfig>(defaultMachine);
	const [rememberReady, setRememberReady] = useState(false);

	useEffect(() => {
		setMachine(loadMachine());
		setRememberReady(true);
	}, []);

	useEffect(() => {
		if (rememberReady) {
			storeMachine(machine);
		}
	}, [machine, rememberReady]);

	useEffect(() => {
		if (!packages.data?.[0]) {
			return;
		}
		setSelectedPackages((current) => {
			const availableNames = new Set(packages.data.map((item) => item.name));
			const nextSelected = current.filter((name) => availableNames.has(name));
			if (nextSelected.length === 0) {
				nextSelected.push(packages.data[0].name);
			}
			if (
				nextSelected.length === current.length &&
				nextSelected.every((name, index) => name === current[index])
			) {
				return current;
			}
			return nextSelected;
		});
	}, [packages.data]);

	const packageItems = packages.data ?? [];
	const allPackageNames = useMemo(
		() => packageItems.map((item) => item.name),
		[packageItems]
	);
	const packageByName = useMemo(
		() => new Map(packageItems.map((item) => [item.name, item])),
		[packageItems]
	);
	const selectedPackageSet = useMemo(
		() => new Set(selectedPackages),
		[selectedPackages]
	);
	const selectedDeployPackageNames = useMemo(
		() => selectedPackages.filter((name) => packageByName.has(name)),
		[selectedPackages, packageByName]
	);
	const selectedPackageSummaries = useMemo(
		() =>
			selectedDeployPackageNames
				.map((name) => packageByName.get(name))
				.filter((item): item is DeployPackageSummary => Boolean(item)),
		[selectedDeployPackageNames, packageByName]
	);
	const allSelected =
		allPackageNames.length > 0 &&
		selectedDeployPackageNames.length === allPackageNames.length;
	const hostWarning =
		machine.host.trim() && !hostPattern.test(machine.host.trim())
			? "Host can only contain letters, numbers, dots, and dashes."
			: "";
	const canDeploy =
		selectedDeployPackageNames.length > 0 &&
		hostPattern.test(machine.host.trim()) &&
		Boolean(machine.user.trim()) &&
		!isDeploying;

	const togglePackage = (packageName: string, checked: boolean) => {
		setSelectedPackages((current) => {
			if (checked) {
				return current.includes(packageName)
					? current
					: [...current, packageName];
			}
			return current.filter((name) => name !== packageName);
		});
	};

	const toggleAllPackages = () => {
		setSelectedPackages(allSelected ? [] : allPackageNames);
	};

	const startDeploy = async () => {
		if (!canDeploy) {
			return;
		}
		setDeployError("");
		setDeployOutput("Starting deploy...\n");
		setIsDeploying(true);

		const payload = {
			domainId: safeInteger(machine.domainId, 42),
			host: machine.host.trim(),
			packageNames: selectedDeployPackageNames,
			password: machine.password || undefined,
			platform:
				machine.platform && machine.platform !== "auto"
					? machine.platform
					: undefined,
			port: safeInteger(machine.port, 22),
			user: machine.user.trim() || "jetson",
		};

		let streamError = "";
		let sawDone = false;
		const appendOutput = (text: string) => {
			setDeployOutput((current) => `${current}${text}`);
		};
		const handleStreamEvent = (event: DeployStreamEvent) => {
			if (event.type === "chunk") {
				appendOutput(event.text);
				return;
			}
			if (event.type === "error") {
				streamError = event.message;
				appendOutput(`\nERROR: ${event.message}\n`);
				return;
			}
			sawDone = true;
		};

		try {
			const response = await fetch("/api/deploy/stream", {
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			await readDeployStream(response, handleStreamEvent);

			if (streamError) {
				setDeployError(streamError);
				toast.error("Deploy command failed.");
			} else if (sawDone) {
				toast.success("Deploy command completed.");
			} else {
				throw new Error("Deploy stream ended before completion.");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setDeployError(message);
			appendOutput(`\nERROR: ${message}\n`);
			toast.error("Deploy command failed.");
		} finally {
			setIsDeploying(false);
		}
	};

	if (packages.isLoading) {
		return <DeployPageLoading />;
	}

	return (
		<PageContainer
			pageDescription="Pick packages, enter a machine, deploy."
			pageHeaderAction={
				<>
					<Badge variant="outline">
						<GitPullRequestArrow data-icon="inline-start" />
						git pull origin main
					</Badge>
					<Badge variant="secondary">
						<Server data-icon="inline-start" />
						{packages.data?.length ?? 0} packages
					</Badge>
				</>
			}
			pageTitle="Deploy"
		>
			<div className="grid gap-4 xl:grid-cols-[minmax(420px,0.55fr)_minmax(0,1fr)]">
				<Card>
					<CardHeader>
						<CardTitle>Deploy</CardTitle>
						<CardDescription>
							Starts with git pull origin main, then ./pr ros2:deploy.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<FieldGroup>
							<PackagePicker
								allPackageNames={allPackageNames}
								allSelected={allSelected}
								onToggleAll={toggleAllPackages}
								onTogglePackage={togglePackage}
								packageItems={packageItems}
								selectedPackageSet={selectedPackageSet}
								selectedPackageSummaries={selectedPackageSummaries}
							/>

							<Separator />

							<MachineConfigFields
								hostWarning={hostWarning}
								machine={machine}
								onMachineChange={setMachine}
							/>

							<DeployStatusAlerts
								deployError={deployError}
								packagesError={packages.error?.message}
							/>

							<Separator />

							<DeployActions
								canDeploy={canDeploy}
								isDeploying={isDeploying}
								isFetchingPackages={packages.isFetching}
								onRefresh={() =>
									queryClient.invalidateQueries(
										trpc.deploy.packages.queryFilter()
									)
								}
								onStartDeploy={startDeploy}
							/>
						</FieldGroup>
					</CardContent>
				</Card>

				<DeployOutput isDeploying={isDeploying} output={deployOutput} />
			</div>
		</PageContainer>
	);
}
