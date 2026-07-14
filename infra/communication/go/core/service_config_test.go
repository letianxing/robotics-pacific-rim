package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

func TestServiceCommunicationConfigBuild(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"action_nats": {
				Transport: "nats",
				ServerURL: "nats://example:4222",
			},
			"motion_dds": {
				Transport: "cyclonedds",
				DomainID:  3,
				QoS: map[string]any{
					"reliability": "reliable",
					"durability":  "transient_local",
				},
			},
		},
		Topics: map[string]TopicRouteConfig{
			"robot_state": {
				Transport: "cyclonedds_topic",
				Direction: "subscribe",
				Topic:     "RobotState",
				Payload:   PayloadConfig{Format: "ros2_msg", Type: "demo/msg/RobotState"},
				QueueSize: 5,
				QoS: map[string]any{
					"reliability": "best_effort",
					"deadline_ms": 50,
				},
			},
		},
		Services: map[string]ServiceRouteConfig{
			"play_action": {
				Transport:   "nats_rpc",
				NATSSubject: "robot.rpc.play_action",
				Timeout:     2 * time.Second,
			},
		},
	}

	buses, topics, services, err := cfg.Build("robo-brain")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if buses["action_nats"].Transport != communication.TransportNATS {
		t.Fatalf("expected NATS middleware, got %#v", buses["action_nats"])
	}
	if topics[0].Subscriber.Address != "RobotState" {
		t.Fatalf("expected DDS topic subscriber, got %#v", topics[0])
	}
	if topics[0].Subscriber.MessageType != "demo/msg/RobotState" {
		t.Fatalf("expected payload type to drive message type, got %#v", topics[0])
	}
	if buses["motion_dds"].Options["qos.reliability"] != "reliable" {
		t.Fatalf("expected middleware QoS options, got %#v", buses["motion_dds"].Options)
	}
	if topics[0].Subscriber.Metadata["qos.reliability"] != "best_effort" ||
		topics[0].Subscriber.Metadata["qos.deadline_ms"] != "50" ||
		topics[0].Subscriber.Metadata["qos.depth"] != "5" {
		t.Fatalf("expected route QoS metadata, got %#v", topics[0].Subscriber.Metadata)
	}
	if services[0].Server.Address != "robot.rpc.play_action" {
		t.Fatalf("expected NATS RPC subject, got %#v", services[0])
	}
	if services[0].TimeoutMS != 2000 {
		t.Fatalf("expected 2000ms timeout, got %d", services[0].TimeoutMS)
	}
}

func TestServiceCommunicationConfigBuildExpandsBindings(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"action_nats": {Transport: "nats"},
		},
		Topics: map[string]TopicRouteConfig{
			"robot_state": {
				Direction:   "publish",
				MessageType: "RobotState",
				Bindings: []TopicRouteConfig{
					{Transport: "ros2_topic", Topic: "/robot/state"},
					{Transport: "nats_topic", Middleware: "action_nats", Subject: "robot.state"},
				},
			},
		},
		Services: map[string]ServiceRouteConfig{
			"play_action": {
				ServiceType: "action_service/srv/PlayAction",
				Bindings: []ServiceRouteConfig{
					{Transport: "ros2_service", Service: "/action_service_node/play_action"},
					{Transport: "nats_rpc", Middleware: "action_nats", Subject: "robot.rpc.play_action"},
				},
			},
		},
	}

	_, topics, services, err := cfg.Build("robo-brain")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if len(topics) != 2 {
		t.Fatalf("expected two topic bindings, got %#v", topics)
	}
	if topics[0].Publisher.Metadata["logical_route"] != "robot_state" &&
		topics[1].Publisher.Metadata["logical_route"] != "robot_state" {
		t.Fatalf("expected logical route metadata, got %#v", topics)
	}
	if len(services) != 2 {
		t.Fatalf("expected two service bindings, got %#v", services)
	}
	addresses := map[string]bool{}
	for _, route := range services {
		addresses[route.Server.Address] = true
	}
	if !addresses["/action_service_node/play_action"] || !addresses["robot.rpc.play_action"] {
		t.Fatalf("expected ROS2 and NATS service bindings, got %#v", services)
	}
}

func TestServiceCommunicationConfigBuildsCycloneDDSRPCMetadata(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"motion_dds": {Transport: "cyclonedds"},
		},
		Services: map[string]ServiceRouteConfig{
			"plan_action": {
				Contract: PayloadConfig{Format: "protobuf_rpc", Type: "demo.Planner/Plan"},
				Bindings: []ServiceRouteConfig{
					{
						Transport:  "cyclonedds_rpc",
						Middleware: "motion_dds",
						Standard:   "rmw_cyclonedds",
						Request:    "planner.request.plan_action",
						Response:   "planner.response.plan_action",
					},
				},
			},
		},
	}

	_, _, services, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if len(services) != 1 {
		t.Fatalf("expected one service binding, got %#v", services)
	}
	route := services[0]
	if route.Server.Transport != communication.TransportCycloneDDS {
		t.Fatalf("expected CycloneDDS route, got %#v", route.Server)
	}
	if route.Server.Address != "planner.request.plan_action" {
		t.Fatalf("expected request channel as server address, got %#v", route.Server)
	}
	if route.Server.MessageType != "demo.Planner/Plan" {
		t.Fatalf("expected contract type, got %#v", route.Server)
	}
	if route.Server.Metadata["rpc.standard"] != "rmw_cyclonedds" ||
		route.Server.Metadata["rpc.request_channel"] != "planner.request.plan_action" ||
		route.Server.Metadata["rpc.response_channel"] != "planner.response.plan_action" {
		t.Fatalf("expected DDS RPC metadata, got %#v", route.Server.Metadata)
	}
}

