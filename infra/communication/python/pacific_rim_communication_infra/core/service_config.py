from __future__ import annotations

import re
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, PubSubRoute, RpcRoute, TransportKind

from .security import SECURITY_METADATA_PROFILE, SECURITY_OPTION_PROFILE


def load_service_communication_config(raw: Mapping[str, Any]) -> tuple[
  dict[str, MiddlewareConfig],
  list[PubSubRoute],
  list[RpcRoute],
]:
  service_name = _service_name(raw)
  section = raw.get("communication", {}) or {}
  middleware = _middleware_map(section.get("middleware") or section.get("middlewares") or {})
  middleware.update(_referenced_default_middleware(section, middleware))
  pubsub_routes = _topic_routes(_expand_middlewares(section.get("topics") or section.get("topic_routes") or {}, "topic"), service_name, middleware)
  rpc_routes = _service_routes(_expand_middlewares(section.get("services") or section.get("service_routes") or {}, "service"), service_name, middleware)

  ros = raw.get("ros", {}) or {}
  if ros:
    middleware.update(_legacy_ros_middleware(ros))
    rpc_routes.extend(_legacy_ros_service_routes(ros, service_name))
    pubsub_routes.extend(_legacy_ros_topic_routes(ros, service_name))

  return middleware, pubsub_routes, rpc_routes


def _middleware_map(raw: Mapping[str, Any]) -> dict[str, MiddlewareConfig]:
  configs: dict[str, MiddlewareConfig] = {}
  for name, value in raw.items():
    if isinstance(value, str):
      options: dict[str, Any] = {}
      _apply_middleware_transport_defaults(options, value)
      configs[str(name)] = MiddlewareConfig(transport=_transport(value), name=str(name), options=options)
      continue

    item = dict(value or {})
    transport = item.pop("transport", item.pop("kind", name))
    options = dict(item.pop("options", {}) or {})
    qos = dict(item.pop("qos", {}) or {})
    options.update({f"qos.{key}": value for key, value in qos.items()})
    bridge = dict(item.pop("bridge", {}) or {})
    options.update({f"bridge.{key}": value for key, value in bridge.items()})
    if item.get("security_profile"):
      options[SECURITY_OPTION_PROFILE] = item["security_profile"]
    if item.get("implementation"):
      options["implementation"] = item["implementation"]
    if item.get("rmw_implementation"):
      options["rmw_implementation"] = item["rmw_implementation"]
    options.update(item)
    _apply_middleware_transport_defaults(options, transport)
    configs[str(name)] = MiddlewareConfig(
      transport=_transport(transport),
      name=str(name),
      options=options,
    )
  return configs


def _apply_middleware_transport_defaults(options: dict[str, Any], transport: Any) -> None:
  normalized = _normalize_token(transport)
  if normalized in {
    "fastdds",
    "fast_dds",
    "fastrtps",
    "fast_rtps",
    "fastdds_topic",
    "fastdds_rpc",
  }:
    options.setdefault("middleware.family", "fastdds")
    options.setdefault("implementation", "native_fastdds")


def _referenced_default_middleware(
  section: Mapping[str, Any],
  middleware: Mapping[str, MiddlewareConfig],
) -> dict[str, MiddlewareConfig]:
  configs: dict[str, MiddlewareConfig] = {}

  def add(item: Mapping[str, Any], kind: str) -> None:
    if not _is_high_level_route(item):
      return
    name = str(item.get("middleware") or "").strip()
    if not name:
      return
    plan = _execution_plan(name, _route_format(item, kind), kind)
    route_middleware = str(plan.get("runtime_name") or plan.get("middleware_name") or "").strip()
    if not route_middleware or route_middleware in middleware or route_middleware in configs:
      return
    if plan["transport"]:
      configs[route_middleware] = MiddlewareConfig(
        transport=plan["transport"],
        name=route_middleware,
        options=_plan_options(plan, middleware.get(str(plan.get("middleware_name") or ""))),
      )

  raw_topics = _expand_middlewares(section.get("topics") or section.get("topic_routes") or {}, "topic")
  raw_services = _expand_middlewares(section.get("services") or section.get("service_routes") or {}, "service")
  for _, _, item in _expanded_route_items(raw_topics, "topic"):
    add(item, "topic")
  for _, _, item in _expanded_route_items(raw_services, "service"):
    add(item, "service")
  return configs


def _is_high_level_route(item: Mapping[str, Any]) -> bool:
  return bool(
    (
      item.get("data")
      or item.get("data_format")
      or item.get("type")
      or item.get("payload")
      or item.get("contract")
      or item.get("message_type")
      or item.get("service_type")
      or item.get("middleware")
    )
    and not item.get("transport")
    and not isinstance(item.get("bindings") or item.get("routes"), list)
  )


