#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import queue
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import rclpy
import yaml
from rclpy.node import Node
from rosidl_runtime_py.convert import message_to_ordereddict
from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_message, get_service

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, TransportKind
from pacific_rim_communication_infra.core.security import (
    SECURITY_METADATA_PROFILE,
    SecurityCodec,
    SecurityRuntime,
    load_security_settings,
)
from pacific_rim_communication_infra.ros2.communication_config import rules_from_communication_config

try:
    from nats.aio.client import Client as NATS
except ImportError as exc:  # pragma: no cover - runtime dependency guard
    NATS = None
    NATS_IMPORT_ERROR = exc
else:
    NATS_IMPORT_ERROR = None


NATS_DIRECTIONS = {
    "ros_topic_to_nats",
    "nats_to_ros_topic",
    "nats_rpc_to_ros_service",
}


@dataclass
class BridgeRule:
    name: str
    enabled: bool
    transport: str
    direction: str
    nats_subject: str = ""
    queue_group: str = ""
    ros_topic: str = ""
    msg_type: str = ""
    nats_message_type: str = ""
    ros_service: str = ""
    service_type: str = ""
    queue_size: int = 20
    security_profile: str = ""
    logical_route: str = ""
    binding_name: str = ""
    adapter: str = ""
    schema_format: str = ""
    schema_type: str = ""
    codec: str = ""
    message_class: Any = None
    service_class: Any = None
    publisher: Any = None
    subscription: Any = None


@dataclass(frozen=True)
class RpcServiceRequest:
    rule: BridgeRule
    payload: Any
    reply: str


@dataclass(frozen=True)
class TopicPublish:
    rule: BridgeRule
    payload: Any