func TestServiceCommunicationConfigExpandsHighLevelRoutes(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Topics: map[string]TopicRouteConfig{
			"proto_state": {
				Data:       "proto",
				Type:       "demo.RobotState",
				Middleware: "ros2",
				Topic:      "/demo/proto_state",
				Direction:  "publish",
			},
			"type_only_proto_state": {
				Type:       "demo.TypeOnlyState",
				Middleware: "cyclonedds",
				Topic:      "/demo/type_only_proto_state",
				Direction:  "publish",
			},
			"joint_state": {
				Data:       "msg",
				Type:       "sensor_msgs/msg/JointState",
				Middleware: "cyclonedds",
				Topic:      "JointState",
				Direction:  "subscribe",
				QueueSize:  7,
			},
			"fast_state": {
				Data:       "proto",
				Type:       "demo.FastState",
				Middleware: "fastdds",
				Topic:      "/demo/fast_state",
				Direction:  "publish",
			},
			"dds_idl_state": {
				Data:       "dds_idl",
				Type:       "demo::DdsState",
				Middleware: "fastdds",
				Topic:      "/demo/dds_idl_state",
				Direction:  "publish",
			},
			"omg_idl_state": {
				Data:       "omg_idl",
				Type:       "demo::OmgState",
				Middleware: "cyclonedds",
				Topic:      "/demo/omg_idl_state",
				Direction:  "publish",
			},
			"cyclone_rmw_state": {
				Data:       "msg",
				Type:       "demo/msg/CycloneRMWState",
				Middleware: "cyclonedds",
				Topic:      "/demo/cyclone_rmw_state",
				Direction:  "publish",
			},
		},
		Services: map[string]ServiceRouteConfig{
			"plan_action": {
				Data:       "proto",
				Type:       "demo.Planner/Plan",
				Middleware: "cyclonedds",
				Service:    "/demo/plan_action",
			},
			"type_only_plan": {
				Type:       "demo.Planner/TypeOnlyPlan",
				Middleware: "cyclonedds",
				Service:    "/demo/type_only_plan",
			},
			"play_action": {
				Data:       "srv",
				Type:       "demo/srv/PlayAction",
				Middleware: "ros2",
				Service:    "/demo/play_action",
			},
			"fast_play": {
				Data:       "srv",
				Type:       "demo/srv/FastPlay",
				Middleware: "fastdds",
				Service:    "/demo/fast_play",
			},
			"dds_idl_plan": {
				Data:       "dds_idl",
				Type:       "demo::DdsPlanner",
				Middleware: "fastdds",
				Service:    "/demo/dds_idl_plan",
			},
			"omg_idl_plan": {
				Data:       "omg_idl",
				Type:       "demo::OmgPlanner",
				Middleware: "cyclonedds",
				Service:    "/demo/omg_idl_plan",
			},
			"cyclone_rmw_plan": {
				Data:       "srv",
				Type:       "demo/srv/CycloneRMWPlan",
				Middleware: "cyclonedds",
				Service:    "/demo/cyclone_rmw_plan",
			},
		},
	}

	buses, topics, services, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if buses["ros2"].Transport != communication.TransportROS2 {
		t.Fatalf("expected generated default ROS2 middleware, got %#v", buses)
	}
	if buses["cyclonedds"].Transport != communication.TransportCycloneDDS ||
		buses["cyclonedds"].Options["implementation"] != "native_cyclonedds" {
		t.Fatalf("expected native CycloneDDS middleware for proto routes, got %#v", buses["cyclonedds"])
	}
	if buses["cyclonedds__rmw"].Transport != communication.TransportROS2 ||
		buses["cyclonedds__rmw"].Options["middleware.family"] != "cyclonedds" ||
		buses["cyclonedds__rmw"].Options["implementation"] != "rmw_cyclonedds" ||
		buses["cyclonedds__rmw"].Options["rmw_implementation"] != "rmw_cyclonedds_cpp" {
		t.Fatalf("expected internal CycloneDDS RMW middleware, got %#v", buses["cyclonedds__rmw"])
	}
	if buses["fastdds__rmw"].Transport != communication.TransportROS2 ||
		buses["fastdds__rmw"].Options["middleware.family"] != "fastdds" ||
		buses["fastdds__rmw"].Options["implementation"] != "rmw_fastrtps" ||
		buses["fastdds__rmw"].Options["rmw_implementation"] != "rmw_fastrtps_cpp" {
		t.Fatalf("expected internal Fast DDS RMW middleware, got %#v", buses["fastdds__rmw"])
	}
	if buses["fastdds"].Transport != communication.TransportFastDDS ||
		buses["fastdds"].Options["middleware.family"] != "fastdds" ||
		buses["fastdds"].Options["implementation"] != "native_fastdds" {
		t.Fatalf("expected native Fast DDS middleware for proto routes, got %#v", buses["fastdds"])
	}
	topicByName := map[string]communication.PubSubRoute{}
	for _, route := range topics {
		topicByName[route.Name] = route
	}
	protoState := topicByName["proto_state"]
	if protoState.Publisher.Transport != communication.TransportROS2 ||
		protoState.Publisher.Metadata["adapter"] != "ros2_proto_envelope" ||
		protoState.Publisher.Metadata["codec"] != "protobuf" ||
		protoState.Publisher.Metadata["schema.type"] != "demo.RobotState" {
		t.Fatalf("expected high-level proto+ros2 topic expansion, got %#v", protoState.Publisher)
	}
	typeOnlyProtoState := topicByName["type_only_proto_state"]
	if typeOnlyProtoState.Publisher.Transport != communication.TransportCycloneDDS ||
		typeOnlyProtoState.Publisher.Metadata["middleware.implementation"] != "native_cyclonedds" ||
		typeOnlyProtoState.Publisher.Metadata["codec"] != "protobuf" ||
		typeOnlyProtoState.Publisher.Metadata["schema.type"] != "demo.TypeOnlyState" {
		t.Fatalf("expected type-only proto+cyclonedds topic expansion, got %#v", typeOnlyProtoState.Publisher)
	}
	jointState := topicByName["joint_state"]
	if jointState.Subscriber.Transport != communication.TransportROS2 ||
		jointState.Subscriber.Metadata["middleware"] != "cyclonedds" ||
		jointState.Subscriber.Metadata["middleware.runtime"] != "cyclonedds__rmw" ||
		jointState.Subscriber.Metadata["middleware.family"] != "cyclonedds" ||
		jointState.Subscriber.Metadata["middleware.implementation"] != "rmw_cyclonedds" ||
		jointState.Subscriber.MessageType != "sensor_msgs/msg/JointState" ||
		jointState.Subscriber.Metadata["qos.depth"] != "7" {
		t.Fatalf("expected high-level msg+cyclonedds RMW topic expansion, got %#v", jointState.Subscriber)
	}
	fastState := topicByName["fast_state"]
	if fastState.Publisher.Transport != communication.TransportFastDDS ||
		fastState.Publisher.Metadata["middleware"] != "fastdds" ||
		fastState.Publisher.Metadata["middleware.family"] != "fastdds" ||
		fastState.Publisher.Metadata["middleware.implementation"] != "native_fastdds" ||
		fastState.Publisher.Metadata["adapter"] != "" ||
		fastState.Publisher.Metadata["codec"] != "protobuf" ||
		fastState.Publisher.Metadata["schema.type"] != "demo.FastState" {
		t.Fatalf("expected high-level proto+fastdds native topic expansion, got %#v", fastState.Publisher)
	}
	ddsIDLState := topicByName["dds_idl_state"]
	if ddsIDLState.Publisher.Transport != communication.TransportFastDDS ||
		ddsIDLState.Publisher.Metadata["middleware.implementation"] != "native_fastdds" ||
		ddsIDLState.Publisher.Metadata["codec"] != "cdr" ||
		ddsIDLState.Publisher.Metadata["schema.format"] != "dds_idl" ||
		ddsIDLState.Publisher.Metadata["schema.language"] != "omg_idl" ||
		ddsIDLState.Publisher.Metadata["schema.type"] != "demo::DdsState" ||
		ddsIDLState.Publisher.Metadata["dds.mode"] != "typed_preferred" ||
		ddsIDLState.Publisher.Metadata["dds.fallback"] != "byte_envelope" ||
		ddsIDLState.Publisher.Metadata["dds.runtime"] != "typed_native" ||
		ddsIDLState.Publisher.Metadata["dds.type"] != "demo::DdsState" {
		t.Fatalf("expected high-level dds_idl+fastdds native topic expansion, got %#v", ddsIDLState.Publisher)
	}
	omgIDLState := topicByName["omg_idl_state"]
	if omgIDLState.Publisher.Transport != communication.TransportCycloneDDS ||
		omgIDLState.Publisher.Metadata["middleware.implementation"] != "native_cyclonedds" ||
		omgIDLState.Publisher.Metadata["schema.format"] != "dds_idl" ||
		omgIDLState.Publisher.Metadata["schema.language"] != "omg_idl" {
		t.Fatalf("expected high-level omg_idl alias to select native CycloneDDS topic, got %#v", omgIDLState.Publisher)
	}
	cycloneRMWState := topicByName["cyclone_rmw_state"]
	if cycloneRMWState.Publisher.Transport != communication.TransportROS2 ||
		cycloneRMWState.Publisher.Metadata["middleware"] != "cyclonedds" ||
		cycloneRMWState.Publisher.Metadata["middleware.runtime"] != "cyclonedds__rmw" ||
		cycloneRMWState.Publisher.Metadata["middleware.family"] != "cyclonedds" ||
		cycloneRMWState.Publisher.Metadata["middleware.implementation"] != "rmw_cyclonedds" ||
		cycloneRMWState.Publisher.Metadata["rmw_implementation"] != "rmw_cyclonedds_cpp" ||
		cycloneRMWState.Publisher.MessageType != "demo/msg/CycloneRMWState" ||
		cycloneRMWState.Publisher.Metadata["adapter"] != "" {
		t.Fatalf("expected msg+cyclonedds RMW topic expansion, got %#v", cycloneRMWState.Publisher)
	}
	serviceByName := map[string]communication.RPCRoute{}
	for _, route := range services {
		serviceByName[route.Name] = route
	}
	planAction := serviceByName["plan_action"]
	if planAction.Server.Transport != communication.TransportCycloneDDS ||
		planAction.Server.Metadata["middleware"] != "cyclonedds" ||
		planAction.Server.Metadata["middleware.implementation"] != "native_cyclonedds" ||
		planAction.Server.Metadata["adapter"] != "" ||
		planAction.Server.Metadata["schema.type"] != "demo.Planner/Plan" ||
		planAction.Server.Metadata["rpc.standard"] != "omg_dds_rpc" {
		t.Fatalf("expected high-level proto+cyclonedds native service expansion, got %#v", planAction.Server)
	}
	typeOnlyPlan := serviceByName["type_only_plan"]
	if typeOnlyPlan.Server.Transport != communication.TransportCycloneDDS ||
		typeOnlyPlan.Server.Metadata["middleware.implementation"] != "native_cyclonedds" ||
		typeOnlyPlan.Server.Metadata["codec"] != "protobuf" ||
		typeOnlyPlan.Server.Metadata["schema.type"] != "demo.Planner/TypeOnlyPlan" {
		t.Fatalf("expected type-only proto+cyclonedds service expansion, got %#v", typeOnlyPlan.Server)
	}
	playAction := serviceByName["play_action"]
	if playAction.Server.Transport != communication.TransportROS2 ||
		playAction.Server.MessageType != "demo/srv/PlayAction" ||
		playAction.Server.Metadata["adapter"] != "" {
		t.Fatalf("expected high-level srv+ros2 native expansion, got %#v", playAction.Server)
	}
	fastPlay := serviceByName["fast_play"]
	if fastPlay.Server.Transport != communication.TransportROS2 ||
		fastPlay.Server.Metadata["middleware"] != "fastdds" ||
		fastPlay.Server.Metadata["middleware.runtime"] != "fastdds__rmw" ||
		fastPlay.Server.Metadata["middleware.family"] != "fastdds" ||
		fastPlay.Server.Metadata["middleware.implementation"] != "rmw_fastrtps" ||
		fastPlay.Server.Metadata["rmw_implementation"] != "rmw_fastrtps_cpp" ||
		fastPlay.Server.MessageType != "demo/srv/FastPlay" ||
		fastPlay.Server.Metadata["adapter"] != "" {
		t.Fatalf("expected high-level srv+fastdds RMW expansion, got %#v", fastPlay.Server)
	}
	ddsIDLPlan := serviceByName["dds_idl_plan"]
	if ddsIDLPlan.Server.Transport != communication.TransportFastDDS ||
		ddsIDLPlan.Server.Metadata["middleware.implementation"] != "native_fastdds" ||
		ddsIDLPlan.Server.Metadata["codec"] != "cdr" ||
		ddsIDLPlan.Server.Metadata["schema.format"] != "dds_idl_rpc" ||
		ddsIDLPlan.Server.Metadata["schema.language"] != "omg_idl" ||
		ddsIDLPlan.Server.Metadata["schema.type"] != "demo::DdsPlanner" ||
		ddsIDLPlan.Server.Metadata["dds.mode"] != "typed_preferred" ||
		ddsIDLPlan.Server.Metadata["dds.fallback"] != "byte_envelope" ||
		ddsIDLPlan.Server.Metadata["dds.runtime"] != "typed_native" ||
		ddsIDLPlan.Server.Metadata["rpc.standard"] != "omg_dds_rpc" {
		t.Fatalf("expected high-level dds_idl+fastdds native service expansion, got %#v", ddsIDLPlan.Server)
	}
	omgIDLPlan := serviceByName["omg_idl_plan"]
	if omgIDLPlan.Server.Transport != communication.TransportCycloneDDS ||
		omgIDLPlan.Server.Metadata["middleware.implementation"] != "native_cyclonedds" ||
		omgIDLPlan.Server.Metadata["schema.format"] != "dds_idl_rpc" ||
		omgIDLPlan.Server.Metadata["schema.language"] != "omg_idl" ||
		omgIDLPlan.Server.Metadata["rpc.standard"] != "omg_dds_rpc" {
		t.Fatalf("expected high-level omg_idl alias to select native CycloneDDS service, got %#v", omgIDLPlan.Server)
	}
	cycloneRMWPlan := serviceByName["cyclone_rmw_plan"]
	if cycloneRMWPlan.Server.Transport != communication.TransportROS2 ||
		cycloneRMWPlan.Server.Metadata["middleware"] != "cyclonedds" ||
		cycloneRMWPlan.Server.Metadata["middleware.runtime"] != "cyclonedds__rmw" ||
		cycloneRMWPlan.Server.Metadata["middleware.family"] != "cyclonedds" ||
		cycloneRMWPlan.Server.Metadata["middleware.implementation"] != "rmw_cyclonedds" ||
		cycloneRMWPlan.Server.Metadata["rmw_implementation"] != "rmw_cyclonedds_cpp" ||
		cycloneRMWPlan.Server.MessageType != "demo/srv/CycloneRMWPlan" ||
		cycloneRMWPlan.Server.Metadata["adapter"] != "" {
		t.Fatalf("expected srv+cyclonedds RMW service expansion, got %#v", cycloneRMWPlan.Server)
	}
}