def _expand_middlewares(raw: Any, default_name: str) -> Any:
  if isinstance(raw, Mapping):
    expanded: dict[str, Any] = {}
    for name, item in raw.items():
      if not isinstance(item, Mapping) or not isinstance(item.get("middlewares"), list):
        expanded[name] = item
        continue
      for middleware in item.get("middlewares") or []:
        route = dict(item)
        route.pop("middlewares", None)
        route.pop("bindings", None)
        route.pop("routes", None)
        route["middleware"] = middleware
        expanded[f"{name}_{_route_name(middleware)}"] = route
    return expanded
  expanded_list: list[Any] = []
  for index, item in enumerate(raw or []):
    if not isinstance(item, Mapping) or not isinstance(item.get("middlewares"), list):
      expanded_list.append(item)
      continue
    base_name = str(item.get("name") or f"{default_name}_{index}")
    for middleware in item.get("middlewares") or []:
      route = dict(item)
      route.pop("middlewares", None)
      route.pop("bindings", None)
      route.pop("routes", None)
      route["name"] = f"{base_name}_{_route_name(middleware)}"
      route["middleware"] = middleware
      expanded_list.append(route)
  return expanded_list


def _normalize_topic_route(item: Mapping[str, Any]) -> dict[str, Any]:
  route = dict(item or {})
  if not _is_high_level_route(route):
    return route
  data = str(route.get("data") or route.get("data_format") or _format_from(route.get("payload")) or "").strip()
  route_type = str(
    _type_from(route.get("payload"))
    or route.get("type")
    or route.get("message_type")
    or route.get("msg_type")
    or route.get("ros_message_type")
    or ""
  ).strip()
  payload_format = _topic_payload_format_for(data, route_type)
  plan = _execution_plan(str(route.get("middleware") or "").strip(), payload_format, "topic")
  route["transport"] = route.get("transport") or plan["transport_name"]
  if plan.get("middleware_name"):
    route["middleware"] = plan["middleware_name"]
  payload = dict(route.get("payload", {}) or {})
  payload.setdefault("format", payload_format)
  payload.setdefault("type", route_type)
  route["payload"] = payload
  if payload.get("format") == "ros2_msg" and not route.get("message_type"):
    route["message_type"] = payload.get("type", "")
  route["metadata"] = _execution_metadata(route.get("metadata"), plan)
  adapter = _default_ros2_byte_adapter("topic", route.get("transport"), payload.get("format"))
  if adapter and not _adapter(route):
    route["adapter"] = adapter
  return route


def _normalize_service_route(item: Mapping[str, Any]) -> dict[str, Any]:
  route = dict(item or {})
  if not _is_high_level_route(route):
    return route
  data = str(route.get("data") or route.get("data_format") or _format_from(route.get("contract")) or "").strip()
  route_type = str(
    _type_from(route.get("contract"))
    or route.get("type")
    or route.get("service_type")
    or route.get("message_type")
    or route.get("ros_service_type")
    or ""
  ).strip()
  contract_format = _service_contract_format_for(data, route_type)
  plan = _execution_plan(str(route.get("middleware") or "").strip(), contract_format, "service")
  route["transport"] = route.get("transport") or plan["transport_name"]
  if plan.get("middleware_name"):
    route["middleware"] = plan["middleware_name"]
  contract = dict(route.get("contract", {}) or {})
  contract.setdefault("format", contract_format)
  contract.setdefault("type", route_type)
  route["contract"] = contract
  if contract.get("format") == "ros2_srv" and not route.get("service_type"):
    route["service_type"] = contract.get("type", "")
  route["metadata"] = _execution_metadata(route.get("metadata"), plan)
  adapter = _default_ros2_byte_adapter("service", route.get("transport"), contract.get("format"))
  if adapter and not _adapter(route):
    route["adapter"] = adapter
  return route


def _format_from(value: Any) -> str:
  if isinstance(value, Mapping):
    return str(value.get("format") or "").strip()
  return ""


def _type_from(value: Any) -> str:
  if isinstance(value, Mapping):
    return str(value.get("type") or "").strip()
  return ""


def _topic_payload_format(data: str) -> str:
  normalized = _normalize_token(data)
  if normalized in {"proto", "protobuf", "protobuf_message"}:
    return "protobuf"
  if normalized in {"msg", "ros2_msg", "rosidl_msg"}:
    return "ros2_msg"
  if normalized in {"dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl"}:
    return "dds_idl"
  if normalized in {"bytes", "raw", "cdr", "cdr_bytes"}:
    return "bytes"
  return normalized or "bytes"