class NatsRos2BridgeNode(Node):
    def __init__(self) -> None:
        super().__init__("nats_ros2_bridge")

        if NATS is None:
            raise RuntimeError(f"nats-py is required. Import failed: {NATS_IMPORT_ERROR}")

        self.declare_parameter("config_file", "")
        self.declare_parameter("mapper_module", "")
        config_file = str(self.get_parameter("config_file").value).strip()
        if not config_file:
            raise ValueError("nats_ros2_bridge requires a config_file parameter")

        self.config_path = Path(config_file).expanduser().resolve()
        self.config = self._load_config(self.config_path)
        mapper_module = str(self.get_parameter("mapper_module").value).strip()
        self.mapper = self._load_mapper(mapper_module or self.config.get("mapper_module", ""))
        self.adapter_id = str(
            self.config.get("adapter_id") or f"{socket.gethostname()}-{self.get_name()}"
        ).strip()
        self.server_url = str(self.config.get("server_url", "nats://127.0.0.1:4222")).strip()
        self.connect_timeout_sec = float(self.config.get("connect_timeout_sec", 2.0))
        self.reconnect_wait_sec = float(self.config.get("reconnect_wait_sec", 2.0))
        self.max_reconnect_attempts = int(self.config.get("max_reconnect_attempts", -1))
        self.service_wait_timeout_sec = float(self.config.get("service_wait_timeout_sec", 1.0))
        self.ros_work_period_sec = float(self.config.get("ros_work_period_sec", 0.02))

        self.security = SecurityRuntime(load_security_settings(self.config))
        self.security_codecs: dict[tuple[str, str], SecurityCodec | None] = {}
        self.rules = self._load_rules(self.config.get("rules", []))
        self.service_clients: dict[str, Any] = {}
        self.work_queue: queue.Queue[Any] = queue.Queue()

        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(
            target=self._run_event_loop,
            name=f"{self.get_name()}-nats-loop",
            daemon=True,
        )
        self._loop_thread.start()
        self._nc = None

        self._create_ros_endpoints()
        self._work_timer = self.create_timer(self.ros_work_period_sec, self._drain_work_queue)
        self._connect_future = asyncio.run_coroutine_threadsafe(
            self._connect_and_subscribe(),
            self._loop,
        )
        self._connect_future.add_done_callback(self._log_connect_result)

        enabled_rules = [
            rule
            for rule in self.rules
            if rule.enabled and rule.transport == "nats" and rule.direction in NATS_DIRECTIONS
        ]
        self.get_logger().info(
            "nats_ros2_bridge started: "
            f"adapter_id={self.adapter_id}, server_url={self.server_url}, "
            f"config_file={self.config_path}, enabled_nats_rules={len(enabled_rules)}"
        )

    def destroy_node(self) -> bool:
        try:
            if self._nc is not None:
                future = asyncio.run_coroutine_threadsafe(self._close_nats(), self._loop)
                future.result(timeout=5.0)
        except Exception as exc:  # pragma: no cover - best-effort shutdown
            self.get_logger().warn(f"failed to close NATS cleanly: {exc}")

        if self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._loop_thread.is_alive():
            self._loop_thread.join(timeout=5.0)
        return super().destroy_node()

    def _run_event_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _load_config(self, path: Path) -> dict[str, Any]:
        if not path.is_file():
            raise FileNotFoundError(f"NATS/ROS2 bridge config not found: {path}")

        with path.open("r", encoding="utf-8") as handle:
            raw = yaml.safe_load(handle) or {}
        if not isinstance(raw, dict):
            raise ValueError(f"bridge config must be a mapping: {path}")

        runtime = raw.get("runtime", {}) or {}
        bridge_runtime = runtime.get("nats_ros2_bridge", {}) if isinstance(runtime, dict) else {}
        if isinstance(bridge_runtime, dict) and bridge_runtime:
            config = dict(bridge_runtime)
            if isinstance(raw.get("communication"), dict):
                config["communication"] = raw["communication"]
        else:
            config = raw.get("adapter", raw)
        if not isinstance(config, dict):
            raise ValueError(f"NATS/ROS2 bridge config section must be a mapping: {path}")
        config = self._with_communication_rules(config)
        return self._expand_env(config)

    def _with_communication_rules(self, config: dict[str, Any]) -> dict[str, Any]:
        communication = config.get("communication")
        if not isinstance(communication, dict):
            return config
        generated = rules_from_communication_config(communication, config_path=self.config_path)
        if not generated:
            return config
        merged = dict(config)
        existing = list(merged.get("rules", []) or [])
        existing_names = {
            str(rule.get("name", "")).strip()
            for rule in existing
            if isinstance(rule, dict)
        }
        for rule in generated:
            if str(rule.get("name", "")).strip() not in existing_names:
                existing.append(rule)
        merged["rules"] = existing
        return merged

    def _expand_env(self, value: Any) -> Any:
        if isinstance(value, str):
            return os.path.expandvars(value)
        if isinstance(value, list):
            return [self._expand_env(item) for item in value]
        if isinstance(value, dict):
            return {key: self._expand_env(item) for key, item in value.items()}
        return value

    def _load_mapper(self, mapper_module: Any) -> Any:
        mapper_text = str(mapper_module or "").strip()
        if not mapper_text:
            return None

        mapper_path = Path(mapper_text)
        if not mapper_path.is_absolute():
            mapper_path = (self.config_path.parent / mapper_path).resolve()
        if not mapper_path.is_file():
            raise FileNotFoundError(f"NATS/ROS2 mapper not found: {mapper_path}")

        spec = importlib.util.spec_from_file_location("nats_ros2_bridge_mapper", mapper_path)
        if spec is None or spec.loader is None:
            raise ValueError(f"cannot load mapper module: {mapper_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.get_logger().info(f"loaded bridge mapper: {mapper_path}")
        return module

    def _load_rules(self, raw_rules: Any) -> list[BridgeRule]:
        if not isinstance(raw_rules, list):
            raise ValueError("bridge rules must be a list")

        rules: list[BridgeRule] = []
        for index, raw_rule in enumerate(raw_rules):
            if not isinstance(raw_rule, dict):
                raise ValueError(f"rule at index {index} must be a mapping")

            direction = str(raw_rule.get("direction", "")).strip().lower()
            if direction == "nats_to_ros_service":
                direction = "nats_rpc_to_ros_service"

            rule = BridgeRule(
                name=str(raw_rule.get("name") or f"rule_{index}").strip(),
                enabled=bool(raw_rule.get("enabled", True)),
                transport=str(raw_rule.get("transport", "nats")).strip().lower(),
                direction=direction,
                nats_subject=str(raw_rule.get("nats_subject", "")).strip(),
                queue_group=str(raw_rule.get("queue_group", "")).strip(),
                ros_topic=str(raw_rule.get("ros_topic", "")).strip(),
                msg_type=str(raw_rule.get("msg_type", "")).strip(),
                nats_message_type=str(
                    raw_rule.get("nats_message_type", raw_rule.get("msg_type", ""))
                ).strip(),
                ros_service=str(raw_rule.get("ros_service", "")).strip(),
                service_type=str(raw_rule.get("service_type", "")).strip(),
                queue_size=int(raw_rule.get("queue_size", 20)),
                security_profile=str(raw_rule.get("security_profile", "")).strip(),
                logical_route=str(raw_rule.get("logical_route", raw_rule.get("name", ""))).strip(),
                binding_name=str(raw_rule.get("binding_name", raw_rule.get("name", ""))).strip(),
                adapter=normalize_token(raw_rule.get("adapter", "")),
                schema_format=normalize_token(raw_rule.get("schema_format", "")),
                schema_type=str(raw_rule.get("schema_type", "")).strip(),
                codec=normalize_token(raw_rule.get("codec", "")),
            )

            if not rule.enabled or rule.transport == "ros2_native":
                rules.append(rule)
                continue
            if rule.transport != "nats":
                raise ValueError(f"rule {rule.name} has invalid transport: {rule.transport}")
            if rule.direction not in NATS_DIRECTIONS:
                raise ValueError(f"rule {rule.name} has invalid direction: {rule.direction}")
            if not rule.nats_subject:
                raise ValueError(f"rule {rule.name} is missing nats_subject")

            if rule.direction in {"ros_topic_to_nats", "nats_to_ros_topic"}:
                if not rule.ros_topic:
                    raise ValueError(f"rule {rule.name} is missing ros_topic")
                if not rule.msg_type:
                    raise ValueError(f"rule {rule.name} is missing msg_type")
                if rule.adapter == "ros2_typed_mapper" and self.mapper is None:
                    raise ValueError(
                        f"rule {rule.name} uses ros2_typed_mapper but no mapper_module is configured"
                    )
                rule.message_class = get_message(rule.msg_type)
            elif rule.direction == "nats_rpc_to_ros_service":
                if not rule.ros_service:
                    raise ValueError(f"rule {rule.name} is missing ros_service")
                if not rule.service_type:
                    raise ValueError(f"rule {rule.name} is missing service_type")
                if rule.adapter == "ros2_typed_mapper" and self.mapper is None:
                    raise ValueError(
                        f"rule {rule.name} uses ros2_typed_mapper but no mapper_module is configured"
                    )
                rule.service_class = get_service(rule.service_type)

            rules.append(rule)
        return rules

    def _create_ros_endpoints(self) -> None:
        for rule in self.rules:
            if not rule.enabled:
                self.get_logger().info(f"skip disabled rule {rule.name}")
                continue
            if rule.transport == "ros2_native":
                self.get_logger().info(f"skip native ROS 2 rule {rule.name}")
                continue
            if rule.transport != "nats":
                continue

            if rule.direction == "ros_topic_to_nats":
                rule.subscription = self.create_subscription(
                    rule.message_class,
                    rule.ros_topic,
                    self._make_ros_topic_callback(rule),
                    rule.queue_size,
                )
                self.get_logger().info(
                    f"loaded topic rule {rule.name}: {rule.ros_topic} -> "
                    f"{rule.nats_subject} ({rule.msg_type})"
                )
            elif rule.direction == "nats_to_ros_topic":
                rule.publisher = self.create_publisher(
                    rule.message_class,
                    rule.ros_topic,
                    rule.queue_size,
                )
                self.get_logger().info(
                    f"loaded topic rule {rule.name}: {rule.nats_subject} -> "
                    f"{rule.ros_topic} ({rule.msg_type})"
                )
            elif rule.direction == "nats_rpc_to_ros_service":
                self.service_clients[rule.name] = self.create_client(
                    rule.service_class,
                    rule.ros_service,
                )
                self.get_logger().info(
                    f"loaded RPC rule {rule.name}: {rule.nats_subject} => "
                    f"{rule.ros_service} ({rule.service_type})"
                )

    def _make_ros_topic_callback(self, rule: BridgeRule):
        def callback(message: Any) -> None:
            if rule.adapter == "ros2_proto_envelope":
                payload = proto_envelope_payload(message)
                self._publish_bytes_threadsafe(
                    rule.nats_subject,
                    payload,
                    rule=rule,
                    direction="publish",
                )
                return

            ros_payload = dict(message_to_ordereddict(message))
            try:
                nats_payload = self._nats_payload_for_rule(rule, ros_payload)
            except ValueError as exc:
                self.get_logger().warn(f"drop ROS message for rule {rule.name}: {exc}")
                return

            if isinstance(nats_payload, (bytes, bytearray)):
                self._publish_bytes_threadsafe(
                    rule.nats_subject,
                    bytes(nats_payload),
                    rule=rule,
                    direction="publish",
                )
                return

            message_type = rule.nats_message_type or rule.msg_type
            envelope = {
                "adapter_id": self.adapter_id,
                "source": self.adapter_id,
                "rule_name": rule.name,
                "ros_topic": rule.ros_topic,
                "message_type": message_type,
                "payload_sha256": compute_payload_digest(message_type, nats_payload),
                "published_at_unix_ms": int(time.time() * 1000),
                "payload": nats_payload,
            }
            self._publish_json_threadsafe(rule.nats_subject, envelope, rule=rule, direction="publish")

        return callback

    async def _connect_and_subscribe(self) -> None:
        async def disconnected_cb() -> None:
            self.get_logger().warn("NATS disconnected")

        async def reconnected_cb() -> None:
            current_url = getattr(self._nc, "connected_url", None)
            self.get_logger().info(f"NATS reconnected to {current_url}")

        async def error_cb(error: Exception) -> None:
            self.get_logger().error(f"NATS error: {error}")

        async def closed_cb() -> None:
            self.get_logger().warn("NATS connection closed")

        self._nc = NATS()
        await self._nc.connect(
            servers=[self.server_url],
            name=self.adapter_id,
            connect_timeout=self.connect_timeout_sec,
            reconnect_time_wait=self.reconnect_wait_sec,
            max_reconnect_attempts=self.max_reconnect_attempts,
            allow_reconnect=True,
            disconnected_cb=disconnected_cb,
            reconnected_cb=reconnected_cb,
            error_cb=error_cb,
            closed_cb=closed_cb,
        )
        self.get_logger().info(f"NATS connected to {self.server_url}")

        for rule in self.rules:
            if not rule.enabled or rule.transport != "nats":
                continue
            if rule.direction not in {"nats_to_ros_topic", "nats_rpc_to_ros_service"}:
                continue

            await self._nc.subscribe(
                rule.nats_subject,
                queue=rule.queue_group or None,
                cb=self._make_nats_callback(rule),
            )
            self.get_logger().info(
                f"subscribed NATS subject {rule.nats_subject} for rule {rule.name}"
            )

    def _make_nats_callback(self, rule: BridgeRule):
        if rule.direction == "nats_to_ros_topic":
            return self._make_nats_topic_callback(rule)
        return self._make_nats_rpc_callback(rule)

    def _make_nats_topic_callback(self, rule: BridgeRule):
        async def callback(message: Any) -> None:
            raw_payload = message.data
            try:
                raw_payload = self._decrypt_rule_payload(rule, raw_payload, "publish")
                if rule.adapter == "ros2_proto_envelope":
                    envelope, payload = {}, raw_payload
                elif rule.adapter == "ros2_typed_mapper":
                    envelope, payload = {}, raw_payload
                else:
                    envelope, payload = parse_nats_topic_payload(raw_payload)
            except ValueError as exc:
                self.get_logger().warn(
                    f"drop invalid NATS topic payload for rule {rule.name}: {exc}"
                )
                return

            if envelope and str(envelope.get("adapter_id", "")).strip() == self.adapter_id:
                self.get_logger().debug(f"skip self-originated topic payload for {rule.name}")
                return

            message_type = envelope_message_type(envelope, rule.msg_type) if envelope else rule.msg_type
            if envelope and message_type and message_type != rule.msg_type:
                self.get_logger().warn(
                    f"drop NATS topic payload for rule {rule.name}: "
                    f"expected {rule.msg_type}, got {message_type}"
                )
                return

            self.work_queue.put(TopicPublish(rule=rule, payload=payload))

        return callback

    def _make_nats_rpc_callback(self, rule: BridgeRule):
        async def callback(message: Any) -> None:
            raw_payload = message.data
            try:
                raw_payload = self._decrypt_rule_payload(rule, raw_payload, "rpc_request")
                payload = raw_payload if rule.adapter in {"ros2_proto_envelope", "ros2_typed_mapper"} else parse_nats_rpc_payload(raw_payload)
            except ValueError as exc:
                self.get_logger().warn(
                    f"drop invalid NATS RPC payload for rule {rule.name}: {exc}"
                )
                if rule.adapter in {"ros2_proto_envelope", "ros2_typed_mapper"}:
                    await self._publish_reply_bytes(message.reply, str(exc).encode("utf-8"), rule=rule)
                else:
                    await self._publish_reply(message.reply, {"success": False, "message": str(exc)}, rule=rule)
                return

            self.work_queue.put(
                RpcServiceRequest(rule=rule, payload=payload, reply=message.reply or "")
            )

        return callback

    def _drain_work_queue(self) -> None:
        processed = 0
        while processed < 50:
            try:
                item = self.work_queue.get_nowait()
            except queue.Empty:
                return
            processed += 1
            if isinstance(item, TopicPublish):
                self._handle_topic_publish(item)
            elif isinstance(item, RpcServiceRequest):
                self._handle_rpc_service_request(item)
            else:
                self.get_logger().warn(f"drop unknown work item: {type(item)!r}")

    def _handle_topic_publish(self, item: TopicPublish) -> None:
        if item.rule.publisher is None:
            self.get_logger().error(f"rule {item.rule.name} has no ROS topic publisher")
            return
        try:
            message = self._build_topic_message(item.rule, item.payload)
            item.rule.publisher.publish(message)
        except Exception as exc:
            self.get_logger().warn(
                f"failed to publish ROS topic for rule {item.rule.name}: {exc}"
            )

    def _handle_rpc_service_request(self, item: RpcServiceRequest) -> None:
        client = self.service_clients.get(item.rule.name)
        if client is None:
            self._reply_error(item.reply, item.rule, "adapter rule has no ROS service client")
            return

        if not client.wait_for_service(timeout_sec=self.service_wait_timeout_sec):
            message = f"ROS service unavailable: {item.rule.ros_service}"
            self.get_logger().error(message)
            self._reply_error(item.reply, item.rule, message)
            return

        try:
            request = self._build_service_request(item.rule, item.payload)
        except Exception as exc:
            self.get_logger().warn(
                f"invalid {item.rule.service_type} RPC request for rule {item.rule.name}: {exc}"
            )
            self._reply_error(item.reply, item.rule, str(exc))
            return

        future = client.call_async(request)

        def done_callback(done_future: Any) -> None:
            try:
                response = done_future.result()
            except Exception as exc:  # pragma: no cover - rclpy runtime error path
                self._reply_error(item.reply, item.rule, f"service call failed: {exc}")
                return
            if item.rule.adapter == "ros2_proto_envelope":
                self._reply_bytes_threadsafe(
                    item.reply,
                    proto_envelope_payload(response),
                    rule=item.rule,
                )
                return
            if item.rule.adapter == "ros2_typed_mapper":
                payload = self._nats_rpc_response_for_rule(
                    item.rule,
                    dict(message_to_ordereddict(response)),
                    response,
                )
                self._reply_bytes_threadsafe(item.reply, payload, rule=item.rule)
                return
            self._reply_threadsafe(item.reply, dict(message_to_ordereddict(response)), rule=item.rule)

        future.add_done_callback(done_callback)

    def _build_service_request(self, rule: BridgeRule, payload: Any) -> Any:
        if rule.adapter == "ros2_proto_envelope":
            request = rule.service_class.Request()
            fill_proto_envelope_fields(request, rule, bytes(payload or b""))
            return request
        if rule.adapter == "ros2_typed_mapper":
            if self.mapper is not None and hasattr(self.mapper, "build_service_request"):
                mapped = self.mapper.build_service_request(rule.service_type, payload, rule.service_class)
                if mapped is not None:
                    return mapped
            raise ValueError(
                f"rule {rule.name} uses ros2_typed_mapper but mapper.build_service_request returned no request"
            )
        if self.mapper is not None and hasattr(self.mapper, "build_service_request"):
            mapped = self.mapper.build_service_request(rule.service_type, payload, rule.service_class)
            if mapped is not None:
                return mapped
        request = rule.service_class.Request()
        set_message_fields(request, payload)
        return request

    def _build_topic_message(self, rule: BridgeRule, payload: Any) -> Any:
        if rule.adapter == "ros2_proto_envelope":
            message = rule.message_class()
            fill_proto_envelope_fields(message, rule, bytes(payload or b""))
            return message
        if rule.adapter == "ros2_typed_mapper":
            if self.mapper is not None and hasattr(self.mapper, "build_topic_message"):
                mapped = self.mapper.build_topic_message(rule.msg_type, payload, rule.message_class)
                if mapped is not None:
                    return mapped
            raise ValueError(
                f"rule {rule.name} uses ros2_typed_mapper but mapper.build_topic_message returned no message"
            )
        if self.mapper is not None and hasattr(self.mapper, "build_topic_message"):
            mapped = self.mapper.build_topic_message(rule.msg_type, payload, rule.message_class)
            if mapped is not None:
                return mapped
        message = rule.message_class()
        set_message_fields(message, payload)
        return message

    def _nats_payload_for_rule(self, rule: BridgeRule, payload: dict[str, Any]) -> Any:
        if rule.adapter == "ros2_typed_mapper":
            if self.mapper is not None and hasattr(self.mapper, "nats_payload_for_rule"):
                mapped = self.mapper.nats_payload_for_rule(rule, payload)
                if mapped is not None:
                    return bytes_payload(mapped, rule)
            if self.mapper is not None and hasattr(self.mapper, "build_nats_payload"):
                mapped = self.mapper.build_nats_payload(rule.msg_type, payload)
                if mapped is not None:
                    return bytes_payload(mapped, rule)
            raise ValueError(
                f"rule {rule.name} uses ros2_typed_mapper but mapper did not return NATS bytes"
            )
        return nats_payload_for_rule(rule, payload)

    def _nats_rpc_response_for_rule(
        self,
        rule: BridgeRule,
        payload: dict[str, Any],
        response: Any,
    ) -> bytes:
        if self.mapper is not None and hasattr(self.mapper, "nats_rpc_response_for_rule"):
            mapped = self.mapper.nats_rpc_response_for_rule(rule, payload, response)
            if mapped is not None:
                return bytes_payload(mapped, rule)
        if self.mapper is not None and hasattr(self.mapper, "build_nats_response"):
            mapped = self.mapper.build_nats_response(rule.service_type, payload, response)
            if mapped is not None:
                return bytes_payload(mapped, rule)
        raise ValueError(
            f"rule {rule.name} uses ros2_typed_mapper but mapper did not return NATS response bytes"
        )

    async def _publish_json(
        self,
        subject: str,
        payload: dict[str, Any],
        *,
        rule: BridgeRule | None = None,
        direction: str = "publish",
    ) -> None:
        if self._nc is None:
            raise RuntimeError("NATS connection is not initialized")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if rule is not None:
            encoded = self._encrypt_rule_payload(rule, encoded, direction)
        await self._nc.publish(
            subject,
            encoded,
        )

    def _publish_json_threadsafe(
        self,
        subject: str,
        payload: dict[str, Any],
        *,
        rule: BridgeRule | None = None,
        direction: str = "publish",
    ) -> None:
        if self._nc is None:
            self.get_logger().warn(f"drop NATS publish before connection: {subject}")
            return
        future = asyncio.run_coroutine_threadsafe(
            self._publish_json(subject, payload, rule=rule, direction=direction),
            self._loop,
        )
        future.add_done_callback(lambda done: self._log_future(done, f"publish {subject}"))

    async def _publish_bytes(
        self,
        subject: str,
        payload: bytes,
        *,
        rule: BridgeRule | None = None,
        direction: str = "publish",
    ) -> None:
        if self._nc is None:
            raise RuntimeError("NATS connection is not initialized")
        encoded = bytes(payload)
        if rule is not None:
            encoded = self._encrypt_rule_payload(rule, encoded, direction)
        await self._nc.publish(subject, encoded)

    def _publish_bytes_threadsafe(
        self,
        subject: str,
        payload: bytes,
        *,
        rule: BridgeRule | None = None,
        direction: str = "publish",
    ) -> None:
        if self._nc is None:
            self.get_logger().warn(f"drop NATS publish before connection: {subject}")
            return
        future = asyncio.run_coroutine_threadsafe(
            self._publish_bytes(subject, payload, rule=rule, direction=direction),
            self._loop,
        )
        future.add_done_callback(lambda done: self._log_future(done, f"publish {subject}"))

    async def _publish_reply(
        self,
        reply: str,
        payload: dict[str, Any],
        *,
        rule: BridgeRule | None = None,
    ) -> None:
        if reply:
            await self._publish_json(reply, payload, rule=rule, direction="rpc_response")

    async def _publish_reply_bytes(
        self,
        reply: str,
        payload: bytes,
        *,
        rule: BridgeRule | None = None,
    ) -> None:
        if reply:
            await self._publish_bytes(reply, payload, rule=rule, direction="rpc_response")

    def _reply_threadsafe(
        self,
        reply: str,
        payload: dict[str, Any],
        *,
        rule: BridgeRule | None = None,
    ) -> None:
        if not reply or self._nc is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._publish_reply(reply, payload, rule=rule),
            self._loop,
        )

    def _reply_bytes_threadsafe(
        self,
        reply: str,
        payload: bytes,
        *,
        rule: BridgeRule | None = None,
    ) -> None:
        if not reply or self._nc is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._publish_reply_bytes(reply, payload, rule=rule),
            self._loop,
        )

    def _reply_error(self, reply: str, rule: BridgeRule, message: str) -> None:
        if rule.adapter in {"ros2_proto_envelope", "ros2_typed_mapper"}:
            self._reply_bytes_threadsafe(reply, message.encode("utf-8"), rule=rule)
            return
        self._reply_threadsafe(reply, {"success": False, "message": message}, rule=rule)

    def _encrypt_rule_payload(self, rule: BridgeRule, payload: bytes, direction: str) -> bytes:
        codec = self._security_codec_for_rule(rule)
        if codec is None:
            return payload
        return codec.encrypt(payload, direction)

    def _decrypt_rule_payload(self, rule: BridgeRule, payload: bytes, direction: str) -> bytes:
        codec = self._security_codec_for_rule(rule)
        if codec is None:
            return payload
        return codec.decrypt(payload, direction)

    def _security_codec_for_rule(self, rule: BridgeRule) -> SecurityCodec | None:
        cache_key = (rule.name, rule.security_profile or "")
        if cache_key in self.security_codecs:
            return self.security_codecs[cache_key]
        metadata = {
            "middleware": "nats",
            "source_name": rule.name,
            "logical_route": rule.logical_route or rule.name,
            "binding_name": rule.binding_name or rule.name,
        }
        if rule.adapter:
            metadata["adapter"] = rule.adapter
            metadata["ros2.adapter"] = rule.adapter
        if rule.schema_format:
            metadata["schema.format"] = rule.schema_format
        if rule.schema_type:
            metadata["schema.type"] = rule.schema_type
        if rule.codec:
            metadata["codec"] = rule.codec
        if rule.security_profile:
            metadata[SECURITY_METADATA_PROFILE] = rule.security_profile
        message_type = rule.service_type if rule.direction == "nats_rpc_to_ros_service" else rule.nats_message_type or rule.msg_type
        endpoint = Endpoint(
            transport=TransportKind.NATS,
            address=rule.nats_subject,
            message_type=message_type,
            metadata=metadata,
        )
        binding = self.security.resolve_binding(
            "nats",
            MiddlewareConfig(transport=TransportKind.NATS, name="nats"),
            endpoint,
        )
        if binding is None:
            self.security_codecs[cache_key] = None
            return None
        codec = SecurityCodec(binding)
        self.security_codecs[cache_key] = codec
        return codec

    def _log_connect_result(self, future: Any) -> None:
        self._log_future(future, "NATS connect/subscribe")

    def _log_future(self, future: Any, label: str) -> None:
        try:
            future.result()
        except Exception as exc:
            self.get_logger().error(f"{label} failed: {exc}")

    async def _close_nats(self) -> None:
        if self._nc is not None:
            await self._nc.drain()
            await self._nc.close()


