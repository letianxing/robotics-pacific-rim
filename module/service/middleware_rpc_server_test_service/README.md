# module-middleware_rpc_server_test_service

Middleware Rpc Server Test ROS2 Go module.

The process entrypoint starts shared communication bootstrap from
`infra/communication/go`. Define public IDL under `pkg/idl/middleware_rpc_server_test_service/{pb,ros2,public}`,
bind logical services/topics in `config/config.yaml`, run
`tools/generate-interfaces.sh`, then implement business behavior under
`internal/service`.

`protobuf message` may be used as a topic payload over NATS or CycloneDDS byte
transport. `protobuf request/response` contracts are transport-neutral: they may
be carried by `nats_rpc` or by `cyclonedds_rpc` with
`standard: omg_dds_rpc|rmw_cyclonedds`; the adapter lives in
`infra/communication/dds`.
