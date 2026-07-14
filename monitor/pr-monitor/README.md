# pr-monitor

TypeScript terminal monitor for Pacific-Rim communication routes.

The interaction model references VLink's monitor design: discovery-style route
listing, per-route sampling, trend charts, process panels, and Enter-to-detail
navigation. The displayed data and terminology are Pacific-Rim oriented:
ROS2/NATS/CycloneDDS bindings, module services, IDL names, and route health.

```bash
bun run monitor/pr-monitor/src/index.ts --loc -x
```

Route rows are discovered from this repository's real communication manifests:

- `pkg/idl/**/public/interfaces.yaml`
- `module/service/**/config.yaml`
- bridge YAML such as `module/service/<service>/bridge/nats/*.yaml`

Runtime data is collected from available local sources:

- local process table (`ps`)
- Prometheus (`PR_MONITOR_PROMETHEUS_URL`, default from `deploy/local/platform.yaml`)
- native CycloneDDS route sampling for `cyclonedds://` endpoints
- ROS2 CLI (`ros2 topic list`, `ros2 service list`, sampled `ros2 topic hz/bw`, default CycloneDDS RMW)

The native CycloneDDS sampler builds a small local helper when CycloneDDS
development headers are available. If not, it starts a dedicated
`pacific-rim-ros2-monitor-<distro>` container with
`scripts/ros2-docker.sh monitor-container` and samples from there. Runtime
domains are auto-detected from running Docker containers and Linux
`/proc/*/environ`; use `PR_MONITOR_ROS_DOMAIN_IDS=0,42` only to force an
explicit scan set.

If a runtime source is not running, metrics stay `---`; pr-monitor does not
fabricate frequency, rate, loss, or latency values.

```bash
bun run monitor/pr-monitor/src/index.ts --list-routes
```

Print a vlink-list style process topology view:

```bash
./pr monitor list
./pr monitor list -i upperbody
bun run monitor/pr-monitor/src/index.ts --list-processes
```

Hotkeys mirror the monitor workflow where possible: arrows navigate, `Space`
pauses, `L/O/S/T/E/A/Y/P/C` toggle modes, `I` edits the route filter, and
`Enter` opens the selected route detail view.