def _infer_topic_payload_format(type_name: str) -> str:
  if "/msg/" in type_name:
    return "ros2_msg"
  if "::" in type_name:
    return "dds_idl"
  return "protobuf" if type_name.strip() else ""


def _topic_payload_format_for(data: str, type_name: str) -> str:
  if _normalize_token(data):
    return _topic_payload_format(data)
  return _infer_topic_payload_format(type_name) or _topic_payload_format(data)


def _service_contract_format(data: str) -> str:
  normalized = _normalize_token(data)
  if normalized in {"proto", "protobuf", "protobuf_rpc", "request_reply", "request_response"}:
    return "protobuf_rpc"
  if normalized in {"srv", "ros2_srv", "rosidl_srv"}:
    return "ros2_srv"
  if normalized in {"dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl", "dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl"}:
    return "dds_idl_rpc"
  if normalized in {"bytes", "raw", "cdr", "cdr_bytes"}:
    return "bytes_rpc"
  if normalized == "json":
    return "json_rpc"
  return normalized or "bytes_rpc"


def _infer_service_contract_format(type_name: str) -> str:
  if "/srv/" in type_name:
    return "ros2_srv"
  if "::" in type_name:
    return "dds_idl_rpc"
  return "protobuf_rpc" if type_name.strip() else ""


def _service_contract_format_for(data: str, type_name: str) -> str:
  if _normalize_token(data):
    return _service_contract_format(data)
  return _infer_service_contract_format(type_name) or _service_contract_format(data)


def _route_data_format(item: Mapping[str, Any]) -> str:
  return str(
    item.get("data")
    or item.get("data_format")
    or _format_from(item.get("payload"))
    or _format_from(item.get("contract"))
    or ""
  ).strip()


def _route_format(item: Mapping[str, Any], kind: str) -> str:
  data = _route_data_format(item)
  if kind == "service":
    type_name = str(
      _type_from(item.get("contract"))
      or item.get("type")
      or item.get("service_type")
      or item.get("message_type")
      or item.get("ros_service_type")
      or ""
    ).strip()
    return _service_contract_format_for(data, type_name)
  type_name = str(
    _type_from(item.get("payload"))
    or item.get("type")
    or item.get("message_type")
    or item.get("msg_type")
    or item.get("ros_message_type")
    or ""
  ).strip()
  return _topic_payload_format_for(data, type_name)


def _execution_plan(protocol: str, _data: str, kind: str) -> dict[str, Any]:
  normalized_protocol = _normalize_route_middleware_protocol(protocol)
  if normalized_protocol == "cyclonedds":
    format_name = _service_contract_format(_data) if kind == "service" else _topic_payload_format(_data)
    if _is_native_dds_format(format_name, kind):
      return {
        "transport": TransportKind.CYCLONE_DDS,
        "transport_name": "cyclonedds_rpc" if kind == "service" else "cyclonedds_topic",
        "middleware_name": "cyclonedds",
        "family": "cyclonedds",
        "implementation": "native_cyclonedds",
        "options": {
          "middleware.family": "cyclonedds",
          "implementation": "native_cyclonedds",
        },
      }
    return {
      "transport": TransportKind.ROS2,
      "transport_name": "ros2_service" if kind == "service" else "ros2_topic",
      "middleware_name": "cyclonedds",
      "runtime_name": "cyclonedds__rmw",
      "family": "cyclonedds",
      "implementation": "rmw_cyclonedds",
      "options": {
        "middleware.family": "cyclonedds",
        "implementation": "rmw_cyclonedds",
        "rmw_implementation": "rmw_cyclonedds_cpp",
      },
    }
  if normalized_protocol == "fastdds":
    format_name = _service_contract_format(_data) if kind == "service" else _topic_payload_format(_data)
    if _is_native_dds_format(format_name, kind):
      return {
        "transport": TransportKind.FAST_DDS,
        "transport_name": "fastdds_rpc" if kind == "service" else "fastdds_topic",
        "middleware_name": "fastdds",
        "family": "fastdds",
        "implementation": "native_fastdds",
        "options": {
          "middleware.family": "fastdds",
          "implementation": "native_fastdds",
        },
      }
    return {
      "transport": TransportKind.ROS2,
      "transport_name": "ros2_service" if kind == "service" else "ros2_topic",
      "middleware_name": "fastdds",
      "runtime_name": "fastdds__rmw",
      "family": "fastdds",
      "implementation": "rmw_fastrtps",
      "options": {
        "middleware.family": "fastdds",
        "implementation": "rmw_fastrtps",
        "rmw_implementation": "rmw_fastrtps_cpp",
      },
    }
  if normalized_protocol == "ros2":
    return {
      "transport": TransportKind.ROS2,
      "transport_name": "ros2_service" if kind == "service" else "ros2_topic",
      "middleware_name": "ros2",
      "family": "ros2",
      "implementation": "",
      "options": {},
    }
  return {
    "transport": TransportKind.NATS,
    "transport_name": "nats_rpc" if kind == "service" else "nats_topic",
    "middleware_name": "nats",
    "family": "nats",
    "implementation": "",
    "options": {},
  }