func TestServiceCommunicationConfigAddsDefaultsForExplicitFastDDSMiddleware(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"demo_fastdds": {
				Transport: "fastdds",
			},
		},
	}

	buses, _, _, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	bus := buses["demo_fastdds"]
	if bus.Transport != communication.TransportFastDDS ||
		bus.Options["middleware.family"] != "fastdds" ||
		bus.Options["implementation"] != "native_fastdds" {
		t.Fatalf("expected explicit fastdds middleware to select native Fast DDS, got %#v", bus)
	}
}

func TestServiceCommunicationConfigKeepsROSDomainIDSeparateFromNativeDomainID(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"robot_dds": {
				Transport:   "cyclonedds",
				ROSDomainID: 42,
			},
		},
	}

	buses, _, _, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if buses["robot_dds"].Options["domain_id"] != nil ||
		buses["robot_dds"].Options["ros_domain_id"] != 42 {
		t.Fatalf("expected ros_domain_id to stay separate from native domain_id, got %#v", buses["robot_dds"].Options)
	}
}

func TestServiceCommunicationConfigRejectsExplicitDDSRuntimeHighLevelRoute(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Topics: map[string]TopicRouteConfig{
			"fast_native_state": {
				Data:       "proto",
				Type:       "demo.FastNativeState",
				Middleware: "fastdds_native",
			},
		},
	}

	_, _, _, err := cfg.Build("planner")
	if err == nil {
		t.Fatal("expected explicit runtime middleware alias to fail")
	}
	if got := err.Error(); !strings.Contains(got, "unsupported high-level route middleware") {
		t.Fatalf("expected unsupported middleware error, got %q", got)
	}
}

