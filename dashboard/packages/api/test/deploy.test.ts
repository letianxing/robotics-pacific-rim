import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
	buildDeployImageArgs,
	buildDeployImageCommands,
	parseRosPackageName,
	streamDeployPackage,
	validateDeployTarget,
} from "../src/routers/deploy";

const invalidDeployHostPattern = /Invalid deploy host/;
const gitPullCommandPattern = /^\$ git pull origin main\n/;
const gitOutputPattern = /\ngit output\n/;
const deployCommandPattern = /\$ \.\/pr ros2:deploy --host 192\.168\.1\.20/;
const deployOutputPattern = /\n\.\/pr output\n/;

describe("deploy router helpers", () => {
	it("parses a ROS package name from package.xml", () => {
		assert.equal(
			parseRosPackageName("<package><name>motion_control</name></package>"),
			"motion_control"
		);
	});

	it("builds pr ros2:deploy args from structured fields", () => {
		const args = buildDeployImageArgs({
			domainId: 42,
			host: "192.168.1.20",
			logsTail: 80,
			packageName: "remote",
			port: 2222,
			user: "jetson",
		});

		assert.deepEqual(args, [
			"ros2:deploy",
			"--host",
			"192.168.1.20",
			"--user",
			"jetson",
			"--port",
			"2222",
			"--packages-select",
			"remote",
			"--domain-id",
			"42",
			"--logs-tail",
			"80",
		]);
	});

	it("builds one pr ros2:deploy command for each selected package", () => {
		const commands = buildDeployImageCommands({
			domainId: 42,
			host: "192.168.1.20",
			logsTail: 80,
			packageNames: ["remote", "motion_control"],
			port: 2222,
			user: "jetson",
		});

		assert.deepEqual(
			commands.map((command) => command.args),
			[
				[
					"ros2:deploy",
					"--host",
					"192.168.1.20",
					"--user",
					"jetson",
					"--port",
					"2222",
					"--packages-select",
					"remote",
					"--domain-id",
					"42",
					"--logs-tail",
					"80",
				],
				[
					"ros2:deploy",
					"--host",
					"192.168.1.20",
					"--user",
					"jetson",
					"--port",
					"2222",
					"--packages-select",
					"motion_control",
					"--domain-id",
					"42",
					"--logs-tail",
					"80",
				],
			]
		);
	});

	it("streams git pull and pr ros2:deploy output in command order", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "deploy-stream-test-"));
		await mkdir(path.join(repoRoot, "infra"));
		await mkdir(path.join(repoRoot, "pkg"));
		await mkdir(path.join(repoRoot, "module", "service", "remote_service"), {
			recursive: true,
		});
		await writeFile(
			path.join(repoRoot, "module", "service", "remote_service", "package.xml"),
			"<package><name>remote</name><description>Remote</description></package>"
		);

		const calls: string[] = [];
		const chunks: string[] = [];
		await streamDeployPackage(
			{
				domainId: 42,
				host: "192.168.1.20",
				logsTail: 80,
				packageNames: ["remote"],
				port: 2222,
				user: "jetson",
			},
			(chunk) => {
				chunks.push(chunk);
			},
			{
				repoRoot,
				runCommand: async (command, args, _cwd, onChunk) => {
					calls.push([command, ...args].join(" "));
					await onChunk(`${command} output\n`);
					return { stderr: "", stdout: `${command} output\n` };
				},
			}
		);

		assert.deepEqual(calls, [
			"git pull origin main",
			"./pr ros2:deploy --host 192.168.1.20 --user jetson --port 2222 --packages-select remote --domain-id 42 --logs-tail 80",
		]);
		const output = chunks.join("");
		assert.match(output, gitPullCommandPattern);
		assert.match(output, gitOutputPattern);
		assert.match(output, deployCommandPattern);
		assert.match(output, deployOutputPattern);
	});

	it("rejects shell metacharacters in deploy target fields", () => {
		assert.throws(
			() =>
				validateDeployTarget({
					host: "robot.local; reboot",
					port: 22,
					user: "jetson",
				}),
			invalidDeployHostPattern
		);
	});
});