def _is_native_dds_format(format_name: str, kind: str) -> bool:
  normalized = _normalize_token(format_name)
  if kind == "service":
    return normalized in {"protobuf_rpc", "dds_idl_rpc"}
  return normalized in {"protobuf", "dds_idl"}


def _normalize_route_middleware_protocol(value: str) -> str:
  normalized = _normalize_token(value)
  if normalized in {"nats", "nats_topic", "nats_rpc"}:
    return "nats"
  if normalized in {
    "cyclonedds",
    "cyclone_dds",
  }:
    return "cyclonedds"
  if normalized in {
    "fastdds",
    "fast_dds",
    "fastrtps",
    "fast_rtps",
  }:
    return "fastdds"
  if normalized in {"ros2", "ros2_topic", "ros2_service"}:
    return "ros2"
  if not normalized:
    raise ValueError("high-level route middleware is required; use nats, cyclonedds, fastdds, or ros2")
  raise ValueError(f"unsupported high-level route middleware {value!r}; use nats, cyclonedds, fastdds, or ros2")


def _plan_options(plan: Mapping[str, Any], base: MiddlewareConfig | None = None) -> dict[str, Any]:
  options = dict(base.options if base else {})
  options.update(dict(plan.get("options") or {}))
  return options


def _execution_metadata(metadata: Any, plan: Mapping[str, Any]) -> dict[str, Any]:
  result = dict(metadata or {})
  if plan.get("family"):
    result["middleware.family"] = plan["family"]
  runtime_name = str(plan.get("runtime_name") or plan.get("middleware_name") or "").strip()
  if runtime_name:
    result["middleware.runtime"] = runtime_name
  if plan.get("implementation"):
    result["middleware.implementation"] = plan["implementation"]
    result["implementation"] = plan["implementation"]
  if plan.get("implementation") == "rmw_cyclonedds":
    result["rmw_implementation"] = "rmw_cyclonedds_cpp"
  elif plan.get("implementation") == "rmw_fastrtps":
    result["rmw_implementation"] = "rmw_fastrtps_cpp"
  return result


def _topic_routes(raw: Any, service_name: str, middleware: Mapping[str, MiddlewareConfig]) -> list[PubSubRoute]:
  routes: list[PubSubRoute] = []
  for index, name, item in _expanded_route_items(raw, "topic"):
    if not _enabled(item):
      continue
    item = _normalize_topic_route(item)
    transport = _transport(item.get("transport", item.get("middleware", "nats_topic")))
    _validate_topic_compatibility(name, item, transport)
    address = _channel_address(item, transport, "topic")
    if not address:
      continue

    channel = _endpoint(transport, address, item)
    local = Endpoint(transport=TransportKind.IN_PROCESS, address=service_name)
    direction = str(item.get("direction") or item.get("mode") or "publish").lower()
    publisher, subscriber = (local, channel) if direction in {"subscribe", "in"} else (channel, local)
    routes.append(
      PubSubRoute(
        name=str(item.get("name") or name or f"topic_route_{index}"),
        publisher=publisher,
        subscriber=subscriber,
        queue_size=int(item.get("queue_size", 10)),
        enabled=True,
      )
    )
  return routes


def _service_routes(raw: Any, service_name: str, middleware: Mapping[str, MiddlewareConfig]) -> list[RpcRoute]:
  routes: list[RpcRoute] = []
  for index, name, item in _expanded_route_items(raw, "service"):
    if not _enabled(item):
      continue
    item = _normalize_service_route(item)
    transport = _transport(item.get("transport", "nats_rpc"))
    _validate_service_compatibility(name, item, transport)
    address = _channel_address(item, transport, "service")
    if not address:
      continue
    routes.append(
      RpcRoute(
        name=str(item.get("name") or _route_name(name) or f"service_route_{index}"),
        client=Endpoint(transport=transport, address=service_name, metadata=_endpoint_metadata(item)),
        server=_endpoint(transport, address, item),
        timeout_ms=_duration_ms(item.get("timeout", item.get("timeout_ms", 2000))),
        enabled=True,
      )
    )
  return routes