func TestServiceCommunicationConfigRejectsUnsupportedNativeBindingCombination(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Services: map[string]ServiceRouteConfig{
			"plan_action": {
				Contract: PayloadConfig{Format: "protobuf_rpc", Type: "demo.Planner/Plan"},
				Bindings: []ServiceRouteConfig{
					{Transport: "ros2_service", Service: "/planner/plan_action"},
				},
			},
		},
	}

	_, _, _, err := cfg.Build("planner")
	if err == nil {
		t.Fatal("expected unsupported protobuf_rpc + ros2_service combination to fail")
	}
	if got := err.Error(); !strings.Contains(got, "requires an adapter") {
		t.Fatalf("expected adapter error, got %q", got)
	}
}

func TestServiceCommunicationConfigAcceptsROS2ProtoEnvelopeAdapter(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"local_ros2": {
				Transport: "ros2",
				Mode:      "bridge",
				Bridge: map[string]any{
					"url": "ws://robot:9090",
				},
			},
		},
		Topics: map[string]TopicRouteConfig{
			"robot_state": {
				Payload: PayloadConfig{Format: "protobuf", Type: "demo.RobotState"},
				Bindings: []TopicRouteConfig{
					{
						Transport:  "ros2_topic",
						Middleware: "local_ros2",
						Adapter:    "ros2_proto_envelope",
						Topic:      "/demo/robot_state",
					},
				},
			},
		},
		Services: map[string]ServiceRouteConfig{
			"plan_action": {
				Contract: PayloadConfig{Format: "protobuf_rpc", Type: "demo.Planner/Plan"},
				Bindings: []ServiceRouteConfig{
					{
						Transport:  "ros2_service",
						Middleware: "local_ros2",
						Adapter:    "ros2_proto_envelope",
						Service:    "/demo/plan_action",
					},
				},
			},
		},
	}

	buses, topics, services, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if buses["local_ros2"].Transport != communication.TransportROS2 ||
		buses["local_ros2"].Options["mode"] != "bridge" ||
		buses["local_ros2"].Options["bridge.url"] != "ws://robot:9090" {
		t.Fatalf("expected ROS2 bridge middleware options, got %#v", buses["local_ros2"])
	}
	if len(topics) != 1 {
		t.Fatalf("expected one topic route, got %#v", topics)
	}
	topicMetadata := topics[0].Publisher.Metadata
	if topicMetadata["adapter"] != "ros2_proto_envelope" ||
		topicMetadata["codec"] != "protobuf" ||
		topicMetadata["schema.type"] != "demo.RobotState" {
		t.Fatalf("expected topic envelope metadata, got %#v", topicMetadata)
	}
	if len(services) != 1 {
		t.Fatalf("expected one service route, got %#v", services)
	}
	serviceMetadata := services[0].Server.Metadata
	if serviceMetadata["adapter"] != "ros2_proto_envelope" ||
		serviceMetadata["codec"] != "protobuf" ||
		serviceMetadata["schema.type"] != "demo.Planner/Plan" {
		t.Fatalf("expected service envelope metadata, got %#v", serviceMetadata)
	}
}

