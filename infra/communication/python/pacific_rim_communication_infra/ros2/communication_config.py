from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

try:
  import yaml
except ModuleNotFoundError:  # pragma: no cover - used in minimal test envs.
  yaml = None


PROTO_ENVELOPE_MSG_TYPE = "common/msg/ProtoEnvelope"
PROTO_ENVELOPE_SERVICE_TYPE = "common/srv/ProtoCall"


def rules_from_communication_config(
  communication: dict[str, Any],
  *,
  workspace_root: str | Path | None = None,
  config_path: str | Path | None = None,
) -> list[dict[str, Any]]:
  communication = with_public_interface_refs(communication, workspace_root=workspace_root, config_path=config_path)
  middleware_profiles = middleware_security_profiles(communication.get("middleware") or communication.get("middlewares") or {})
  rules: list[dict[str, Any]] = []
  for name, raw in route_items(communication.get("services") or communication.get("service_routes") or {}):
    rules.extend(bridge_rules_from_service_route(name, raw, middleware_profiles=middleware_profiles))
  for name, raw in route_items(communication.get("topics") or communication.get("topic_routes") or {}):
    rules.extend(bridge_rules_from_topic_route(name, raw, middleware_profiles=middleware_profiles))
  return rules


def route_items(raw_routes: Any):
  if isinstance(raw_routes, dict):
    for name, raw in raw_routes.items():
      if isinstance(raw, dict):
        yield str(name), raw
    return
  if isinstance(raw_routes, list):
    for index, raw in enumerate(raw_routes):
      if isinstance(raw, dict):
        yield str(raw.get("name") or f"route_{index}"), raw