def _legacy_ros_middleware(ros: Mapping[str, Any]) -> dict[str, MiddlewareConfig]:
  nats = dict(ros.get("nats", {}) or {})
  if not nats or nats.get("enabled") is False:
    return {}

  options: dict[str, Any] = {}
  if "server_url" in nats:
    options["server_url"] = nats["server_url"]
  if "connect_timeout" in nats:
    options["connect_timeout_sec"] = _duration_sec(nats["connect_timeout"])
  return {"nats": MiddlewareConfig(transport=TransportKind.NATS, name="nats", options=options)}


def _legacy_ros_service_routes(ros: Mapping[str, Any], service_name: str) -> list[RpcRoute]:
  raw_routes = ros.get("service_routes", {}) or {}
  routes: list[RpcRoute] = []
  for service_path, item in raw_routes.items():
    route = dict(item or {})
    if str(route.get("transport", "")).lower() != "nats_rpc":
      continue
    routes.extend(_service_routes({service_path: route}, service_name, {}))
  return routes


def _legacy_ros_topic_routes(ros: Mapping[str, Any], service_name: str) -> list[PubSubRoute]:
  rgb = dict(ros.get("rgb_expression_light", {}) or {})
  if not rgb.get("enabled", False):
    return []
  return _topic_routes(
    {
      "rgb_expression_light": {
        "transport": "nats_topic",
        "direction": "publish",
        "subject": rgb.get("nats_subject", ""),
        "local_topic": rgb.get("ros_topic", ""),
      }
    },
    service_name,
    {},
  )


def _route_items(raw: Any, default_name: str):
  if isinstance(raw, Mapping):
    for index, (name, item) in enumerate(raw.items()):
      value = dict(item or {})
      value.setdefault("source_name", name)
      yield index, str(name), value
    return
  for index, item in enumerate(raw or []):
    value = dict(item or {})
    yield index, str(value.get("name") or f"{default_name}_{index}"), value


def _expanded_route_items(raw: Any, default_name: str):
  for index, name, item in _route_items(raw, default_name):
    bindings = item.get("bindings") or item.get("routes")
    if not isinstance(bindings, list):
      item.setdefault("logical_route", name)
      yield index, str(item.get("name") or name), item
      continue

    base = {key: value for key, value in item.items() if key not in {"bindings", "routes"}}
    for binding_index, binding in enumerate(bindings):
      if not isinstance(binding, Mapping):
        continue
      merged = dict(base)
      merged.update(dict(binding))
      for key in ("metadata", "qos"):
        merged[key] = {
          **dict(base.get(key, {}) or {}),
          **dict(binding.get(key, {}) or {}),
        }
      binding_label = _binding_label(merged, binding_index)
      merged["logical_route"] = name
      merged["binding_name"] = binding_label
      merged.setdefault("name", f"{name}_{_route_name(binding_label)}")
      yield index + binding_index, str(merged["name"]), merged


def _binding_label(item: Mapping[str, Any], index: int) -> str:
  return str(
    item.get("name")
    or item.get("middleware")
    or item.get("transport")
    or f"binding_{index}"
  )


def _endpoint(transport: TransportKind, address: str, item: Mapping[str, Any]) -> Endpoint:
  metadata = _endpoint_metadata(item)
  return Endpoint(
    transport=transport,
    address=address,
    message_type=_endpoint_type(transport, metadata, item),
    metadata=metadata,
  )


def _endpoint_type(
  transport: TransportKind,
  metadata: Mapping[str, Any],
  item: Mapping[str, Any],
) -> str:
  if transport == TransportKind.ROS2 and str(metadata.get("adapter", "")).strip() == "ros2_typed_mapper":
    ros2_type = (
      metadata.get("ros_message_type")
      or metadata.get("ros_service_type")
      or metadata.get("ros2.message_type")
      or metadata.get("ros2.service_type")
    )
    if ros2_type:
      return str(ros2_type)
  return str(_payload_type(item) or _contract_type(item) or item.get("message_type") or item.get("msg_type") or item.get("service_type") or "")


def _payload_type(item: Mapping[str, Any]) -> str:
  payload = item.get("payload")
  if isinstance(payload, Mapping):
    return str(payload.get("type") or "").strip()
  return ""


def _contract_type(item: Mapping[str, Any]) -> str:
  contract = item.get("contract")
  if isinstance(contract, Mapping):
    return str(contract.get("type") or "").strip()
  return ""