func TestServiceCommunicationConfigKeepsROS2ModeAsConfigChoice(t *testing.T) {
	for _, mode := range []string{"bridge", "native"} {
		t.Run(mode, func(t *testing.T) {
			cfg := ServiceCommunicationConfig{
				Middleware: map[string]MiddlewareConfig{
					"local_ros2": {
						Transport: "ros2",
						Mode:      mode,
					},
				},
				Topics: map[string]TopicRouteConfig{
					"joint_state": {
						Payload: PayloadConfig{Format: "ros2_msg", Type: "sensor_msgs/msg/JointState"},
						Bindings: []TopicRouteConfig{
							{
								Transport:  "ros2_topic",
								Middleware: "local_ros2",
								Topic:      "/joint_states",
							},
						},
					},
					"robot_state": {
						Payload: PayloadConfig{Format: "protobuf", Type: "demo.RobotState"},
						Bindings: []TopicRouteConfig{
							{
								Transport:  "ros2_topic",
								Middleware: "local_ros2",
								Adapter:    "ros2_proto_envelope",
								Topic:      "/demo/robot_state",
							},
						},
					},
				},
				Services: map[string]ServiceRouteConfig{
					"play_action": {
						Contract: PayloadConfig{Format: "ros2_srv", Type: "demo/srv/PlayAction"},
						Bindings: []ServiceRouteConfig{
							{
								Transport:  "ros2_service",
								Middleware: "local_ros2",
								Service:    "/demo/play_action",
							},
						},
					},
					"plan_action": {
						Contract: PayloadConfig{Format: "protobuf_rpc", Type: "demo.Planner/Plan"},
						Bindings: []ServiceRouteConfig{
							{
								Transport:  "ros2_service",
								Middleware: "local_ros2",
								Adapter:    "ros2_proto_envelope",
								Service:    "/demo/plan_action",
							},
						},
					},
				},
			}

			buses, topics, services, err := cfg.Build("planner")
			if err != nil {
				t.Fatalf("Build returned error: %v", err)
			}
			if buses["local_ros2"].Options["mode"] != mode {
				t.Fatalf("expected ROS2 mode %q, got %#v", mode, buses["local_ros2"].Options)
			}
			if len(topics) != 2 || len(services) != 2 {
				t.Fatalf("expected ROSIDL and proto ROS2 routes, got topics=%#v services=%#v", topics, services)
			}
		})
	}
}