def parse_nats_topic_payload(raw: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    decoded = decode_json_payload(raw)
    envelope = decoded if isinstance(decoded, dict) else {}
    payload = unwrap_payload(decoded)
    if not isinstance(payload, dict):
        payload = {"data": payload}
    return envelope, payload


def envelope_message_type(envelope: dict[str, Any], default: str) -> str:
    message_type = str(envelope.get("message_type", "")).strip()
    if message_type:
        return message_type
    message = envelope.get("message")
    if isinstance(message, dict):
        return str(message.get("message_type", default)).strip()
    return default


def parse_nats_rpc_payload(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8").strip()
    if not text:
        raise ValueError("empty payload")
    try:
        decoded: Any = json.loads(text)
    except json.JSONDecodeError:
        return {"action_name": text, "force_quit_all": False}

    payload = unwrap_payload(decoded)
    if isinstance(payload, str):
        stripped = payload.strip()
        if not stripped:
            raise ValueError("empty action name")
        try:
            nested = json.loads(stripped)
        except json.JSONDecodeError:
            return {"action_name": stripped, "force_quit_all": False}
        payload = unwrap_payload(nested)
    if not isinstance(payload, dict):
        raise ValueError("RPC payload must be an object or action-name string")
    return payload


def decode_json_payload(raw: bytes) -> Any:
    text = raw.decode("utf-8").strip()
    if not text:
        raise ValueError("empty payload")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"payload must be JSON: {exc}") from exc


def unwrap_payload(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    if "message" in value and isinstance(value["message"], dict):
        return unwrap_payload(value["message"])
    if "args" in value:
        return value["args"]
    if "payload" in value:
        payload = value["payload"]
        if isinstance(payload, dict) and set(payload.keys()) == {"data"}:
            return payload["data"]
        return payload
    if "msg" in value:
        return value["msg"]
    if set(value.keys()) == {"data"}:
        return value["data"]
    return value


def normalize_token(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_")


def fill_proto_envelope_fields(message: Any, rule: BridgeRule, payload: bytes) -> None:
    message.schema_type = rule.schema_type
    message.codec = rule.codec or "protobuf"
    message.route = rule.logical_route or rule.name
    message.trace_id = ""
    message.created_at_unix_ms = int(time.time() * 1000)
    message.payload = list(payload)


def proto_envelope_payload(message: Any) -> bytes:
    return bytes(getattr(message, "payload", b"") or b"")


def bytes_payload(value: Any, rule: BridgeRule) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    raise ValueError(f"rule {rule.name} mapper must return bytes, got {type(value).__name__}")


def nats_payload_for_rule(rule: BridgeRule, payload: dict[str, Any]) -> dict[str, Any]:
    if not rule.nats_message_type or rule.nats_message_type == rule.msg_type:
        return payload
    if set(payload.keys()) == {"data"} and isinstance(payload["data"], str):
        try:
            decoded = json.loads(payload["data"])
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"rule {rule.name} data must be JSON when nats_message_type differs: {exc}"
            ) from exc
        if isinstance(decoded, dict):
            return decoded
    return payload


def compute_payload_digest(message_type: str, payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        {"message_type": message_type, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def main(args: list[str] | None = None) -> int:
    rclpy.init(args=args)
    node = NatsRos2BridgeNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