def _endpoint_metadata(item: Mapping[str, Any]) -> dict[str, Any]:
  metadata = dict(item.get("metadata", {}) or {})
  qos = dict(item.get("qos", {}) or {})
  metadata.update({f"qos.{key}": value for key, value in qos.items()})
  if "queue_size" in item and "qos.depth" not in metadata:
    metadata["qos.depth"] = item["queue_size"]
  if item.get("middleware"):
    metadata["middleware"] = item["middleware"]
  adapter = _adapter(item)
  if adapter:
    metadata["adapter"] = adapter
    metadata["ros2.adapter"] = adapter
  if item.get("ros_message_type"):
    metadata["ros_message_type"] = str(item["ros_message_type"]).strip()
    metadata["ros2.message_type"] = str(item["ros_message_type"]).strip()
  if item.get("ros_service_type"):
    metadata["ros_service_type"] = str(item["ros_service_type"]).strip()
    metadata["ros2.service_type"] = str(item["ros_service_type"]).strip()
  _put_codec_metadata(metadata, item)
  if item.get("queue_group"):
    metadata["queue_group"] = item["queue_group"]
  if item.get("direction"):
    metadata["direction"] = item["direction"]
  if item.get("role"):
    metadata["role"] = item["role"]
  if item.get("local_topic"):
    metadata["local_topic"] = item["local_topic"]
  if item.get("source_name"):
    metadata["source_name"] = item["source_name"]
  if item.get("logical_route"):
    metadata["logical_route"] = item["logical_route"]
  if item.get("binding_name"):
    metadata["binding_name"] = item["binding_name"]
  if item.get("security_profile"):
    metadata[SECURITY_METADATA_PROFILE] = item["security_profile"]
  normalized_transport = str(item.get("transport") or "").strip().lower().replace("-", "_")
  if normalized_transport in {"cyclonedds_rpc", "dds_rpc", "fastdds_rpc"}:
    metadata["rpc.transport"] = "fastdds_rpc" if normalized_transport == "fastdds_rpc" else "cyclonedds_rpc"
    metadata["rpc.standard"] = "omg_dds_rpc" if normalized_transport == "fastdds_rpc" else _dds_rpc_standard(item.get("standard", ""))
    request = item.get("request") or item.get("request_channel")
    response = item.get("response") or item.get("response_channel")
    if request:
      metadata["rpc.request_channel"] = str(request).strip()
    if response:
      metadata["rpc.response_channel"] = str(response).strip()
  return metadata


def _channel_address(item: Mapping[str, Any], transport: TransportKind, kind: str) -> str:
  route_name = str(item.get("logical_route") or item.get("source_name") or item.get("name") or "").strip()
  configured_address = _middleware_address(item.get("addresses"), item.get("middleware"), transport)
  if configured_address:
    if transport == TransportKind.ROS2:
      return _ros2_address(configured_address)
    return configured_address
  if transport == TransportKind.NATS:
    prefix = "robot.rpc" if kind == "service" else "robot.topic"
    return str(item.get("subject") or item.get("nats_subject") or item.get("address") or (f"{prefix}.{route_name}" if route_name else "")).strip()
  if transport in {TransportKind.CYCLONE_DDS, TransportKind.FAST_DDS}:
    return str(
      item.get("topic")
      or item.get("dds_topic")
      or item.get("address")
      or item.get("service")
      or item.get("request")
      or item.get("request_channel")
      or ((route_name.replace("/", ".") + ".request") if kind == "service" and route_name else route_name.replace("/", ".") if route_name else "")
      or ""
    ).strip()
  if transport == TransportKind.ROS2:
    return _ros2_address(
      item.get("address")
      or item.get("ros_service")
      or item.get("service")
      or item.get("ros_topic")
      or item.get("topic")
      or (f"/{route_name.replace('.', '/')}" if route_name else "")
      or ""
    )
  return str(item.get("address") or item.get("service") or item.get("topic") or "").strip()


def _ros2_address(value: Any) -> str:
  text = str(value or "").strip()
  if not text or text.startswith("/") or text.startswith("~") or "." not in text:
    return text
  return f"/{text.replace('.', '/')}"


def _middleware_address(raw: Any, middleware: Any, transport: TransportKind) -> str:
  if not isinstance(raw, Mapping):
    return ""
  candidates = [
    str(middleware or ""),
    str(transport.value if isinstance(transport, TransportKind) else transport),
    str(middleware or "").strip().lower().replace("-", "_"),
  ]
  if transport == TransportKind.ROS2:
    candidates.append("ros2")
  elif transport == TransportKind.NATS:
    candidates.append("nats")
  elif transport == TransportKind.CYCLONE_DDS:
    candidates.extend(["cyclonedds", "dds"])
  elif transport == TransportKind.FAST_DDS:
    candidates.append("fastdds")
  for key in candidates:
    value = raw.get(key)
    if value:
      return str(value).strip()
  return ""