func TestServiceCommunicationConfigAcceptsROS2TypedMapperAdapter(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Topics: map[string]TopicRouteConfig{
			"robot_state": {
				Payload: PayloadConfig{Format: "protobuf", Type: "demo.RobotState"},
				Bindings: []TopicRouteConfig{
					{
						Transport: "ros2_topic",
						Adapter:   "ros2_typed_mapper",
						Topic:     "/demo/robot_state",
					},
				},
			},
		},
		Services: map[string]ServiceRouteConfig{
			"plan_action": {
				Contract: PayloadConfig{Format: "protobuf_rpc", Type: "demo.Planner/Plan"},
				Bindings: []ServiceRouteConfig{
					{
						Transport: "ros2_service",
						Adapter:   "ros2_typed_mapper",
						Service:   "/demo/plan_action",
					},
				},
			},
		},
	}

	_, topics, services, err := cfg.Build("planner")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if topics[0].Publisher.Metadata["adapter"] != "ros2_typed_mapper" ||
		topics[0].Publisher.Metadata["schema.type"] != "demo.RobotState" {
		t.Fatalf("expected typed mapper topic metadata, got %#v", topics[0].Publisher.Metadata)
	}
	if services[0].Server.Metadata["adapter"] != "ros2_typed_mapper" ||
		services[0].Server.Metadata["schema.type"] != "demo.Planner/Plan" {
		t.Fatalf("expected typed mapper service metadata, got %#v", services[0].Server.Metadata)
	}
}

func TestServiceCommunicationConfigUsesROS2GraphTypeForTypedMapper(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"local_ros2": {Transport: "ros2"},
		},
		Topics: map[string]TopicRouteConfig{
			"brain_mode": {
				Transport:      "ros2_topic",
				Middleware:     "local_ros2",
				Topic:          "/server/mode",
				Adapter:        "ros2_typed_mapper",
				ROSMessageType: "std_msgs/msg/String",
				Payload: PayloadConfig{
					Format: "protobuf",
					Type:   "pacific_rim.robo_brain_service.protocols.pb.ServerMode",
				},
			},
		},
		Services: map[string]ServiceRouteConfig{
			"plan": {
				Transport:      "ros2_service",
				Middleware:     "local_ros2",
				Service:        "/planner/plan",
				Adapter:        "ros2_typed_mapper",
				ROSServiceType: "example_interfaces/srv/AddTwoInts",
				Contract: PayloadConfig{
					Format: "protobuf_rpc",
					Type:   "demo.Planner/Plan",
				},
			},
		},
	}

	_, topics, services, err := cfg.Build("brain")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if got := topics[0].Publisher.MessageType; got != "std_msgs/msg/String" {
		t.Fatalf("expected ROS2 graph message type, got %q", got)
	}
	if got := topics[0].Publisher.Metadata["schema.type"]; got != "pacific_rim.robo_brain_service.protocols.pb.ServerMode" {
		t.Fatalf("expected protobuf schema metadata, got %q", got)
	}
	if got := services[0].Server.MessageType; got != "example_interfaces/srv/AddTwoInts" {
		t.Fatalf("expected ROS2 graph service type, got %q", got)
	}
	if got := services[0].Server.Metadata["schema.type"]; got != "demo.Planner/Plan" {
		t.Fatalf("expected protobuf RPC schema metadata, got %q", got)
	}
}

func TestServiceCommunicationConfigBuildSkipsDisabledMiddleware(t *testing.T) {
	disabled := false
	cfg := ServiceCommunicationConfig{
		Middleware: map[string]MiddlewareConfig{
			"action_nats": {Transport: "nats"},
			"disabled_dds": {
				Enabled:   &disabled,
				Transport: "cyclonedds",
			},
		},
	}

	buses, _, _, err := cfg.Build("service")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if _, ok := buses["disabled_dds"]; ok {
		t.Fatalf("disabled middleware should not be built: %#v", buses)
	}
	if _, ok := buses["action_nats"]; !ok {
		t.Fatalf("enabled middleware missing: %#v", buses)
	}
}

