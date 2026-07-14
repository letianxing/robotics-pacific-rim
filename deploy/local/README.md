# deploy-local

Local development deployment for Pacific-Rim modules.

Use this project for local node composition, mock adapters, and environment
files that help run robot capabilities on a developer machine.

Shared deployment endpoints live in `platform.yaml`. Keep cross-service hostnames
and public IPs there instead of repeating them in each module config.

Observability starts with `observability/otel-collector.yaml`, a local
OpenTelemetry Collector config that accepts OTLP traces, metrics, and logs on
container ports `4317` and `4318`, exposed locally as `8634` and `8636`. The
Collector is the platform ingress point and fans out signals to Loki,
Prometheus, Tempo, and the debug exporter.

ROS2 development runs through `ros2/compose.yaml`:

```bash
scripts/ros2-docker.sh build-image
scripts/ros2-docker.sh up-observability
scripts/ros2-docker.sh shell
scripts/ros2-docker.sh build --packages-select <ros2_package>
```

Set `ROS_DISTRO=humble` by default, or override it with another ROS image tag.
For Go ROS2 native topic backends, run builds with
`PACIFIC_RIM_GO_BUILD_TAGS=pacific_rim_ros2_rclgo`.

Vision dependencies are opt-in. Use `ENABLE_VISION_STACK=1` for common
OpenCV/ROS2/ONNX packages, or set `VISION_TARGET=pc-nvidia|jetson|auto` to also
add the matching local Docker runtime overlay. `auto` maps `amd64`/`x86_64` to
`pc-nvidia` and `arm64`/`aarch64` to `jetson`. NVIDIA targets require matching
CUDA/TensorRT apt sources or a compatible base image.

By default, local ROS2 runs send telemetry to the local Collector at
`http://localhost:8636`. To point at a different remote Collector, update
`platform.observability.otlp_endpoint` in `platform.yaml`:

```yaml
platform:
  observability:
    otlp_endpoint: "http://<remote-server-ip>:8636"
```

`PLATFORM_OTLP_ENDPOINT` can still be set for one-off local overrides. To send
telemetry to an observability stack running in the same Docker Compose network,
use `PLATFORM_OTLP_ENDPOINT=http://otel-collector:4318`.

For example, to send local ROS2 module telemetry to a remote Collector:

```bash
PLATFORM_OTLP_ENDPOINT=http://<remote-server-ip>:8636 ./pr ros2:run <ros2_package>
```

Runtime endpoints are published on `0.0.0.0`. Use `localhost` on the same
machine, or replace it with the host IP from another machine.

Runtime endpoints:

- Grafana: `http://localhost:16000`
- Prometheus: `http://localhost:18180`
- Loki: `http://localhost:6200`
- Tempo: `http://localhost:6400`
- OTLP HTTP: `http://localhost:8636`
- OTLP gRPC: `localhost:8634`
- Collector Prometheus exporter: `http://localhost:18928/metrics`