def _transport(value: Any) -> TransportKind:
  if isinstance(value, TransportKind):
    return value
  normalized = str(value).strip().lower().replace("-", "_")
  aliases = {
    "dds": TransportKind.CYCLONE_DDS,
    "cyclone_dds": TransportKind.CYCLONE_DDS,
    "cyclonedds": TransportKind.CYCLONE_DDS,
    "fastdds": TransportKind.FAST_DDS,
    "fast_dds": TransportKind.FAST_DDS,
    "fastrtps": TransportKind.FAST_DDS,
    "fast_rtps": TransportKind.FAST_DDS,
    "fastdds_topic": TransportKind.FAST_DDS,
    "fastdds_rpc": TransportKind.FAST_DDS,
    "cyclonedds_topic": TransportKind.CYCLONE_DDS,
    "cyclonedds_rpc": TransportKind.CYCLONE_DDS,
    "dds_topic": TransportKind.CYCLONE_DDS,
    "dds_rpc": TransportKind.CYCLONE_DDS,
    "nats_rpc": TransportKind.NATS,
    "nats_topic": TransportKind.NATS,
    "ros2_service": TransportKind.ROS2,
    "ros2_topic": TransportKind.ROS2,
  }
  if normalized in aliases:
    return aliases[normalized]
  return TransportKind(normalized)


def _normalize_token(value: Any) -> str:
  return str(value or "").strip().lower().replace("-", "_")


def _dds_rpc_standard(value: Any) -> str:
  normalized = str(value or "").strip().lower().replace("-", "_")
  aliases = {
    "": "omg_dds_rpc",
    "omg": "omg_dds_rpc",
    "dds_rpc": "omg_dds_rpc",
    "omg_dds_rpc": "omg_dds_rpc",
    "rmw": "rmw_cyclonedds",
    "rmw_cyclonedds": "rmw_cyclonedds",
    "rmw_cyclonedds_cpp": "rmw_cyclonedds",
    "ros2_rmw": "rmw_cyclonedds",
  }
  return aliases.get(normalized, normalized)


def _adapter(item: Mapping[str, Any]) -> str:
  metadata = item.get("metadata")
  if isinstance(metadata, Mapping):
    value = metadata.get("adapter") or metadata.get("ros2.adapter")
  else:
    value = ""
  return str(item.get("adapter") or value or "").strip().lower().replace("-", "_")


def _is_ros2_proto_adapter(adapter: str) -> bool:
  return adapter in {"ros2_proto_envelope", "ros2_typed_mapper"}


def _default_ros2_byte_adapter(kind: str, transport: Any, format_name: Any) -> str:
  normalized_transport = str(transport or "").strip().lower().replace("-", "_")
  normalized_format = str(format_name or "").strip().lower().replace("-", "_")
  if kind == "topic" and normalized_transport == "ros2_topic":
    if normalized_format == "protobuf":
      return "ros2_proto_envelope"
    if normalized_format in {"ros2_msg", "rosidl_msg"}:
      return "ros2_typed_mapper"
  if kind == "service" and normalized_transport == "ros2_service":
    if normalized_format == "protobuf_rpc":
      return "ros2_proto_envelope"
    if normalized_format in {"ros2_srv", "rosidl_srv"}:
      return "ros2_typed_mapper"
  return ""


def _put_codec_metadata(metadata: dict[str, Any], item: Mapping[str, Any]) -> None:
  payload = item.get("payload")
  contract = item.get("contract")
  format_name = ""
  type_name = ""
  if isinstance(payload, Mapping):
    format_name = str(payload.get("format") or "").strip().lower()
    type_name = str(payload.get("type") or "").strip()
  if isinstance(contract, Mapping):
    format_name = str(contract.get("format") or "").strip().lower()
    type_name = str(contract.get("type") or "").strip()
  format_name = _codec_metadata_format(format_name)
  if format_name in {"protobuf", "protobuf_rpc"}:
    metadata["codec"] = "protobuf"
    metadata["schema.format"] = format_name
    if type_name:
      metadata["schema.type"] = type_name
  if format_name in {"dds_idl", "dds_idl_rpc"}:
    metadata["codec"] = "cdr"
    metadata["schema.format"] = format_name
    metadata["schema.language"] = "omg_idl"
    metadata["dds.mode"] = "typed_preferred"
    metadata["dds.fallback"] = "byte_envelope"
    metadata["dds.runtime"] = "typed_native"
    metadata["dds.codegen"] = "required_for_typed"
    metadata["dds.envelope.type"] = "PacificRimMessageEnvelope"
    if type_name:
      metadata["schema.type"] = type_name
      metadata["dds.type"] = type_name


