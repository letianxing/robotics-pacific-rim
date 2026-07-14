#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProtocolCatalog } from "./interface-scaffold/protocols.mjs";
import { buildInterfaceManifest } from "./interface-scaffold/manifest.mjs";
import { renderScaffoldFiles } from "./interface-scaffold/render.mjs";
import { parseYamlSubset } from "./interface-scaffold/yaml.mjs";

const tempDir = await mkdtemp(join(tmpdir(), "pacific-rim-interface-scaffold-"));

try {
  const moduleRoot = join(tempDir, "module", "demo");
  const configPath = join(moduleRoot, "src", "config", "config.yaml");
  const protocolsDir = join(tempDir, "pkg", "idl");
  await mkdir(join(moduleRoot, "src", "config"), { recursive: true });
  await writeFile(
    configPath,
    `service:
  name: demo

communication:
  middleware:
    demo_ros2:
      transport: ros2
    demo_nats:
      transport: nats
    demo_dds:
      transport: cyclonedds
    demo_fastdds:
      transport: fastdds
  services:
    plan_action:
      service_ref: planner_service.plan_action
      contract:
        format: protobuf_rpc
        type: demo.Planner/Plan
      direction: client
      bindings:
        - transport: nats_rpc
          middleware: demo_nats
          subject: demo.plan
        - transport: cyclonedds_rpc
          middleware: demo_dds
          standard: rmw_cyclonedds
          request: demo.plan.request
          response: demo.plan.response
    ros2_plan_action:
      direction: client
      contract:
        format: protobuf_rpc
        type: demo.Planner/Plan
      bindings:
        - transport: ros2_service
          middleware: demo_ros2
          adapter: ros2_proto_envelope
          service: /demo/plan_action
    high_level_plan_action:
      direction: client
      data: proto
      type: demo.Planner/Plan
      middleware: cyclonedds
      service: /demo/high_level_plan_action
    high_level_play_action:
      direction: client
      data: srv
      type: aimrt_msgs/srv/PlayAction
      middleware: ros2
      service: /demo/high_level_play_action
    high_level_fast_play:
      direction: client
      data: srv
      type: demo/srv/FastPlay
      middleware: fastdds
      service: /demo/high_level_fast_play
    high_level_dds_idl_plan:
      direction: client
      data: dds_idl
      type: demo::DdsPlanner/Plan
      middleware: fastdds
      service: /demo/high_level_dds_idl_plan
    high_level_omg_idl_plan:
      direction: client
      data: omg_idl
      type: demo::OmgPlanner
      middleware: cyclonedds
      service: /demo/high_level_omg_idl_plan
    high_level_cyclone_rmw_plan:
      direction: client
      data: srv
      type: demo/srv/CycloneRMWPlan
      middleware: cyclonedds
      service: /demo/high_level_cyclone_rmw_plan
  topics:
    joint_state:
      direction: subscribe
      message_type: aimrt_msgs/msg/JointState
      bindings:
        - transport: ros2_topic
          middleware: demo_ros2
          topic: /joint_state
    proto_state:
      direction: subscribe
      payload:
        format: protobuf
        type: demo.RobotState
      bindings:
        - transport: ros2_topic
          middleware: demo_ros2
          adapter: ros2_proto_envelope
          topic: /demo/proto_state
    proto_mapped_state:
      direction: subscribe
      payload:
        format: protobuf
        type: demo.RobotState
      bindings:
        - transport: ros2_topic
          middleware: demo_ros2
          adapter: ros2_typed_mapper
          topic: /demo/proto_mapped_state
    high_level_proto_state:
      direction: subscribe
      data: proto
      type: demo.RobotState
      middleware: ros2
      topic: /demo/high_level_proto_state
    high_level_joint_state:
      direction: subscribe
      data: msg
      type: aimrt_msgs/msg/JointState
      middleware: cyclonedds
      topic: HighLevelJointState
    high_level_fast_state:
      direction: subscribe
      data: proto
      type: demo.FastState
      middleware: fastdds
      topic: /demo/high_level_fast_state
    high_level_fast_rmw_audio:
      direction: subscribe
      data: msg
      type: demo/msg/FastRmwAudio
      middleware: fastdds
      topic: demo.fast_rmw_audio
    high_level_dds_idl_state:
      direction: subscribe
      data: dds_idl
      type: demo::DdsState
      middleware: fastdds
      topic: /demo/high_level_dds_idl_state
    high_level_omg_idl_state:
      direction: subscribe
      data: omg_idl
      type: demo::OmgState
      middleware: cyclonedds
      topic: /demo/high_level_omg_idl_state
    high_level_cyclone_rmw_state:
      direction: subscribe
      data: msg
      type: demo/msg/CycloneRMWState
      middleware: cyclonedds
      topic: /demo/high_level_cyclone_rmw_state
    high_level_std_string:
      direction: subscribe
      data: msg
      type: std_msgs/msg/String
      middleware: ros2
      topic: /demo/std_string
    high_level_pose:
      direction: subscribe
      data: msg
      type: geometry_msgs/msg/PoseStamped
      middleware: ros2
      topic: /demo/pose
    high_level_sensor_joint_state:
      direction: subscribe
      data: msg
      type: sensor_msgs/msg/JointState
      middleware: ros2
      topic: /demo/sensor_joint_state
    high_level_odometry:
      direction: subscribe
      data: msg
      type: nav_msgs/msg/Odometry
      middleware: ros2
      topic: /demo/odometry
    high_level_trajectory:
      direction: subscribe
      data: msg
      type: trajectory_msgs/msg/JointTrajectory
      middleware: ros2
      topic: /demo/trajectory
    high_level_marker:
      direction: subscribe
      data: msg
      type: visualization_msgs/msg/Marker
      middleware: ros2
      topic: /demo/marker
    high_level_action_goal_status:
      direction: subscribe
      data: msg
      type: action_msgs/msg/GoalStatusArray
      middleware: ros2
      topic: /demo/goal_status
    high_level_builtin_time:
      direction: subscribe
      data: msg
      type: builtin_interfaces/msg/Time
      middleware: ros2
      topic: /demo/time
    high_level_diagnostic_array:
      direction: subscribe
      data: msg
      type: diagnostic_msgs/msg/DiagnosticArray
      middleware: ros2
      topic: /demo/diagnostics
    high_level_shape_mesh:
      direction: subscribe
      data: msg
      type: shape_msgs/msg/Mesh
      middleware: ros2
      topic: /demo/mesh
    high_level_stereo_disparity:
      direction: subscribe
      data: msg
      type: stereo_msgs/msg/DisparityImage
      middleware: ros2
      topic: /demo/disparity
`,
  );
  await mkdir(join(protocolsDir, "demo", "ros2", "aimrt_msgs"), { recursive: true });
  await writeFile(
    join(protocolsDir, "demo", "ros2", "aimrt_msgs", "type_support_pkg_main.cc"),
    `#include "aimrt_msgs/msg/joint_state.hpp"
static const aimrt_type_support_base_t* type_support_array[]{
  aimrt::GetRos2MessageTypeSupport<aimrt_msgs::msg::JointState>()};
`,
  );
  await mkdir(join(protocolsDir, "demo", "ros2", "aimrt_msgs", "msg"), { recursive: true });
  await writeFile(
    join(protocolsDir, "demo", "ros2", "aimrt_msgs", "msg", "_joint_state.py"),
    `from aimrt_msgs.msg._joint_state import JointState
`,
  );
  await mkdir(join(protocolsDir, "aimrt_msgs", "srv"), { recursive: true });
  await writeFile(
    join(protocolsDir, "aimrt_msgs", "srv", "PlayAction.srv"),
    `string action
---
bool success
string message
`,
  );
  await mkdir(join(protocolsDir, "demo", "topics"), { recursive: true });
  await mkdir(join(protocolsDir, "demo", "public"), { recursive: true });
  await writeFile(
    join(protocolsDir, "demo", "public", "interfaces.yaml"),
    `topics:
  public_joint_state:
    payload:
      format: ros2_msg
      type: aimrt_msgs/msg/JointState
    bindings:
      - transport: ros2_topic
        topic: /public_joint_state_contract
      - transport: nats_topic
        subject: demo.public_joint_state
  public_proto_state:
    payload:
      format: protobuf
      type: demo.RobotState
    addresses:
      cyclonedds: /public_proto_state
    bindings:
      - transport: cyclonedds_topic
  public_pose:
    payload:
      format: ros2_msg
      type: geometry_msgs/msg/PoseStamped
    bindings:
      - transport: ros2_topic
        topic: /public_pose
  public_scan:
    payload:
      format: ros2_msg
      type: sensor_msgs/msg/LaserScan
    bindings:
      - transport: nats_topic
        subject: demo.public_scan
  audio/music_state:
    payload:
      format: ros2_msg
      type: std_msgs/msg/String
    addresses:
      ros2: /audio/music_state
services:
  play_action:
    contract:
      format: ros2_srv
      type: aimrt_msgs/srv/PlayAction
    bindings:
      - transport: ros2_service
        service: /play_action_contract
      - transport: nats_rpc
        subject: demo.play_action
  public_set_map:
    contract:
      format: ros2_srv
      type: nav_msgs/srv/SetMap
    bindings:
      - transport: ros2_service
        service: /public_set_map
  public_trigger:
    contract:
      format: ros2_srv
      type: std_srvs/srv/Trigger
    bindings:
      - transport: ros2_service
        service: /public_trigger
`,
  );
  await mkdir(join(protocolsDir, "planner_service", "public"), { recursive: true });
  await mkdir(join(protocolsDir, "planner_service", "pb"), { recursive: true });
  await mkdir(join(protocolsDir, "demo", "dds", "demo"), { recursive: true });
  await writeFile(
    join(protocolsDir, "demo", "dds", "demo", "DdsState.idl"),
    `module demo {
  struct DdsState {
    unsigned long sequence;
    sequence<octet, 4096> payload;
  };

  interface DdsPlanner {
    sequence<octet, 4096> Plan(in DdsState request);
  };
};
`,
  );
  await writeFile(
    join(protocolsDir, "planner_service", "public", "interfaces.yaml"),
    `services:
  plan_action:
    contract:
      format: protobuf_rpc
      type: demo.Planner/Plan
    bindings:
      - transport: nats_rpc
        direction: server
        subject: planner.plan
      - transport: cyclonedds_rpc
        direction: server
        standard: rmw_cyclonedds
        request: planner.plan.request
        response: planner.plan.response
`,
  );

  const config = parseYamlSubset(await readFile(configPath, "utf8"));
  if (Array.isArray(config.communication?.services) || Array.isArray(config.communication?.middleware)) {
    throw new Error("YAML inline empty mappings must parse as objects, not arrays");
  }
  const emptyConfig = parseYamlSubset("communication:\n  middleware: {}\n  services: {}\n  topics: []\n");
  if (
    Array.isArray(emptyConfig.communication.middleware) ||
    Array.isArray(emptyConfig.communication.services) ||
    !Array.isArray(emptyConfig.communication.topics)
  ) {
    throw new Error("YAML subset parser did not preserve inline empty mapping/list values");
  }
  const catalog = await loadProtocolCatalog(protocolsDir);
  const manifest = buildInterfaceManifest({
    moduleName: "demo",
    moduleRoot,
    configPath,
    protocolSources: [protocolsDir],
    config,
    catalog,
  });
  try {
    buildInterfaceManifest({
      moduleName: "demo",
      moduleRoot,
      configPath,
      protocolSources: [protocolsDir],
      config: parseYamlSubset(`service:
  name: demo
communication:
  topics:
    duplicate_public_joint_state:
      topic_ref: demo.public_joint_state
      direction: publish
`),
      catalog,
    });
    throw new Error("Expected duplicate provider route in config.yaml to fail");
  } catch (error) {
    if (!String(error.message).includes("Provider routes must be defined only")) {
      throw error;
    }
  }
  const iface = manifest.interfaces.find((item) => item.name === "joint_state");
  const formats = new Set(iface?.protocols.map((protocol) => protocol.format));
  const artifacts = new Set(iface?.artifacts.map((artifact) => artifact.format));
  if (!formats.has("ros2_msg")) {
    throw new Error("Expected ros2_msg source protocol in generated manifest");
  }
  if (formats.has("ros2_generated_artifact")) {
    throw new Error("Generated artifacts must not be listed as source protocols");
  }
  if (!artifacts.has("ros2_generated_artifact")) {
    throw new Error("Expected ros2_generated_artifact metadata in generated manifest");
  }
  const artifactLanguages = new Set(iface?.artifacts.map((artifact) => artifact.language));
  if (!artifactLanguages.has("cpp") || !artifactLanguages.has("python")) {
    throw new Error("Expected both cpp and python generated artifact metadata");
  }
  const publicIface = manifest.interfaces.find((item) => item.name === "public_joint_state");
  if (!publicIface?.topicRef || publicIface.topicRef !== "demo.public_joint_state") {
    throw new Error("Expected topic_ref to resolve public topic contract");
  }
  if (!publicIface.protocols.some((protocol) => protocol.format === "ros2_msg" && protocol.type === "aimrt_msgs/msg/JointState")) {
    throw new Error("Expected topic_ref to inherit public topic payload protocol");
  }
  if (publicIface.bindings[0]?.topic !== "/public_joint_state_contract" || publicIface.bindings[0]?.middleware !== "ros2") {
    throw new Error("Expected public provider topic to inherit public ROS2 topic address");
  }
  if (publicIface.bindings[1]?.subject !== "demo.public_joint_state" || publicIface.bindings[1]?.middleware !== "nats") {
    throw new Error("Expected public provider topic to inherit public NATS subject");
  }
  const slashPublicIface = manifest.interfaces.find((item) => item.name === "audio/music_state");
  if (
    !slashPublicIface ||
    Object.values(slashPublicIface.generated ?? {}).some((value) => String(value).includes("audio/music_state"))
  ) {
    throw new Error(`Generated path metadata must sanitize route names that contain slashes, got ${JSON.stringify(slashPublicIface?.generated)}`);
  }
  const barePublicRefInterfaces = buildInterfaceManifest({
    moduleName: "demo",
    moduleRoot,
    configPath,
    protocolSources: [protocolsDir],
    config: parseYamlSubset(`service:
  name: demo
communication:
  middleware:
    demo_dds:
      transport: cyclonedds
    demo_ros2:
      transport: ros2
  topics:
    bare_public_proto_state:
      topic_ref: /public_proto_state
      direction: subscribe
      bindings:
        - transport: cyclonedds_topic
          middleware: demo_dds
    bare_public_joint_state:
      topic_ref: /public_joint_state_contract
      direction: subscribe
      bindings:
        - transport: ros2_topic
          middleware: demo_ros2
  services:
    bare_play_action:
      service_ref: /play_action_contract
      direction: client
      bindings:
        - transport: ros2_service
          middleware: demo_ros2
`),
    catalog,
  }).interfaces;
  const bareProtoTopic = barePublicRefInterfaces.find((item) => item.name === "bare_public_proto_state");
  if (
    bareProtoTopic?.topicRef !== "demo.public_proto_state" ||
    bareProtoTopic.payload?.format !== "protobuf" ||
    bareProtoTopic.payload?.type !== "demo.RobotState" ||
    !bareProtoTopic.protocols.some((protocol) => protocol.format === "protobuf_message" && protocol.type === "demo.RobotState") ||
    bareProtoTopic.bindings[0]?.topic !== "/public_proto_state" ||
    bareProtoTopic.bindings[0]?.middleware !== "demo_dds"
  ) {
    throw new Error(`Expected bare public protobuf topic ref to inherit payload and CycloneDDS address, got ${JSON.stringify(bareProtoTopic)}`);
  }
  const bareRosTopic = barePublicRefInterfaces.find((item) => item.name === "bare_public_joint_state");
  if (
    bareRosTopic?.topicRef !== "demo.public_joint_state" ||
    bareRosTopic.routeType !== "aimrt_msgs/msg/JointState" ||
    bareRosTopic.bindings[0]?.topic !== "/public_joint_state_contract" ||
    bareRosTopic.bindings[0]?.middleware !== "demo_ros2"
  ) {
    throw new Error(`Expected bare public ROS topic ref to inherit ROSIDL payload and address, got ${JSON.stringify(bareRosTopic)}`);
  }
  const bareService = barePublicRefInterfaces.find((item) => item.name === "bare_play_action");
  if (
    bareService?.serviceRef !== "demo.play_action" ||
    bareService.routeType !== "aimrt_msgs/srv/PlayAction" ||
    bareService.bindings[0]?.service !== "/play_action_contract" ||
    bareService.bindings[0]?.middleware !== "demo_ros2"
  ) {
    throw new Error(`Expected bare public service ref to inherit service contract and address, got ${JSON.stringify(bareService)}`);
  }
  const publicService = manifest.interfaces.find((item) => item.name === "play_action");
  if (!publicService?.serviceRef || publicService.serviceRef !== "demo.play_action") {
    throw new Error("Expected service_ref to resolve public service contract");
  }
  if (!publicService.bindings.some((binding) => binding.service === "/play_action_contract")) {
    throw new Error("Expected service_ref to inherit public ROS2 service address");
  }
  if (!publicService.bindings.some((binding) => binding.subject === "demo.play_action" && binding.middleware === "nats")) {
    throw new Error("Expected public provider service to inherit public NATS binding");
  }
  const planService = manifest.interfaces.find((item) => item.name === "plan_action");
  const ddsDescriptor = planService?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "cyclonedds_rpc");
  if (
    !ddsDescriptor ||
    ddsDescriptor.schema.language !== "protobuf" ||
    ddsDescriptor.codec !== "protobuf" ||
    ddsDescriptor.backend !== "cyclonedds" ||
    ddsDescriptor.pattern !== "rpc" ||
    ddsDescriptor.standard !== "rmw_cyclonedds"
  ) {
    throw new Error(`Expected protobuf + cyclonedds_rpc compatibility descriptor, got ${JSON.stringify(ddsDescriptor)}`);
  }
  const protoState = manifest.interfaces.find((item) => item.name === "proto_state");
  const protoStateDescriptor = protoState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !protoStateDescriptor ||
    protoStateDescriptor.adapter !== "ros2_proto_envelope" ||
    protoStateDescriptor.schema.language !== "protobuf" ||
    protoStateDescriptor.warnings.length !== 0
  ) {
    throw new Error(`Expected protobuf + ros2_topic envelope compatibility, got ${JSON.stringify(protoStateDescriptor)}`);
  }
  const ros2PlanService = manifest.interfaces.find((item) => item.name === "ros2_plan_action");
  const ros2PlanDescriptor = ros2PlanService?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_service");
  if (
    !ros2PlanDescriptor ||
    ros2PlanDescriptor.adapter !== "ros2_proto_envelope" ||
    ros2PlanDescriptor.schema.language !== "protobuf" ||
    ros2PlanDescriptor.warnings.length !== 0
  ) {
    throw new Error(`Expected protobuf + ros2_service envelope compatibility, got ${JSON.stringify(ros2PlanDescriptor)}`);
  }
  const protoMappedState = manifest.interfaces.find((item) => item.name === "proto_mapped_state");
  const protoMappedStateDescriptor = protoMappedState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !protoMappedStateDescriptor ||
    protoMappedStateDescriptor.adapter !== "ros2_typed_mapper" ||
    protoMappedStateDescriptor.schema.language !== "protobuf" ||
    protoMappedStateDescriptor.warnings.length !== 0
  ) {
    throw new Error(`Expected protobuf + ros2_topic typed mapper compatibility, got ${JSON.stringify(protoMappedStateDescriptor)}`);
  }
  const highLevelProtoState = manifest.interfaces.find((item) => item.name === "high_level_proto_state");
  const highLevelProtoDescriptor = highLevelProtoState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !highLevelProtoDescriptor ||
    highLevelProtoDescriptor.adapter !== "ros2_proto_envelope" ||
    highLevelProtoDescriptor.schema.language !== "protobuf" ||
    highLevelProtoDescriptor.warnings.length !== 0 ||
    highLevelProtoState.bindings[0]?.middleware !== "ros2"
  ) {
    throw new Error(`Expected high-level proto+ros2 topic to expand to envelope binding, got ${JSON.stringify(highLevelProtoState)}`);
  }
  const highLevelJointState = manifest.interfaces.find((item) => item.name === "high_level_joint_state");
  const highLevelJointDescriptor = highLevelJointState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !highLevelJointDescriptor ||
    highLevelJointDescriptor.backend !== "cyclonedds" ||
    highLevelJointDescriptor.schema.language !== "rosidl" ||
    highLevelJointDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelJointState.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelJointState.bindings[0]?.metadata?.["middleware.runtime"] !== "cyclonedds__rmw" ||
    highLevelJointState.bindings[0]?.metadata?.["middleware.user"] !== undefined ||
    highLevelJointState.bindings[0]?.metadata?.["middleware.implementation"] !== "rmw_cyclonedds"
  ) {
    throw new Error(`Expected high-level msg+cyclonedds RMW topic expansion with typed mapper, got ${JSON.stringify(highLevelJointState)}`);
  }
  const highLevelPlanService = manifest.interfaces.find((item) => item.name === "high_level_plan_action");
  const highLevelPlanDescriptor = highLevelPlanService?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "cyclonedds_rpc");
  if (
    !highLevelPlanDescriptor ||
    highLevelPlanDescriptor.backend !== "cyclonedds" ||
    highLevelPlanDescriptor.schema.language !== "protobuf" ||
    highLevelPlanDescriptor.warnings.length !== 0 ||
    highLevelPlanService.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelPlanService.bindings[0]?.metadata?.["middleware.implementation"] !== "native_cyclonedds"
  ) {
    throw new Error(`Expected high-level proto+cyclonedds service to expand through native DDS RPC, got ${JSON.stringify(highLevelPlanService)}`);
  }
  const highLevelPlayService = manifest.interfaces.find((item) => item.name === "high_level_play_action");
  const highLevelPlayDescriptor = highLevelPlayService?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_service");
  if (
    !highLevelPlayDescriptor ||
    highLevelPlayDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelPlayDescriptor.schema.language !== "rosidl" ||
    highLevelPlayService.routeType !== "aimrt_msgs/srv/PlayAction"
  ) {
    throw new Error(`Expected high-level srv+ros2 service to use typed mapper, got ${JSON.stringify(highLevelPlayService)}`);
  }
  const highLevelFastState = manifest.interfaces.find((item) => item.name === "high_level_fast_state");
  const highLevelFastStateDescriptor = highLevelFastState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "fastdds_topic");
  if (
    !highLevelFastStateDescriptor ||
    highLevelFastStateDescriptor.adapter ||
    highLevelFastStateDescriptor.backend !== "fastdds" ||
    highLevelFastStateDescriptor.schema.language !== "protobuf" ||
    highLevelFastStateDescriptor.warnings.length !== 0 ||
    highLevelFastState.bindings[0]?.middleware !== "fastdds" ||
    highLevelFastState.bindings[0]?.metadata?.["middleware.implementation"] !== "native_fastdds" ||
    highLevelFastState.bindings[0]?.metadata?.rmw_implementation !== undefined
  ) {
    throw new Error(`Expected high-level proto+fastdds topic to expand through native Fast DDS, got ${JSON.stringify(highLevelFastState)}`);
  }
  const highLevelFastRmwAudio = manifest.interfaces.find((item) => item.name === "high_level_fast_rmw_audio");
  const highLevelFastRmwAudioDescriptor = highLevelFastRmwAudio?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !highLevelFastRmwAudioDescriptor ||
    highLevelFastRmwAudioDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelFastRmwAudioDescriptor.backend !== "fastdds" ||
    highLevelFastRmwAudioDescriptor.schema.language !== "rosidl" ||
    highLevelFastRmwAudio.bindings[0]?.topic !== "/demo/fast_rmw_audio"
  ) {
    throw new Error(`Expected high-level msg+fastdds RMW topic to use typed mapper and ROS2-safe topic name, got ${JSON.stringify(highLevelFastRmwAudio)}`);
  }
  const highLevelDdsIdlState = manifest.interfaces.find((item) => item.name === "high_level_dds_idl_state");
  const highLevelDdsIdlStateDescriptor = highLevelDdsIdlState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "fastdds_topic");
  if (
    !highLevelDdsIdlStateDescriptor ||
    highLevelDdsIdlStateDescriptor.adapter ||
    highLevelDdsIdlStateDescriptor.backend !== "fastdds" ||
    highLevelDdsIdlStateDescriptor.schema.language !== "omg_idl" ||
    highLevelDdsIdlStateDescriptor.codec !== "cdr" ||
    highLevelDdsIdlStateDescriptor.warnings.length !== 0 ||
    highLevelDdsIdlState.bindings[0]?.middleware !== "fastdds" ||
    highLevelDdsIdlState.bindings[0]?.metadata?.["middleware.implementation"] !== "native_fastdds"
  ) {
    throw new Error(`Expected high-level dds_idl+fastdds topic to expand through native Fast DDS, got ${JSON.stringify(highLevelDdsIdlState)}`);
  }
  if (!highLevelDdsIdlState.protocols.some((protocol) => protocol.format === "dds_idl" && protocol.fullName === "demo::DdsState")) {
    throw new Error(`Expected high-level dds_idl topic to reference parsed OMG IDL struct, got ${JSON.stringify(highLevelDdsIdlState.protocols)}`);
  }
  const highLevelOmgIdlState = manifest.interfaces.find((item) => item.name === "high_level_omg_idl_state");
  const highLevelOmgIdlStateDescriptor = highLevelOmgIdlState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "cyclonedds_topic");
  if (
    !highLevelOmgIdlStateDescriptor ||
    highLevelOmgIdlStateDescriptor.backend !== "cyclonedds" ||
    highLevelOmgIdlStateDescriptor.schema.language !== "omg_idl" ||
    highLevelOmgIdlStateDescriptor.codec !== "cdr" ||
    highLevelOmgIdlStateDescriptor.warnings.length !== 0 ||
    highLevelOmgIdlState.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelOmgIdlState.bindings[0]?.metadata?.["middleware.implementation"] !== "native_cyclonedds"
  ) {
    throw new Error(`Expected high-level omg_idl alias to expand through native CycloneDDS topic, got ${JSON.stringify(highLevelOmgIdlState)}`);
  }
  const highLevelFastPlay = manifest.interfaces.find((item) => item.name === "high_level_fast_play");
  const highLevelFastPlayDescriptor = highLevelFastPlay?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_service");
  if (
    !highLevelFastPlayDescriptor ||
    highLevelFastPlayDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelFastPlayDescriptor.backend !== "fastdds" ||
    highLevelFastPlayDescriptor.schema.language !== "rosidl" ||
    highLevelFastPlay.bindings[0]?.middleware !== "fastdds" ||
    highLevelFastPlay.bindings[0]?.metadata?.["middleware.runtime"] !== "fastdds__rmw" ||
    highLevelFastPlay.bindings[0]?.metadata?.["middleware.implementation"] !== "rmw_fastrtps" ||
    highLevelFastPlay.bindings[0]?.metadata?.rmw_implementation !== "rmw_fastrtps_cpp"
  ) {
    throw new Error(`Expected high-level srv+fastdds service to use typed mapper through Fast DDS RMW, got ${JSON.stringify(highLevelFastPlay)}`);
  }
  const highLevelDdsIdlPlan = manifest.interfaces.find((item) => item.name === "high_level_dds_idl_plan");
  const highLevelDdsIdlPlanDescriptor = highLevelDdsIdlPlan?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "fastdds_rpc");
  if (
    !highLevelDdsIdlPlanDescriptor ||
    highLevelDdsIdlPlanDescriptor.backend !== "fastdds" ||
    highLevelDdsIdlPlanDescriptor.schema.language !== "omg_idl" ||
    highLevelDdsIdlPlanDescriptor.codec !== "cdr" ||
    highLevelDdsIdlPlanDescriptor.standard !== "" ||
    highLevelDdsIdlPlanDescriptor.warnings.length !== 0 ||
    highLevelDdsIdlPlan.bindings[0]?.middleware !== "fastdds" ||
    highLevelDdsIdlPlan.bindings[0]?.metadata?.["middleware.implementation"] !== "native_fastdds"
  ) {
    throw new Error(`Expected high-level dds_idl+fastdds service to expand through native Fast DDS RPC, got ${JSON.stringify(highLevelDdsIdlPlan)}`);
  }
  if (!highLevelDdsIdlPlan.protocols.some((protocol) => protocol.format === "dds_idl_rpc" && protocol.fullName === "demo::DdsPlanner/Plan")) {
    throw new Error(`Expected high-level dds_idl service to reference parsed OMG DDS-RPC operation, got ${JSON.stringify(highLevelDdsIdlPlan.protocols)}`);
  }
  const highLevelOmgIdlPlan = manifest.interfaces.find((item) => item.name === "high_level_omg_idl_plan");
  const highLevelOmgIdlPlanDescriptor = highLevelOmgIdlPlan?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "cyclonedds_rpc");
  if (
    !highLevelOmgIdlPlanDescriptor ||
    highLevelOmgIdlPlanDescriptor.backend !== "cyclonedds" ||
    highLevelOmgIdlPlanDescriptor.schema.language !== "omg_idl" ||
    highLevelOmgIdlPlanDescriptor.codec !== "cdr" ||
    highLevelOmgIdlPlanDescriptor.warnings.length !== 0 ||
    highLevelOmgIdlPlan.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelOmgIdlPlan.bindings[0]?.metadata?.["middleware.implementation"] !== "native_cyclonedds"
  ) {
    throw new Error(`Expected high-level omg_idl alias to expand through native CycloneDDS RPC, got ${JSON.stringify(highLevelOmgIdlPlan)}`);
  }
  const highLevelCycloneRmwState = manifest.interfaces.find((item) => item.name === "high_level_cyclone_rmw_state");
  const highLevelCycloneRmwStateDescriptor = highLevelCycloneRmwState?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_topic");
  if (
    !highLevelCycloneRmwStateDescriptor ||
    highLevelCycloneRmwStateDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelCycloneRmwStateDescriptor.backend !== "cyclonedds" ||
    highLevelCycloneRmwStateDescriptor.schema.language !== "rosidl" ||
    highLevelCycloneRmwStateDescriptor.warnings.length !== 0 ||
    highLevelCycloneRmwState.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelCycloneRmwState.bindings[0]?.metadata?.["middleware.runtime"] !== "cyclonedds__rmw" ||
    highLevelCycloneRmwState.bindings[0]?.metadata?.["middleware.implementation"] !== "rmw_cyclonedds" ||
    highLevelCycloneRmwState.bindings[0]?.metadata?.rmw_implementation !== "rmw_cyclonedds_cpp"
  ) {
    throw new Error(`Expected high-level msg+cyclonedds topic to use typed mapper through CycloneDDS RMW, got ${JSON.stringify(highLevelCycloneRmwState)}`);
  }
  const highLevelCycloneRmwPlan = manifest.interfaces.find((item) => item.name === "high_level_cyclone_rmw_plan");
  const highLevelCycloneRmwPlanDescriptor = highLevelCycloneRmwPlan?.compatibility?.descriptors.find((descriptor) => descriptor.binding === "ros2_service");
  if (
    !highLevelCycloneRmwPlanDescriptor ||
    highLevelCycloneRmwPlanDescriptor.adapter !== "ros2_typed_mapper" ||
    highLevelCycloneRmwPlanDescriptor.backend !== "cyclonedds" ||
    highLevelCycloneRmwPlanDescriptor.schema.language !== "rosidl" ||
    highLevelCycloneRmwPlanDescriptor.warnings.length !== 0 ||
    highLevelCycloneRmwPlan.bindings[0]?.middleware !== "cyclonedds" ||
    highLevelCycloneRmwPlan.bindings[0]?.metadata?.["middleware.runtime"] !== "cyclonedds__rmw" ||
    highLevelCycloneRmwPlan.bindings[0]?.metadata?.["middleware.implementation"] !== "rmw_cyclonedds" ||
    highLevelCycloneRmwPlan.bindings[0]?.metadata?.rmw_implementation !== "rmw_cyclonedds_cpp"
  ) {
    throw new Error(`Expected high-level srv+cyclonedds service to use typed mapper through CycloneDDS RMW, got ${JSON.stringify(highLevelCycloneRmwPlan)}`);
  }
  const officialCommonTopicTypes = new Map([
    ["high_level_std_string", "std_msgs/msg/String"],
    ["high_level_pose", "geometry_msgs/msg/PoseStamped"],
    ["high_level_sensor_joint_state", "sensor_msgs/msg/JointState"],
    ["high_level_odometry", "nav_msgs/msg/Odometry"],
    ["high_level_trajectory", "trajectory_msgs/msg/JointTrajectory"],
    ["high_level_marker", "visualization_msgs/msg/Marker"],
    ["high_level_action_goal_status", "action_msgs/msg/GoalStatusArray"],
    ["high_level_builtin_time", "builtin_interfaces/msg/Time"],
    ["high_level_diagnostic_array", "diagnostic_msgs/msg/DiagnosticArray"],
    ["high_level_shape_mesh", "shape_msgs/msg/Mesh"],
    ["high_level_stereo_disparity", "stereo_msgs/msg/DisparityImage"],
  ]);
  for (const [name, type] of officialCommonTopicTypes) {
    const officialIface = manifest.interfaces.find((item) => item.name === name);
    const descriptor = officialIface?.compatibility?.descriptors.find((item) => item.binding === "ros2_topic");
    if (
      officialIface?.routeType !== type ||
      !officialIface.protocols.some((protocol) => protocol.format === "ros2_msg" && protocol.type === type && protocol.external === true) ||
      descriptor?.schema.language !== "rosidl" ||
      descriptor?.warnings.length !== 0
    ) {
      throw new Error(`Expected official common_interfaces topic ${name} to stay external ROSIDL ${type}, got ${JSON.stringify(officialIface)}`);
    }
  }
  const publicOfficialTopic = buildInterfaceManifest({
    moduleName: "demo",
    moduleRoot,
    configPath,
    protocolSources: [protocolsDir],
    config: parseYamlSubset(`service:
  name: demo
communication:
  topics:
    public_pose:
      topic_ref: demo.public_pose
      direction: subscribe
      bindings:
        - transport: ros2_topic
    public_scan:
      topic_ref: demo.public_scan
      direction: subscribe
      bindings:
        - transport: nats_topic
`),
    catalog,
  }).interfaces;
  const inheritedPose = publicOfficialTopic.find((item) => item.name === "public_pose");
  const inheritedScan = publicOfficialTopic.find((item) => item.name === "public_scan");
  if (
    inheritedPose?.routeType !== "geometry_msgs/msg/PoseStamped" ||
    !inheritedPose.protocols.some((protocol) => protocol.format === "ros2_msg" && protocol.type === "geometry_msgs/msg/PoseStamped" && protocol.external === true) ||
    inheritedScan?.routeType !== "sensor_msgs/msg/LaserScan" ||
    !inheritedScan.protocols.some((protocol) => protocol.format === "ros2_msg" && protocol.type === "sensor_msgs/msg/LaserScan" && protocol.external === true)
  ) {
    throw new Error(`Expected public interfaces.yaml refs to inherit official common_interfaces topics, got ${JSON.stringify(publicOfficialTopic)}`);
  }
  const publicOfficialServiceInterfaces = buildInterfaceManifest({
    moduleName: "demo",
    moduleRoot,
    configPath,
    protocolSources: [protocolsDir],
    config: parseYamlSubset(`service:
  name: demo
communication:
  services:
    public_set_map:
      service_ref: demo.public_set_map
      direction: client
      bindings:
        - transport: ros2_service
    public_trigger:
      service_ref: demo.public_trigger
      direction: client
      bindings:
        - transport: ros2_service
`),
    catalog,
  }).interfaces;
  const publicOfficialServices = new Map([
    ["public_set_map", "nav_msgs/srv/SetMap"],
    ["public_trigger", "std_srvs/srv/Trigger"],
  ]);
  for (const [name, type] of publicOfficialServices) {
    const publicOfficialService = publicOfficialServiceInterfaces.find((item) => item.name === name);
    if (
      publicOfficialService?.routeType !== type ||
      !publicOfficialService.protocols.some((protocol) => protocol.format === "ros2_srv" && protocol.type === type && protocol.external === true) ||
      publicOfficialService.compatibility?.descriptors[0]?.warnings.length !== 0
    ) {
      throw new Error(`Expected public interfaces.yaml refs to inherit official common_interfaces service ${type}, got ${JSON.stringify(publicOfficialService)}`);
    }
  }
  const files = renderScaffoldFiles({ ...manifest, language: "go" });
  if (files["internal/api/generated/plan_action_client.go"]) {
    throw new Error("Consumer-side service clients must not generate API wrappers");
  }
  if (!files["internal/service/generated/plan_action_client_service.go"]) {
    throw new Error("Consumer-side service clients must generate module-local client helpers");
  }
  if (Object.keys(files).some((path) => path.startsWith("pkg/idl/planner_service/generated/go/"))) {
    throw new Error("Consumer-side service clients must not generate a second language under an upstream provider's pkg/idl tree");
  }
  if (files["internal/api/generated/joint_state_handler.go"] || files["internal/service/generated/joint_state_service.go"]) {
    throw new Error("Subscriber-side topic handlers must not be generated as business templates");
  }
  if (files["internal/api/generated/play_action_handler.go"]) {
    throw new Error("Provider-side handler wrappers must live under pkg/idl generated protocol files");
  }
  if (!files["internal/service/generated/play_action_service.go"]) {
    throw new Error("Provider-side user-editable service implementations must be generated under module/service");
  }
  if (files["internal/api/generated/public_joint_state_publisher.go"]) {
    throw new Error("Publisher-side wrappers must live under pkg/idl generated protocol files");
  }
  if (!files["internal/service/generated/public_joint_state_publisher_service.go"]) {
    throw new Error("Publisher-side user-editable implementations must be generated under module/service");
  }
  if (!files["interface_scaffold_README.md"] || !files["pkg/idl/demo/protocol_manifest.json"]) {
    throw new Error("Generated scaffold metadata must include a module README and pkg/idl protocol manifest");
  }
  const protocolManifest = JSON.parse(files["pkg/idl/demo/protocol_manifest.json"]);
  if (!protocolManifest.ddsTypedCodegen?.some((target) => target.generator === "fastddsgen" && target.middleware === "fastdds")) {
    throw new Error(`Expected protocol manifest to include FastDDS typed codegen plan, got ${JSON.stringify(protocolManifest.ddsTypedCodegen)}`);
  }
  const manifestDdsState = protocolManifest.interfaces.find((item) => item.name === "high_level_dds_idl_state");
  if (
    manifestDdsState?.ddsTyped?.preference !== "typed_preferred" ||
    manifestDdsState.ddsTyped.fallback !== "byte_envelope" ||
    manifestDdsState.ddsTyped.memory?.bounded !== true
  ) {
    throw new Error(`Expected dds_idl manifest route to prefer bounded typed DDS with fallback, got ${JSON.stringify(manifestDdsState?.ddsTyped)}`);
  }
  if (
    !files["pkg/idl/demo/generated/dds/dds_typed_codegen_plan.json"] ||
    !files["pkg/idl/demo/generated/dds/generate-dds-typed-bindings.sh"] ||
    !files["pkg/idl/demo/generated/dds/README.md"]
  ) {
    throw new Error("Provider-owned dds_idl routes must generate DDS typed codegen plan files");
  }
  const ddsCodegenPlan = JSON.parse(files["pkg/idl/demo/generated/dds/dds_typed_codegen_plan.json"]);
  if (!ddsCodegenPlan.targets.some((target) => target.generator === "idlc" && target.language === "python")) {
    throw new Error(`Expected CycloneDDS Python typed codegen target, got ${JSON.stringify(ddsCodegenPlan)}`);
  }
  if (!files["pkg/idl/demo/generated/go/service.go"] || !files["pkg/idl/demo/generated/go/ports.go"] || !files["pkg/idl/demo/generated/go/provider.go"] || !files["pkg/idl/demo/generated/go/registry.go"]) {
    throw new Error("Shared generated service/provider/registry abstractions must be written under pkg/idl/<service>/generated/go");
  }
  if (!files["pkg/idl/demo/generated/go/ports.go"].includes("type PlayActionService interface") || !files["pkg/idl/demo/generated/go/provider.go"].includes("PlayActionService PlayActionService")) {
    throw new Error("Shared generated providers must depend on route-specific service ports");
  }
  if (!files["pkg/idl/demo/generated/go/ports.go"].includes("type PublicJointStatePublisherService interface") || !files["pkg/idl/demo/generated/go/provider.go"].includes("PublicJointStatePublisher PublicJointStatePublisherService")) {
    throw new Error("Shared generated providers must depend on route-specific publisher ports");
  }
  if (!files["pkg/idl/demo/generated/go/client.go"].includes("type ByteServiceClient interface")) {
    throw new Error("Shared generated protocol abstractions must include client-side contracts under pkg/idl");
  }
  if (!files["pkg/idl/demo/generated/go/service.go"].includes("type PlayActionHandler struct")) {
    throw new Error("Provider-side handler wrappers must be generated under pkg/idl");
  }
  if (!files["pkg/idl/demo/generated/go/publisher.go"].includes("type PublicJointStatePublisher struct")) {
    throw new Error("Publisher-side wrappers must be generated under pkg/idl");
  }
  if (!files["internal/api/generated/register.go"].includes("idlprotocol.RegisterGeneratedInterfaces")) {
    throw new Error("Module-local register shim must delegate to pkg/idl registrar");
  }
  const expectedGoGenerated = new Set([
    "pkg/idl/demo/generated/go/client.go",
    "pkg/idl/demo/generated/go/ports.go",
    "pkg/idl/demo/generated/go/provider.go",
    "pkg/idl/demo/generated/go/publisher.go",
    "pkg/idl/demo/generated/go/registry.go",
    "pkg/idl/demo/generated/go/service.go",
    "pkg/idl/demo/generated/go/subscriber.go",
    "pkg/idl/demo/generated/dds/README.md",
    "pkg/idl/demo/generated/dds/dds_typed_codegen_plan.json",
    "pkg/idl/demo/generated/dds/generate-dds-typed-bindings.sh",
  ]);
  const unexpectedGoGenerated = Object.keys(files).filter((path) => path.startsWith("pkg/idl/demo/generated/go/") && !expectedGoGenerated.has(path));
  if (unexpectedGoGenerated.length > 0) {
    throw new Error(`Unexpected Go pkg generated files: ${unexpectedGoGenerated.join(", ")}`);
  }
  const consumerOnlyFiles = renderScaffoldFiles({
    ...manifest,
    language: "cpp",
    interfaces: manifest.interfaces.filter((item) => item.name === "plan_action"),
  });
  const unexpectedConsumerPkgFiles = Object.keys(consumerOnlyFiles).filter((path) =>
    path.startsWith("pkg/idl/planner_service/generated/")
  );
  if (unexpectedConsumerPkgFiles.length > 0) {
    throw new Error(`Consumer-only modules must not generate upstream provider-owned pkg/idl protocol files: ${unexpectedConsumerPkgFiles.join(", ")}`);
  }
  if (!consumerOnlyFiles["pkg/idl/demo/generated/cpp/client.hpp"] || !consumerOnlyFiles["pkg/idl/demo/generated/cpp/provider.hpp"] || !consumerOnlyFiles["pkg/idl/demo/generated/cpp/registry.hpp"]) {
    throw new Error("Consumer-only modules must generate current-service pkg/idl client/provider/registry protocol files");
  }
  const mixedCppFiles = renderScaffoldFiles({ ...manifest, language: "cpp" });
  if (!mixedCppFiles["pkg/idl/demo/generated/cpp/service.hpp"] || !mixedCppFiles["pkg/idl/demo/generated/cpp/ports.hpp"] || !mixedCppFiles["pkg/idl/demo/generated/cpp/provider.hpp"] || !mixedCppFiles["pkg/idl/demo/generated/cpp/registry.hpp"]) {
    throw new Error("Provider-owned C++ role abstractions must be generated for the current service");
  }
  if (!mixedCppFiles["pkg/idl/demo/generated/cpp/ports.hpp"].includes("class PlayActionService") || !mixedCppFiles["pkg/idl/demo/generated/cpp/provider.hpp"].includes("std::shared_ptr<ports::PlayActionService> PlayActionService")) {
    throw new Error("Provider-owned C++ abstractions must use route-specific service ports");
  }
  if (Object.keys(mixedCppFiles).some((path) => path.startsWith("pkg/idl/planner_service/generated/cpp/"))) {
    throw new Error("Consumer routes must not generate a second language under an upstream provider's pkg/idl tree");
  }
  if (Object.keys(mixedCppFiles).some((path) => path.includes("audio/music_state"))) {
    throw new Error("C++ generated file paths must sanitize route names that contain slashes");
  }
  const shadowedCppFiles = renderScaffoldFiles({
    ...manifest,
    language: "cpp",
    runtimePackage: "aimrt_msgs",
    includeRuntimeRegistry: true,
  });
  const shadowedCppTypeFiles = new Map([
    ["runtime/ros2/generated_interface_registry.hpp", shadowedCppFiles["runtime/ros2/generated_interface_registry.hpp"]],
    ["api/handler/include/play_action_api_handler.hpp", shadowedCppFiles["api/handler/include/play_action_api_handler.hpp"]],
    ["service/generated/include/play_action_service.hpp", shadowedCppFiles["service/generated/include/play_action_service.hpp"]],
    ["pkg/idl/demo/generated/cpp/ports.hpp", shadowedCppFiles["pkg/idl/demo/generated/cpp/ports.hpp"]],
  ]);
  if (!shadowedCppFiles["runtime/ros2/generated_interface_registry.hpp"]?.includes("namespace pacific_rim::generated::aimrt_msgs")) {
    throw new Error("C++ runtime_package collision fixture must render inside the shadowing generated namespace");
  }
  if (shadowedCppFiles["runtime/ros2/generated_interface_registry.hpp"]?.includes("audio/music_state")) {
    throw new Error("C++ generated registry must sanitize route identifiers that contain slashes");
  }
  for (const [path, content] of shadowedCppTypeFiles) {
    if (!content?.includes("::aimrt_msgs::srv::PlayAction")) {
      throw new Error(`C++ ROSIDL type references must be globally qualified in ${path}`);
    }
    const unqualifiedTypeIndex = content.indexOf("aimrt_msgs::srv::PlayAction");
    if (unqualifiedTypeIndex >= 0 && content[unqualifiedTypeIndex - 1] !== ":") {
      throw new Error(`C++ ROSIDL type references must not be relative in ${path}`);
    }
  }
  const planRouteNames = planService.bindings.map((binding, index) =>
    `plan_action_${String([
      binding.name,
      binding.middleware,
      binding.transport,
      binding.standard,
      binding.service,
      binding.request,
      binding.request_channel,
      binding.response,
      binding.response_channel,
      binding.topic,
      binding.dds_topic,
      binding.subject,
      binding.nats_subject,
      binding.address,
    ].filter(Boolean).join("_")).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
  );
  if (new Set(planRouteNames).size !== planRouteNames.length) {
    throw new Error(`Expanded route names must be unique across bindings, got ${planRouteNames.join(", ")}`);
  }
  const slashRoutePythonFiles = renderScaffoldFiles({
    ...manifest,
    language: "python",
    runtimePackage: "demo_py",
  });
  if (!slashRoutePythonFiles["demo_py/service/generated/audio_music_state_publisher_service.py"]) {
    throw new Error("Python generated file paths must sanitize route names that contain slashes");
  }
  if (
    Object.keys(slashRoutePythonFiles).some((path) => path.includes("audio/music_state")) ||
    slashRoutePythonFiles["demo_py/service/generated/defaults.py"]?.includes("audio/music_state") ||
    slashRoutePythonFiles["pkg/idl/demo/generated/python/provider.py"]?.includes("audio/music_state_publisher")
  ) {
    throw new Error("Python generated imports and provider attributes must sanitize route names that contain slashes");
  }
  const prDryRun = spawnSync(process.execPath, [
    join(process.cwd(), "bin", "pr.mjs"),
    "gen:interfaces",
    "--service",
    "middleware_pub_test_service",
    "--dry-run",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (prDryRun.error) {
    throw prDryRun.error;
  }
  if (prDryRun.status !== 0) {
    throw new Error(`pr gen:interfaces dry-run failed\n${prDryRun.stdout}\n${prDryRun.stderr}`);
  }
  if (!prDryRun.stdout.includes("module/service/middleware_pub_test_service") || !prDryRun.stdout.includes('"interfaces"')) {
    throw new Error(`pr gen:interfaces dry-run did not invoke interface scaffold: ${prDryRun.stdout}`);
  }
  console.log("interface-scaffold tests passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