def bridge_rules_from_service_route(
  name: str,
  raw: dict[str, Any],
  *,
  middleware_profiles: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
  return compact_rules(bridge_rule_from_service_route(name, item) for item in expanded_binding_routes(
    raw,
    ros_transports={"ros2", "ros2_service"},
    nats_transports={"nats", "nats_rpc"},
    middleware_profiles=middleware_profiles or {},
  ))


def bridge_rule_from_service_route(name: str, raw: dict[str, Any]) -> dict[str, Any] | None:
  raw = merged_binding_route(raw, ros_transports={"ros2", "ros2_service"}, nats_transports={"nats", "nats_rpc"})
  transport = str(raw.get("transport", "nats_rpc")).strip().lower()
  if transport not in {"nats", "nats_rpc"}:
    return None
  subject = str(raw.get("subject") or raw.get("nats_subject") or raw.get("address") or "").strip()
  ros_service = str(raw.get("ros_service") or raw.get("service") or raw.get("local_service") or "").strip()
  subject = subject or address_for_middleware(raw, "nats")
  ros_service = ros_service or address_for_middleware(raw, "ros2")
  adapter = adapter_from_route(raw)
  contract_format, schema_type = service_schema_fields(raw)
  if not adapter and contract_format == "protobuf_rpc" and ros_service:
    adapter = "ros2_proto_envelope"
  contract = raw.get("contract")
  service_type = str(
    raw.get("ros_service_type")
    or raw.get("service_type")
    or ((contract or {}).get("type") if isinstance(contract, dict) else "")
    or raw.get("message_type")
    or raw.get("msg_type")
    or ""
  ).strip()
  if adapter == "ros2_proto_envelope":
    service_type = PROTO_ENVELOPE_SERVICE_TYPE
  if not subject or not ros_service or not service_type:
    return None
  rule = {
    "name": str(raw.get("name") or name).strip(),
    "enabled": bool(raw.get("enabled", True)),
    "transport": "nats",
    "direction": "nats_rpc_to_ros_service",
    "nats_subject": subject,
    "queue_group": str(raw.get("queue_group", "")).strip(),
    "ros_service": ros_service,
    "service_type": service_type,
    "queue_size": int(raw.get("queue_size", 20)),
    **security_rule_fields(name, raw),
  }
  add_adapter_schema_fields(rule, adapter, contract_format, schema_type)
  return rule


def bridge_rules_from_topic_route(
  name: str,
  raw: dict[str, Any],
  *,
  middleware_profiles: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
  return compact_rules(bridge_rule_from_topic_route(name, item) for item in expanded_binding_routes(
    raw,
    ros_transports={"ros2", "ros2_topic"},
    nats_transports={"nats", "nats_topic"},
    middleware_profiles=middleware_profiles or {},
  ))


def bridge_rule_from_topic_route(name: str, raw: dict[str, Any]) -> dict[str, Any] | None:
  raw = merged_binding_route(raw, ros_transports={"ros2", "ros2_topic"}, nats_transports={"nats", "nats_topic"})
  transport = str(raw.get("transport", "nats_topic")).strip().lower()
  if transport not in {"nats", "nats_topic"}:
    return None
  subject = str(raw.get("subject") or raw.get("nats_subject") or raw.get("address") or "").strip()
  ros_topic = str(raw.get("ros_topic") or raw.get("local_topic") or raw.get("topic") or "").strip()
  subject = subject or address_for_middleware(raw, "nats")
  ros_topic = ros_topic or address_for_middleware(raw, "ros2")
  adapter = adapter_from_route(raw)
  payload_format, schema_type = topic_schema_fields(raw)
  if not adapter and payload_format == "protobuf" and ros_topic:
    adapter = "ros2_proto_envelope"
  msg_type = str(
    raw.get("ros_message_type")
    or raw.get("msg_type")
    or raw.get("message_type")
    or (schema_type if payload_format not in {"protobuf"} else "")
    or ""
  ).strip()
  if adapter == "ros2_proto_envelope":
    msg_type = PROTO_ENVELOPE_MSG_TYPE
  if not subject or not ros_topic or not msg_type:
    return None

  direction = str(raw.get("direction", "subscribe")).strip().lower()
  bridge_direction = "nats_to_ros_topic"
  if direction in {"publish", "out", "ros_topic_to_nats"}:
    bridge_direction = "ros_topic_to_nats"

  rule = {
    "name": str(raw.get("name") or name).strip(),
    "enabled": bool(raw.get("enabled", True)),
    "transport": "nats",
    "direction": bridge_direction,
    "nats_subject": subject,
    "queue_group": str(raw.get("queue_group", "")).strip(),
    "ros_topic": ros_topic,
    "msg_type": msg_type,
    "queue_size": int(raw.get("queue_size", 10)),
    **security_rule_fields(name, raw),
  }
  if raw.get("nats_message_type"):
    rule["nats_message_type"] = str(raw.get("nats_message_type")).strip()
  add_adapter_schema_fields(rule, adapter, payload_format, schema_type)
  return rule


def expanded_binding_routes(
  raw: dict[str, Any],
  ros_transports: set[str],
  nats_transports: set[str],
  middleware_profiles: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
  bindings = raw.get("bindings") or raw.get("routes")
  if not isinstance(bindings, list):
    simplified = simplified_bridge_route(raw, middleware_profiles or {})
    if simplified is not None:
      return [simplified]
    inherited = dict(raw)
    inherit_security_profile(inherited, middleware_profiles or {})
    return [inherited]

  base = {key: value for key, value in raw.items() if key not in {"bindings", "routes"}}
  ros_binding: dict[str, Any] = {}
  nats_bindings: list[dict[str, Any]] = []
  for binding in bindings:
    if not isinstance(binding, dict):
      continue
    transport = str(binding.get("transport", "")).strip().lower()
    if transport in ros_transports and not ros_binding:
      ros_binding = binding
    if transport in nats_transports:
      nats_bindings.append(binding)
  if not ros_binding or not nats_bindings:
    return [raw]

  routes: list[dict[str, Any]] = []
  for binding in nats_bindings:
    merged = dict(base)
    merged.update(binding)
    if ros_binding.get("service") or ros_binding.get("ros_service"):
      merged["ros_service"] = ros_binding.get("ros_service") or ros_binding.get("service")
    if ros_binding.get("topic") or ros_binding.get("ros_topic"):
      merged["ros_topic"] = ros_binding.get("ros_topic") or ros_binding.get("topic")
    if "service_type" not in merged and base.get("service_type"):
      merged["service_type"] = base["service_type"]
    if "contract" not in merged and base.get("contract"):
      merged["contract"] = base["contract"]
    if "message_type" not in merged and base.get("message_type"):
      merged["message_type"] = base["message_type"]
    if "ros_message_type" not in merged and base.get("ros_message_type"):
      merged["ros_message_type"] = base["ros_message_type"]
    if "ros_message_type" not in merged and ros_binding.get("ros_message_type"):
      merged["ros_message_type"] = ros_binding["ros_message_type"]
    if "ros_service_type" not in merged and base.get("ros_service_type"):
      merged["ros_service_type"] = base["ros_service_type"]
    if "ros_service_type" not in merged and ros_binding.get("ros_service_type"):
      merged["ros_service_type"] = ros_binding["ros_service_type"]
    if "adapter" not in merged and (base.get("adapter") or ros_binding.get("adapter")):
      merged["adapter"] = base.get("adapter") or ros_binding.get("adapter")
    if "payload" not in merged and base.get("payload"):
      merged["payload"] = base["payload"]
    if "metadata" in base or "metadata" in ros_binding or "metadata" in binding:
      merged["metadata"] = {
        **dict(base.get("metadata", {}) or {}),
        **dict(ros_binding.get("metadata", {}) or {}),
        **dict(binding.get("metadata", {}) or {}),
      }
    inherit_security_profile(merged, middleware_profiles or {})
    routes.append(merged)
  return routes


def simplified_bridge_route(
  raw: dict[str, Any],
  middleware_profiles: dict[str, str],
) -> dict[str, Any] | None:
  middlewares = raw.get("middlewares")
  if not isinstance(middlewares, list):
    return None
  normalized = {normalize_token(item) for item in middlewares}
  if "nats" not in normalized or "ros2" not in normalized:
    return None

  merged = dict(raw)
  merged.pop("middlewares", None)
  merged["middleware"] = "nats"
  merged["transport"] = "nats_rpc" if is_service_route(raw) else "nats_topic"
  nats_address = address_for_middleware(raw, "nats")
  ros_address = address_for_middleware(raw, "ros2")
  if nats_address:
    merged["subject"] = nats_address
  if ros_address:
    if is_service_route(raw):
      merged["ros_service"] = ros_address
    else:
      merged["ros_topic"] = ros_address
  inherit_security_profile(merged, middleware_profiles)
  return merged


def is_service_route(raw: dict[str, Any]) -> bool:
  contract = raw.get("contract")
  return bool(
    raw.get("service_ref")
    or raw.get("service_type")
    or raw.get("ros_service_type")
    or raw.get("service")
    or raw.get("ros_service")
    or isinstance(contract, dict)
    or normalize_token(raw.get("data")) in {"srv", "ros2_srv", "rosidl_srv", "protobuf_rpc"}
  )


def security_rule_fields(name: str, raw: dict[str, Any]) -> dict[str, Any]:
  fields: dict[str, Any] = {
    "logical_route": str(raw.get("logical_route") or raw.get("source_name") or name).strip(),
    "binding_name": str(raw.get("binding_name") or raw.get("middleware") or raw.get("transport") or "").strip(),
  }
  if raw.get("security_profile"):
    fields["security_profile"] = str(raw.get("security_profile")).strip()
  return fields


def adapter_from_route(raw: dict[str, Any]) -> str:
  metadata = raw.get("metadata")
  metadata_adapter = ""
  if isinstance(metadata, dict):
    metadata_adapter = str(metadata.get("adapter") or metadata.get("ros2.adapter") or "").strip()
  return normalize_token(raw.get("adapter") or metadata_adapter)


def normalize_token(value: Any) -> str:
  return str(value or "").strip().lower().replace("-", "_")


def schema_fields(raw_schema: Any) -> tuple[str, str]:
  if not isinstance(raw_schema, dict):
    return "", ""
  schema_type = str(raw_schema.get("type") or "").strip()
  return normalize_token(raw_schema.get("format")), schema_type


def topic_schema_fields(raw: dict[str, Any]) -> tuple[str, str]:
  payload_format, schema_type = schema_fields(raw.get("payload"))
  if payload_format or schema_type:
    return payload_format or infer_topic_payload_format(schema_type), schema_type
  data = normalize_token(raw.get("data") or raw.get("data_format"))
  route_type = str(raw.get("type") or raw.get("message_type") or raw.get("msg_type") or raw.get("ros_message_type") or "").strip()
  return topic_payload_format_for(data, route_type), route_type


def service_schema_fields(raw: dict[str, Any]) -> tuple[str, str]:
  contract_format, schema_type = schema_fields(raw.get("contract"))
  if contract_format or schema_type:
    return contract_format or infer_service_contract_format(schema_type), schema_type
  data = normalize_token(raw.get("data") or raw.get("data_format"))
  route_type = str(raw.get("type") or raw.get("service_type") or raw.get("message_type") or raw.get("ros_service_type") or "").strip()
  return service_contract_format_for(data, route_type), route_type


def add_adapter_schema_fields(
  rule: dict[str, Any],
  adapter: str,
  schema_format: str,
  schema_type: str,
) -> None:
  if adapter:
    rule["adapter"] = adapter
  if schema_format:
    rule["schema_format"] = schema_format
  if schema_type:
    rule["schema_type"] = schema_type
  if schema_format in {"protobuf", "protobuf_rpc"}:
    rule["codec"] = "protobuf"


def middleware_security_profiles(raw_middleware: Any) -> dict[str, str]:
  profiles: dict[str, str] = {}
  if not isinstance(raw_middleware, dict):
    return profiles
  for name, raw in raw_middleware.items():
    if isinstance(raw, dict) and raw.get("security_profile"):
      profiles[str(name)] = str(raw.get("security_profile")).strip()
  return profiles


def inherit_security_profile(raw: dict[str, Any], middleware_profiles: dict[str, str]) -> None:
  if raw.get("security_profile"):
    return
  middleware = str(raw.get("middleware") or "").strip()
  if middleware and middleware_profiles.get(middleware):
    raw["security_profile"] = middleware_profiles[middleware]


def compact_rules(candidates) -> list[dict[str, Any]]:
  return [rule for rule in candidates if rule is not None]


def merged_binding_route(
  raw: dict[str, Any],
  ros_transports: set[str],
  nats_transports: set[str],
) -> dict[str, Any]:
  bindings = raw.get("bindings") or raw.get("routes")
  if not isinstance(bindings, list):
    return raw

  base = {key: value for key, value in raw.items() if key not in {"bindings", "routes"}}
  ros_binding: dict[str, Any] = {}
  nats_binding: dict[str, Any] = {}
  for binding in bindings:
    if not isinstance(binding, dict):
      continue
    transport = str(binding.get("transport", "")).strip().lower()
    if transport in ros_transports and not ros_binding:
      ros_binding = binding
    if transport in nats_transports and not nats_binding:
      nats_binding = binding

  if not ros_binding or not nats_binding:
    return raw

  merged = dict(base)
  merged.update(nats_binding)
  if ros_binding.get("service") or ros_binding.get("ros_service"):
    merged["ros_service"] = ros_binding.get("ros_service") or ros_binding.get("service")
  if ros_binding.get("topic") or ros_binding.get("ros_topic"):
    merged["ros_topic"] = ros_binding.get("ros_topic") or ros_binding.get("topic")
  if "service_type" not in merged and base.get("service_type"):
    merged["service_type"] = base["service_type"]
  if "contract" not in merged and base.get("contract"):
    merged["contract"] = base["contract"]
  if "message_type" not in merged and base.get("message_type"):
    merged["message_type"] = base["message_type"]
  if "ros_message_type" not in merged and base.get("ros_message_type"):
    merged["ros_message_type"] = base["ros_message_type"]
  if "ros_message_type" not in merged and ros_binding.get("ros_message_type"):
    merged["ros_message_type"] = ros_binding["ros_message_type"]
  if "ros_service_type" not in merged and base.get("ros_service_type"):
    merged["ros_service_type"] = base["ros_service_type"]
  if "ros_service_type" not in merged and ros_binding.get("ros_service_type"):
    merged["ros_service_type"] = ros_binding["ros_service_type"]
  if "adapter" not in merged and (base.get("adapter") or ros_binding.get("adapter")):
    merged["adapter"] = base.get("adapter") or ros_binding.get("adapter")
  if "payload" not in merged and base.get("payload"):
    merged["payload"] = base["payload"]
  if "metadata" in base or "metadata" in ros_binding or "metadata" in nats_binding:
    merged["metadata"] = {
      **dict(base.get("metadata", {}) or {}),
      **dict(ros_binding.get("metadata", {}) or {}),
      **dict(nats_binding.get("metadata", {}) or {}),
    }
  return merged


def with_public_interface_refs(
  communication: dict[str, Any],
  *,
  workspace_root: str | Path | None = None,
  config_path: str | Path | None = None,
  service_name: str | None = None,
) -> dict[str, Any]:
  raw_topics = communication.get("topics") or communication.get("topic_routes") or {}
  raw_services = communication.get("services") or communication.get("service_routes") or {}
  if not service_name and not has_topic_refs(raw_topics) and not has_service_refs(raw_services):
    return communication
  catalog = load_public_interface_catalog(workspace_root=workspace_root, config_path=config_path)
  if not catalog["topics"] and not catalog["services"]:
    return communication

  merged = dict(communication)
  topic_key = "topics" if "topics" in communication else "topic_routes"
  if isinstance(raw_topics, dict):
    merged[topic_key] = {
      name: merge_public_topic_route(raw, catalog["topics"]) if isinstance(raw, dict) else raw
      for name, raw in raw_topics.items()
    }
  elif isinstance(raw_topics, list):
    merged[topic_key] = [
      merge_public_topic_route(raw, catalog["topics"]) if isinstance(raw, dict) else raw
      for raw in raw_topics
    ]
  service_key = "services" if "services" in communication else "service_routes"
  if isinstance(raw_services, dict):
    merged[service_key] = {
      name: merge_public_service_route(raw, catalog["services"]) if isinstance(raw, dict) else raw
      for name, raw in raw_services.items()
    }
  elif isinstance(raw_services, list):
    merged[service_key] = [
      merge_public_service_route(raw, catalog["services"]) if isinstance(raw, dict) else raw
      for raw in raw_services
    ]
  inject_own_public_interface_routes(merged, catalog, service_name)
  return merged


def inject_own_public_interface_routes(
  communication: dict[str, Any],
  catalog: dict[str, dict[str, dict[str, Any]]],
  service_name: str | None,
) -> None:
  service_name = str(service_name or "").strip()
  if not service_name:
    return
  topic_key = "topics" if "topics" in communication else "topic_routes"
  service_key = "services" if "services" in communication else "service_routes"
  topics = communication.get(topic_key)
  if not isinstance(topics, dict):
    topics = {}
    communication[topic_key] = topics
  services = communication.get(service_key)
  if not isinstance(services, dict):
    services = {}
    communication[service_key] = services

  for name, route in own_public_routes(catalog["topics"], service_name, "topic_ref"):
    topics.setdefault(name, provider_route_from_public(route))
  for name, route in own_public_routes(catalog["services"], service_name, "service_ref"):
    services.setdefault(name, provider_route_from_public(route))


def own_public_routes(
  routes: dict[str, dict[str, Any]],
  service_name: str,
  ref_key: str,
):
  prefix = f"{service_name}."
  seen: set[str] = set()
  for route in routes.values():
    ref = str(route.get(ref_key) or "").strip()
    if not ref.startswith(prefix) or ref in seen:
      continue
    seen.add(ref)
    name = ref[len(prefix):]
    if name:
      yield name, route


def provider_route_from_public(route: dict[str, Any]) -> dict[str, Any]:
  item = deepcopy(route)
  if not item.get("bindings") and not item.get("routes") and not item.get("middlewares"):
    middlewares = middlewares_from_addresses(item.get("addresses"))
    if middlewares:
      item["middlewares"] = middlewares
  return item


def middlewares_from_addresses(addresses: Any) -> list[str]:
  if not isinstance(addresses, dict):
    return []
  middlewares: list[str] = []
  for key in addresses:
    name = str(key or "").strip()
    if not name:
      continue
    normalized = name.lower().replace("-", "_")
    if normalized == "dds":
      normalized = "cyclonedds"
    if normalized not in middlewares:
      middlewares.append(normalized)
  return middlewares


def has_topic_refs(raw_topics: Any) -> bool:
  if isinstance(raw_topics, dict):
    return any(isinstance(raw, dict) and raw.get("topic_ref") for raw in raw_topics.values())
  if isinstance(raw_topics, list):
    return any(isinstance(raw, dict) and raw.get("topic_ref") for raw in raw_topics)
  return False


def has_service_refs(raw_services: Any) -> bool:
  if isinstance(raw_services, dict):
    return any(isinstance(raw, dict) and raw.get("service_ref") for raw in raw_services.values())
  if isinstance(raw_services, list):
    return any(isinstance(raw, dict) and raw.get("service_ref") for raw in raw_services)
  return False


def merge_public_topic_route(raw: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> dict[str, Any]:
  public = catalog.get(str(raw.get("topic_ref", "")).strip())
  if not public:
    return raw
  merged = dict(public)
  merged.update({key: value for key, value in raw.items() if key not in {"bindings", "routes"}})
  if raw.get("direction"):
    merged["role"] = raw["direction"]
  if raw.get("bindings") or raw.get("routes"):
    merged["bindings"] = merge_public_bindings(
      raw.get("bindings") or raw.get("routes"),
      public.get("bindings"),
      route_overrides=raw,
    )
  elif isinstance(public.get("bindings"), list):
    merged["bindings"] = [
      merge_route_overrides(dict(binding), raw)
      for binding in public["bindings"]
      if isinstance(binding, dict)
    ]
  return merged


def merge_public_service_route(raw: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> dict[str, Any]:
  public = catalog.get(str(raw.get("service_ref", "")).strip())
  if not public:
    return raw
  merged = dict(public)
  merged.update({key: value for key, value in raw.items() if key not in {"bindings", "routes"}})
  if raw.get("direction"):
    merged["role"] = raw["direction"]
  if raw.get("bindings") or raw.get("routes"):
    merged["bindings"] = merge_public_bindings(
      raw.get("bindings") or raw.get("routes"),
      public.get("bindings"),
      route_overrides=raw,
    )
  elif isinstance(public.get("bindings"), list):
    merged["bindings"] = [
      merge_route_overrides(dict(binding), raw)
      for binding in public["bindings"]
      if isinstance(binding, dict)
    ]
  return merged


def merge_public_bindings(
  raw_bindings: Any,
  public_bindings: Any,
  *,
  route_overrides: dict[str, Any],
) -> list[dict[str, Any]]:
  if not isinstance(raw_bindings, list):
    return list(public_bindings or []) if isinstance(public_bindings, list) else []
  if not isinstance(public_bindings, list):
    return [merge_route_overrides(dict(binding), route_overrides) for binding in raw_bindings if isinstance(binding, dict)]
  merged: list[dict[str, Any]] = []
  for binding in raw_bindings:
    if not isinstance(binding, dict):
      continue
    base_index = next((index for index, candidate in enumerate(public_bindings) if same_binding(candidate, binding)), -1)
    base = public_bindings[base_index] if base_index >= 0 else {}
    item = dict(base)
    item.update(binding)
    item = merge_route_overrides(item, route_overrides)
    merged.append(item)
  return merged


def merge_route_overrides(binding: dict[str, Any], route: dict[str, Any]) -> dict[str, Any]:
  if "direction" in route:
    binding["direction"] = route["direction"]
  elif "role" in route and "direction" not in binding:
    binding["direction"] = route["role"]
  for key in ("queue_group", "queue_size", "enabled", "qos", "metadata"):
    if key in route and key not in binding:
      binding[key] = route[key]
  return binding


def same_binding(left: Any, right: Any) -> bool:
  if not isinstance(left, dict) or not isinstance(right, dict):
    return False
  left_transport = str(left.get("transport", "")).strip().lower().replace("-", "_")
  right_transport = str(right.get("transport", "")).strip().lower().replace("-", "_")
  if left_transport and right_transport and left_transport == right_transport:
    return True
  return binding_address(left) and binding_address(left) == binding_address(right)


def binding_address(binding: dict[str, Any]) -> str:
  return str(
    binding.get("topic")
    or binding.get("subject")
    or binding.get("service")
    or binding.get("address")
    or ""
  ).strip()


def public_binding_refs(route: dict[str, Any], *, service_route: bool) -> list[str]:
  refs: list[str] = []

  def add(value: Any) -> None:
    text = str(value or "").strip()
    if text and text not in refs:
      refs.append(text)

  if service_route:
    add(route.get("service"))
    add(route.get("ros_service"))
  else:
    add(route.get("topic"))
    add(route.get("ros_topic"))
  add(route.get("address"))
  addresses = route.get("addresses")
  if isinstance(addresses, dict):
    for value in addresses.values():
      add(value)
  bindings = route.get("bindings")
  if isinstance(bindings, list):
    for binding in bindings:
      if not isinstance(binding, dict):
        continue
      if service_route:
        add(binding.get("service"))
        add(binding.get("ros_service"))
      else:
        add(binding.get("topic"))
        add(binding.get("ros_topic"))
      add(binding.get("address"))
  return refs


def add_public_route_alias(catalog: dict[str, dict[str, Any]], ref: str, route: dict[str, Any]) -> None:
  ref = str(ref or "").strip()
  if ref and ref not in catalog:
    catalog[ref] = route


def address_for_middleware(raw: dict[str, Any], middleware: str) -> str:
  addresses = raw.get("addresses")
  if not isinstance(addresses, dict):
    return ""
  for key in (middleware, middleware.lower().replace("-", "_")):
    value = addresses.get(key)
    if value:
      return str(value).strip()
  return ""


def load_public_interface_catalog(
  *,
  workspace_root: str | Path | None = None,
  config_path: str | Path | None = None,
) -> dict[str, dict[str, dict[str, Any]]]:
  root = resolve_workspace_root(workspace_root=workspace_root, config_path=config_path)
  if root is None:
    return {"topics": {}, "services": {}}
  idl_root = root / "pkg" / "idl"
  if not idl_root.is_dir():
    return {"topics": {}, "services": {}}
  topics: dict[str, dict[str, Any]] = {}
  services: dict[str, dict[str, Any]] = {}
  for manifest in idl_root.glob("*/topics/*.yml"):
    data = public_interface_manifest_catalog(idl_root, manifest)
    topics.update(data["topics"])
    services.update(data["services"])
  for manifest in idl_root.glob("*/topics/*.yaml"):
    data = public_interface_manifest_catalog(idl_root, manifest)
    topics.update(data["topics"])
    services.update(data["services"])
  for manifest in idl_root.glob("*/public/*.yml"):
    data = public_interface_manifest_catalog(idl_root, manifest)
    topics.update(data["topics"])
    services.update(data["services"])
  for manifest in idl_root.glob("*/public/*.yaml"):
    data = public_interface_manifest_catalog(idl_root, manifest)
    topics.update(data["topics"])
    services.update(data["services"])
  return {"topics": topics, "services": services}


def public_interface_manifest_catalog(idl_root: Path, manifest: Path) -> dict[str, dict[str, dict[str, Any]]]:
  try:
    raw = load_yaml_mapping(manifest)
  except Exception:
    return {"topics": {}, "services": {}}
  if not isinstance(raw, dict):
    return {"topics": {}, "services": {}}
  idl_service = manifest.relative_to(idl_root).parts[0]
  topic_entries = raw.get("topics") if isinstance(raw.get("topics"), dict) else None
  if topic_entries is None and not isinstance(raw.get("services"), dict):
    topic_entries = {str(raw.get("name") or manifest.stem): raw}
  topics: dict[str, dict[str, Any]] = {}
  services: dict[str, dict[str, Any]] = {}
  for name, route in (topic_entries or {}).items():
    if not isinstance(route, dict):
      continue
    item = dict(route)
    item["topic_ref"] = f"{idl_service}.{name}"
    normalize_public_topic_item(item)
    topics[f"{idl_service}.{name}"] = item
    for ref in public_binding_refs(item, service_route=False):
      add_public_route_alias(topics, ref, item)
  service_entries = raw.get("services") if isinstance(raw.get("services"), dict) else {}
  for name, route in service_entries.items():
    if not isinstance(route, dict):
      continue
    item = dict(route)
    item["service_ref"] = f"{idl_service}.{name}"
    normalize_public_service_item(item)
    services[f"{idl_service}.{name}"] = item
    for ref in public_binding_refs(item, service_route=True):
      add_public_route_alias(services, ref, item)
  return {"topics": topics, "services": services}


def normalize_public_topic_item(item: dict[str, Any]) -> None:
  payload = item.get("payload")
  if isinstance(payload, dict):
    payload_type = str(payload.get("type") or "").strip()
    if not payload.get("format") and payload_type:
      payload["format"] = infer_topic_payload_format(payload_type)
    if payload.get("type") and not item.get("message_type") and normalize_token(payload.get("format")) == "ros2_msg":
      item["message_type"] = str(payload.get("type"))
    return
  data = str(item.get("data") or item.get("data_format") or "").strip()
  route_type = str(item.get("type") or "").strip()
  if not data and not route_type:
    return
  item["payload"] = {"format": topic_payload_format_for(data, route_type), "type": route_type}
  if item["payload"]["format"] == "ros2_msg" and route_type and not item.get("message_type"):
    item["message_type"] = route_type


def normalize_public_service_item(item: dict[str, Any]) -> None:
  contract = item.get("contract")
  if isinstance(contract, dict):
    contract_type = str(contract.get("type") or "").strip()
    if not contract.get("format") and contract_type:
      contract["format"] = infer_service_contract_format(contract_type)
    if contract.get("type") and not item.get("service_type") and normalize_token(contract.get("format")) == "ros2_srv":
      item["service_type"] = str(contract.get("type"))
    return
  data = str(item.get("data") or item.get("data_format") or "").strip()
  route_type = str(item.get("type") or "").strip()
  if not data and not route_type:
    return
  item["contract"] = {"format": service_contract_format_for(data, route_type), "type": route_type}
  response_type = str(item.get("response_type") or item.get("responseType") or "").strip()
  if response_type:
    item["contract"]["response_type"] = response_type
  if item["contract"]["format"] == "ros2_srv" and route_type and not item.get("service_type"):
    item["service_type"] = route_type


def topic_payload_format(data: str) -> str:
  normalized = normalize_token(data)
  if normalized in {"msg", "ros2_msg", "rosidl_msg"}:
    return "ros2_msg"
  if normalized in {"proto", "protobuf", "protobuf_message"}:
    return "protobuf"
  if normalized in {"bytes", "raw", "cdr", "cdr_bytes"}:
    return "bytes"
  return normalized


def infer_topic_payload_format(type_name: str) -> str:
  if "/msg/" in type_name:
    return "ros2_msg"
  if "::" in type_name:
    return "dds_idl"
  return "protobuf" if type_name.strip() else ""


def topic_payload_format_for(data: str, type_name: str) -> str:
  if normalize_token(data):
    return topic_payload_format(data)
  return infer_topic_payload_format(type_name) or topic_payload_format(data)


def service_contract_format(data: str) -> str:
  normalized = normalize_token(data)
  if normalized in {"srv", "ros2_srv", "rosidl_srv"}:
    return "ros2_srv"
  if normalized in {"proto", "protobuf", "protobuf_rpc", "request_reply", "request_response"}:
    return "protobuf_rpc"
  if normalized in {"bytes", "raw", "cdr", "cdr_bytes"}:
    return "bytes_rpc"
  return normalized


def infer_service_contract_format(type_name: str) -> str:
  if "/srv/" in type_name:
    return "ros2_srv"
  if "::" in type_name:
    return "dds_idl_rpc"
  return "protobuf_rpc" if type_name.strip() else ""


def service_contract_format_for(data: str, type_name: str) -> str:
  if normalize_token(data):
    return service_contract_format(data)
  return infer_service_contract_format(type_name) or service_contract_format(data)


def load_yaml_mapping(path: Path) -> dict[str, Any]:
  text = path.read_text(encoding="utf-8")
  if yaml is not None:
    loaded = yaml.safe_load(text) or {}
    return loaded if isinstance(loaded, dict) else {}
  loaded = parse_yaml_subset(text)
  return loaded if isinstance(loaded, dict) else {}


def parse_yaml_subset(text: str) -> dict[str, Any]:
  root: dict[str, Any] = {}
  stack: list[tuple[int, Any]] = [(-1, root)]
  lines = text.splitlines()

  for index, raw in enumerate(lines):
    line = strip_comment(raw).rstrip()
    if not line.strip():
      continue
    indent = len(raw) - len(raw.lstrip())
    while stack and indent <= stack[-1][0]:
      stack.pop()
    parent = stack[-1][1]
    stripped = line.strip()

    if stripped.startswith("- "):
      if not isinstance(parent, list):
        raise ValueError("list item outside list")
      child = parse_list_item(stripped[2:].strip())
      parent.append(child)
      if isinstance(child, dict):
        stack.append((indent, child))
      continue

    key, value = parse_key_value(stripped)
    if value == "":
      child: Any = [] if next_child_is_list(lines, index, indent) else {}
      assign_yaml(parent, key, child)
      stack.append((indent, child))
    else:
      assign_yaml(parent, key, parse_scalar(value))
  return root


def parse_list_item(text: str) -> Any:
  if not text:
    return {}
  if ":" not in text:
    return parse_scalar(text)
  key, value = parse_key_value(text)
  return {key: parse_scalar(value)}


def next_child_is_list(lines: list[str], index: int, parent_indent: int) -> bool:
  for raw in lines[index + 1:]:
    line = strip_comment(raw).rstrip()
    if not line.strip():
      continue
    indent = len(raw) - len(raw.lstrip())
    return indent > parent_indent and line.strip().startswith("- ")
  return False


def strip_comment(line: str) -> str:
  in_single = False
  in_double = False
  for index, char in enumerate(line):
    if char == "'" and not in_double:
      in_single = not in_single
    elif char == '"' and not in_single:
      in_double = not in_double
    elif char == "#" and not in_single and not in_double:
      return line[:index]
  return line


def parse_key_value(text: str) -> tuple[str, str]:
  if ":" not in text:
    raise ValueError(f"expected key/value: {text}")
  key, value = text.split(":", 1)
  return key.strip(), value.strip()


def parse_scalar(value: str) -> Any:
  unquoted = value.strip().strip('"').strip("'")
  if unquoted == "{}":
    return {}
  if unquoted == "[]":
    return []
  if unquoted == "true":
    return True
  if unquoted == "false":
    return False
  try:
    if "." in unquoted:
      return float(unquoted)
    return int(unquoted)
  except ValueError:
    return unquoted


def assign_yaml(parent: Any, key: str, value: Any) -> None:
  if not isinstance(parent, dict):
    raise ValueError("can only assign keys inside mappings")
  parent[key] = value


def resolve_workspace_root(
  *,
  workspace_root: str | Path | None = None,
  config_path: str | Path | None = None,
) -> Path | None:
  if workspace_root:
    return Path(workspace_root).expanduser().resolve()
  candidates: list[Path] = []
  if config_path:
    candidates.extend(Path(config_path).expanduser().resolve().parents)
  candidates.extend(Path(__file__).resolve().parents)
  for candidate in candidates:
    if (candidate / "pkg" / "idl").is_dir():
      return candidate
  return None