def _codec_metadata_format(format_name: str) -> str:
  normalized = _normalize_token(format_name)
  if normalized in {"proto", "protobuf", "protobuf_message"}:
    return "protobuf"
  if normalized in {"protobuf_rpc", "request_reply", "request_response"}:
    return "protobuf_rpc"
  if normalized in {"dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl"}:
    return "dds_idl"
  if normalized in {"dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl"}:
    return "dds_idl_rpc"
  return normalized


def _validate_topic_compatibility(name: str, item: Mapping[str, Any], transport: TransportKind) -> None:
  binding = str(item.get("transport") or "nats_topic").strip().lower().replace("-", "_")
  payload = item.get("payload")
  format_name = ""
  if isinstance(payload, Mapping):
    format_name = str(payload.get("format") or "").strip().lower()
  if not format_name and (item.get("message_type") or item.get("msg_type")):
    format_name = "ros2_msg"
  if (
    transport == TransportKind.ROS2
    and binding == "ros2_topic"
    and format_name not in {"", "ros2_msg", "rosidl_msg"}
    and not (format_name == "protobuf" and _is_ros2_proto_adapter(_adapter(item)))
  ):
    raise ValueError(f"topic {name}: ros2_topic is native for rosidl message; {format_name} requires an adapter")
  if transport == TransportKind.FAST_DDS and format_name and not _is_native_dds_format(format_name, "topic"):
    raise ValueError(f"topic {name}: fastdds_topic is native for protobuf or OMG IDL CDR data; use middleware fastdds with data msg for ROS IDL data")
  if binding in {"cyclonedds_rpc", "dds_rpc", "fastdds_rpc"}:
    raise ValueError(f"topic {name}: {binding} is request/reply; use communication.services")


def _validate_service_compatibility(name: str, item: Mapping[str, Any], transport: TransportKind) -> None:
  binding = str(item.get("transport") or "nats_rpc").strip().lower().replace("-", "_")
  contract = item.get("contract")
  format_name = ""
  if isinstance(contract, Mapping):
    format_name = str(contract.get("format") or "").strip().lower()
  if not format_name and (item.get("service_type") or item.get("message_type")):
    format_name = "ros2_srv"
  if (
    transport == TransportKind.ROS2
    and binding == "ros2_service"
    and format_name not in {"", "ros2_srv", "rosidl_srv"}
    and not (format_name == "protobuf_rpc" and _is_ros2_proto_adapter(_adapter(item)))
  ):
    raise ValueError(f"service {name}: ros2_service is native for rosidl service; {format_name} requires an adapter")
  if binding == "grpc" and format_name not in {"", "protobuf_rpc"}:
    raise ValueError(f"service {name}: grpc is native for protobuf service; {format_name} requires an adapter")
  if transport == TransportKind.FAST_DDS and format_name and not _is_native_dds_format(format_name, "service"):
    raise ValueError(f"service {name}: fastdds_rpc is native for protobuf RPC or OMG DDS-RPC CDR data; use middleware fastdds with data srv for ROS IDL data")
  if binding in {"cyclonedds_topic", "dds_topic", "fastdds_topic"}:
    raise ValueError(f"service {name}: {binding} is pub/sub; use cyclonedds_rpc or fastdds_rpc for request/reply")
  if binding in {"cyclonedds_rpc", "dds_rpc"}:
    standard = _dds_rpc_standard(item.get("standard", ""))
    if standard not in {"omg_dds_rpc", "rmw_cyclonedds"}:
      raise ValueError(f"service {name}: cyclonedds_rpc standard must be omg_dds_rpc or rmw_cyclonedds")
  if binding == "fastdds_rpc" and _dds_rpc_standard(item.get("standard", "")) != "omg_dds_rpc":
    raise ValueError(f"service {name}: fastdds_rpc standard must be omg_dds_rpc")


def _duration_ms(value: Any) -> int:
  return int(_duration_sec(value) * 1000)


def _duration_sec(value: Any) -> float:
  if isinstance(value, (int, float)):
    return float(value)
  text = str(value).strip().lower()
  if text.endswith("ms"):
    return float(text[:-2]) / 1000.0
  if text.endswith("s"):
    return float(text[:-1])
  return float(text)


def _route_name(value: Any) -> str:
  return re.sub(r"[^a-zA-Z0-9_]+", "_", str(value).strip("/")).strip("_")


def _service_name(raw: Mapping[str, Any]) -> str:
  return str(
    raw.get("service_name")
    or (raw.get("trace", {}) or {}).get("service_name")
    or "local_service"
  )


def _enabled(item: Mapping[str, Any]) -> bool:
  return bool(item.get("enabled", True))