func TestBootstrapCommunicationWithEmptyConfig(t *testing.T) {
	path := t.TempDir() + "/config.yaml"
	if err := os.WriteFile(path, []byte("communication:\n  middleware: {}\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	runtime, err := BootstrapCommunication(t.Context(), path, "test-service")
	if err != nil {
		t.Fatalf("BootstrapCommunication returned error: %v", err)
	}
	if runtime.ConfigPath != path {
		t.Fatalf("expected config path %q, got %q", path, runtime.ConfigPath)
	}
	if err := runtime.Close(t.Context()); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
}

func TestBootstrapCommunicationMergesPublicInterfaceRefs(t *testing.T) {
	root := t.TempDir()
	publicDir := filepath.Join(root, "pkg", "idl", "demo_service", "public")
	if err := os.MkdirAll(publicDir, 0o755); err != nil {
		t.Fatalf("mkdir public dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(publicDir, "interfaces.yaml"), []byte(`
topics:
  robot_state:
    payload:
      format: ros2_msg
      type: demo/msg/RobotState
    bindings:
      - transport: ros2_topic
        topic: /demo/robot_state
      - transport: nats_topic
        subject: robot.topic.demo.robot_state
services:
  play_action:
    contract:
      format: ros2_srv
      type: demo/srv/PlayAction
    bindings:
      - transport: ros2_service
        service: /demo/play_action
      - transport: nats_rpc
        subject: robot.rpc.demo.play_action
`), 0o600); err != nil {
		t.Fatalf("write public manifest: %v", err)
	}
	configPath := filepath.Join(root, "module", "service", "demo_service", "config", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(configPath, []byte(`
communication:
  middleware:
    local_nats:
      transport: nats
      server_url: nats://example:4222
  topics:
    robot_state:
      topic_ref: demo_service.robot_state
      bindings:
        - transport: nats_topic
          middleware: local_nats
  services:
    play_action:
      service_ref: demo_service.play_action
      bindings:
        - transport: nats_rpc
          middleware: local_nats
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := loadEffectiveBootstrapConfig(configPath)
	if err != nil {
		t.Fatalf("loadEffectiveBootstrapConfig returned error: %v", err)
	}
	if cfg.Communication.Topics["robot_state"].Payload.Type != "demo/msg/RobotState" {
		t.Fatalf("expected topic_ref payload type, got %#v", cfg.Communication.Topics["robot_state"])
	}
	if !containsTopicMiddleware(cfg.Communication.Topics["robot_state"].Bindings, "local_nats") {
		t.Fatalf("expected local middleware override, got %#v", cfg.Communication.Topics["robot_state"].Bindings)
	}
	if !containsTopicSubject(cfg.Communication.Topics["robot_state"].Bindings, "robot.topic.demo.robot_state") {
		t.Fatalf("expected public NATS topic subject, got %#v", cfg.Communication.Topics["robot_state"].Bindings)
	}
	if cfg.Communication.Services["play_action"].ServiceType != "demo/srv/PlayAction" {
		t.Fatalf("expected service_ref contract type, got %#v", cfg.Communication.Services["play_action"])
	}
	if !containsServiceMiddleware(cfg.Communication.Services["play_action"].Bindings, "local_nats") {
		t.Fatalf("expected local service middleware override, got %#v", cfg.Communication.Services["play_action"].Bindings)
	}
	if !containsServiceSubject(cfg.Communication.Services["play_action"].Bindings, "robot.rpc.demo.play_action") {
		t.Fatalf("expected public NATS RPC subject, got %#v", cfg.Communication.Services["play_action"].Bindings)
	}
}

func TestBootstrapCommunicationMergesBarePublicInterfaceRefs(t *testing.T) {
	root := t.TempDir()
	publicDir := filepath.Join(root, "pkg", "idl", "imu_service", "public")
	if err := os.MkdirAll(publicDir, 0o755); err != nil {
		t.Fatalf("mkdir public dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(publicDir, "interfaces.yaml"), []byte(`
topics:
  /imu/state:
    payload:
      format: protobuf
      type: pacific_rim.imu_service.protocols.pb.ImuState
    bindings:
      - transport: cyclonedds_topic
        topic: /imu/state
services:
  /imu/reset:
    contract:
      format: protobuf_rpc
      type: pacific_rim.imu_service.protocols.pb.Imu/Reset
    bindings:
      - transport: cyclonedds_rpc
        service: /imu/reset
`), 0o600); err != nil {
		t.Fatalf("write public manifest: %v", err)
	}
	configPath := filepath.Join(root, "module", "service", "imu_consumer_service", "config", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(configPath, []byte(`
communication:
  topics:
    imu_state:
      topic_ref: /imu/state
      bindings:
        - transport: cyclonedds_topic
          middleware: cyclonedds
  services:
    imu_reset:
      service_ref: /imu/reset
      bindings:
        - transport: cyclonedds_rpc
          middleware: cyclonedds
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := loadEffectiveBootstrapConfig(configPath)
	if err != nil {
		t.Fatalf("loadEffectiveBootstrapConfig returned error: %v", err)
	}
	topic := cfg.Communication.Topics["imu_state"]
	if topic.Payload.Format != "protobuf" || topic.Payload.Type != "pacific_rim.imu_service.protocols.pb.ImuState" {
		t.Fatalf("expected bare topic_ref to inherit protobuf payload, got %#v", topic)
	}
	if len(topic.Bindings) != 1 || topic.Bindings[0].Topic != "/imu/state" {
		t.Fatalf("expected bare topic_ref to inherit public topic binding, got %#v", topic.Bindings)
	}
	service := cfg.Communication.Services["imu_reset"]
	if service.Contract.Format != "protobuf_rpc" || service.Contract.Type != "pacific_rim.imu_service.protocols.pb.Imu/Reset" {
		t.Fatalf("expected bare service_ref to inherit protobuf contract, got %#v", service)
	}
	if len(service.Bindings) != 1 || service.Bindings[0].Service != "/imu/reset" {
		t.Fatalf("expected bare service_ref to inherit public service binding, got %#v", service.Bindings)
	}
}

func TestServiceCommunicationConfigAcceptsOfficialROS2CommonInterfaceTypes(t *testing.T) {
	cfg := ServiceCommunicationConfig{
		Topics: map[string]TopicRouteConfig{
			"std_string": {
				Data:       "msg",
				Type:       "std_msgs/msg/String",
				Middleware: "ros2",
				Topic:      "/std_string",
			},
			"pose": {
				Data:       "msg",
				Type:       "geometry_msgs/msg/PoseStamped",
				Middleware: "ros2",
				Topic:      "/pose",
			},
			"joint_state": {
				Data:       "msg",
				Type:       "sensor_msgs/msg/JointState",
				Middleware: "ros2",
				Topic:      "/joint_states",
			},
			"odometry": {
				Data:       "msg",
				Type:       "nav_msgs/msg/Odometry",
				Middleware: "ros2",
				Topic:      "/odom",
			},
			"trajectory": {
				Data:       "msg",
				Type:       "trajectory_msgs/msg/JointTrajectory",
				Middleware: "ros2",
				Topic:      "/trajectory",
			},
			"marker": {
				Data:       "msg",
				Type:       "visualization_msgs/msg/Marker",
				Middleware: "ros2",
				Topic:      "/marker",
			},
			"goal_status": {
				Data:       "msg",
				Type:       "action_msgs/msg/GoalStatusArray",
				Middleware: "ros2",
				Topic:      "/goal_status",
			},
			"time": {
				Data:       "msg",
				Type:       "builtin_interfaces/msg/Time",
				Middleware: "ros2",
				Topic:      "/time",
			},
			"diagnostics": {
				Data:       "msg",
				Type:       "diagnostic_msgs/msg/DiagnosticArray",
				Middleware: "ros2",
				Topic:      "/diagnostics",
			},
			"mesh": {
				Data:       "msg",
				Type:       "shape_msgs/msg/Mesh",
				Middleware: "ros2",
				Topic:      "/mesh",
			},
			"disparity": {
				Data:       "msg",
				Type:       "stereo_msgs/msg/DisparityImage",
				Middleware: "ros2",
				Topic:      "/disparity",
			},
		},
		Services: map[string]ServiceRouteConfig{
			"set_map": {
				Data:       "srv",
				Type:       "nav_msgs/srv/SetMap",
				Middleware: "ros2",
				Service:    "/set_map",
			},
			"trigger": {
				Data:       "srv",
				Type:       "std_srvs/srv/Trigger",
				Middleware: "ros2",
				Service:    "/trigger",
			},
		},
	}

	buses, topics, services, err := cfg.Build("demo")
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if buses["ros2"].Transport != communication.TransportROS2 {
		t.Fatalf("expected generated ros2 middleware, got %#v", buses["ros2"])
	}
	wantTopics := map[string]string{
		"std_string":  "std_msgs/msg/String",
		"pose":        "geometry_msgs/msg/PoseStamped",
		"joint_state": "sensor_msgs/msg/JointState",
		"odometry":    "nav_msgs/msg/Odometry",
		"trajectory":  "trajectory_msgs/msg/JointTrajectory",
		"marker":      "visualization_msgs/msg/Marker",
		"goal_status": "action_msgs/msg/GoalStatusArray",
		"time":        "builtin_interfaces/msg/Time",
		"diagnostics": "diagnostic_msgs/msg/DiagnosticArray",
		"mesh":        "shape_msgs/msg/Mesh",
		"disparity":   "stereo_msgs/msg/DisparityImage",
	}
	gotTopics := map[string]communication.PubSubRoute{}
	for _, route := range topics {
		gotTopics[route.Name] = route
	}
	for name, wantType := range wantTopics {
		route, ok := gotTopics[name]
		if !ok {
			t.Fatalf("topic route %s missing from %#v", name, topics)
		}
		if route.Publisher.Transport != communication.TransportROS2 || route.Publisher.MessageType != wantType {
			t.Fatalf("topic %s expected ROS2 %s, got %#v", name, wantType, route.Publisher)
		}
		if _, ok := route.Publisher.Metadata["adapter"]; ok {
			t.Fatalf("topic %s should stay native ROSIDL without adapter, got %#v", name, route.Publisher.Metadata)
		}
	}
	wantServices := map[string]string{
		"set_map": "nav_msgs/srv/SetMap",
		"trigger": "std_srvs/srv/Trigger",
	}
	gotServices := map[string]communication.RPCRoute{}
	for _, route := range services {
		gotServices[route.Name] = route
	}
	for name, wantType := range wantServices {
		route, ok := gotServices[name]
		if !ok {
			t.Fatalf("service route %s missing from %#v", name, services)
		}
		if route.Server.Transport != communication.TransportROS2 || route.Server.MessageType != wantType {
			t.Fatalf("service %s expected ROS2 %s, got %#v", name, wantType, route.Server)
		}
		if _, ok := route.Server.Metadata["adapter"]; ok {
			t.Fatalf("official ROS2 service %s should stay native without adapter, got %#v", name, route.Server.Metadata)
		}
	}
}

func containsTopicSubject(bindings []TopicRouteConfig, subject string) bool {
	for _, binding := range bindings {
		if binding.Subject == subject {
			return true
		}
	}
	return false
}

func containsTopicMiddleware(bindings []TopicRouteConfig, middleware string) bool {
	for _, binding := range bindings {
		if binding.Middleware == middleware {
			return true
		}
	}
	return false
}

func containsServiceSubject(bindings []ServiceRouteConfig, subject string) bool {
	for _, binding := range bindings {
		if binding.Subject == subject {
			return true
		}
	}
	return false
}

func containsServiceMiddleware(bindings []ServiceRouteConfig, middleware string) bool {
	for _, binding := range bindings {
		if binding.Middleware == middleware {
			return true
		}
	}
	return false
}
