from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, PubSubRoute, RpcRoute, TransportKind

from .routing import CommunicationFabric
from .service_config import load_service_communication_config
from .security import SECURITY_METADATA_PROFILE, SECURITY_OPTION_PROFILE, SecurityRuntime, load_security_settings
from pacific_rim_communication_infra.ros2.communication_config import with_public_interface_refs


@dataclass(frozen=True)
class CommunicationConfig:
  middleware: Mapping[str, MiddlewareConfig]
  pubsub_routes: Sequence[PubSubRoute]
  rpc_routes: Sequence[RpcRoute]
  trace_service_name: str = "local_service"
  security: Any = None

  def create_fabric(self) -> CommunicationFabric:
    return CommunicationFabric.from_configs(
      self.middleware,
      pubsub_routes=self.pubsub_routes,
      rpc_routes=self.rpc_routes,
      security=SecurityRuntime(self.security) if self.security is not None else None,
    )


def load_communication_config_file(path: str | Path) -> CommunicationConfig:
  config_path = Path(path)
  try:
    import yaml
  except ImportError as exc:
    try:
      raw = json.loads(config_path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError:
      raise RuntimeError("PyYAML is required to load YAML communication config files") from exc
    if isinstance(raw, Mapping) and "communication" in raw:
      raw = dict(raw)
      raw["communication"] = with_public_interface_refs(
        dict(raw.get("communication") or {}),
        config_path=config_path,
        service_name=_idl_service_name(raw),
      )
    return load_communication_config(raw)

  with config_path.open("r", encoding="utf-8") as handle:
    raw = yaml.safe_load(handle) or {}
  if isinstance(raw, Mapping) and "communication" in raw:
    raw = dict(raw)
    raw["communication"] = with_public_interface_refs(
      dict(raw.get("communication") or {}),
      config_path=config_path,
      service_name=_idl_service_name(raw),
    )
  return load_communication_config(raw)


def load_communication_config(raw: Mapping[str, Any]) -> CommunicationConfig:
  if "communication" in raw or "ros" in raw:
    middleware, pubsub_routes, rpc_routes = load_service_communication_config(raw)
    return CommunicationConfig(
      middleware=middleware,
      pubsub_routes=pubsub_routes,
      rpc_routes=rpc_routes,
      trace_service_name=_trace_service_name(raw),
      security=load_security_settings(raw),
    )

  middleware = _middleware_map(raw.get("middleware") or raw.get("middlewares") or {})
  pubsub_routes = [_pubsub_route(item, index) for index, item in enumerate(raw.get("pubsub_routes", []))]
  raw_rpc_routes = list(raw.get("rpc_routes", [])) + _standard_service_routes(raw.get("service_routes", []))
  rpc_routes = [_rpc_route(item, index) for index, item in enumerate(raw_rpc_routes)]
  return CommunicationConfig(
    middleware=middleware,
    pubsub_routes=pubsub_routes,
    rpc_routes=rpc_routes,
    trace_service_name=_trace_service_name(raw),
    security=load_security_settings(raw),
  )


def _trace_service_name(raw: Mapping[str, Any]) -> str:
  trace = raw.get("trace") or {}
  service = raw.get("service") or {}
  return str(
    raw.get("service_name")
    or (trace.get("service_name") if isinstance(trace, Mapping) else "")
    or (service.get("name") if isinstance(service, Mapping) else "")
    or "local_service"
  )


def _idl_service_name(raw: Mapping[str, Any]) -> str:
  service = raw.get("service") or {}
  trace = raw.get("trace") or {}
  return str(
    (service.get("name") if isinstance(service, Mapping) else "")
    or raw.get("service_name")
    or (trace.get("service_name") if isinstance(trace, Mapping) else "")
    or ""
  )


def _standard_service_routes(raw: Any) -> list[Mapping[str, Any]]:
  return list(raw) if isinstance(raw, list) else []


def _middleware_map(raw: Mapping[str, Any]) -> dict[str, MiddlewareConfig]:
  configs: dict[str, MiddlewareConfig] = {}
  for name, value in raw.items():
    if isinstance(value, str):
      configs[str(name)] = MiddlewareConfig(transport=_transport(value), name=str(name))
      continue

    item = dict(value or {})
    transport = item.pop("transport", item.pop("kind", name))
    options = dict(item.pop("options", {}) or {})
    qos = dict(item.pop("qos", {}) or {})
    options.update({f"qos.{key}": value for key, value in qos.items()})
    if item.get("security_profile"):
      options[SECURITY_OPTION_PROFILE] = item["security_profile"]
    options.update(item)
    configs[str(name)] = MiddlewareConfig(
      transport=_transport(transport),
      name=str(name),
      options=options,
    )
  return configs


def _pubsub_route(raw: Mapping[str, Any], index: int) -> PubSubRoute:
  name = str(raw.get("name") or f"pubsub_route_{index}").strip()
  queue_size = int(raw.get("queue_size", 10))
  publisher = _endpoint(raw.get("publisher", {}) or {})
  subscriber = _endpoint(raw.get("subscriber", {}) or {})
  for endpoint in (publisher, subscriber):
    endpoint.metadata.setdefault("qos.depth", queue_size)
  return PubSubRoute(
    name=name,
    publisher=publisher,
    subscriber=subscriber,
    queue_size=queue_size,
    enabled=bool(raw.get("enabled", True)),
  )


def _rpc_route(raw: Mapping[str, Any], index: int) -> RpcRoute:
  name = str(raw.get("name") or f"rpc_route_{index}").strip()
  return RpcRoute(
    name=name,
    client=_endpoint(raw.get("client", {}) or {}),
    server=_endpoint(raw.get("server", {}) or {}),
    timeout_ms=int(raw.get("timeout_ms", 2000)),
    enabled=bool(raw.get("enabled", True)),
  )


def _endpoint(raw: Mapping[str, Any]) -> Endpoint:
  metadata = dict(raw.get("metadata", {}) or {})
  qos = dict(raw.get("qos", {}) or {})
  metadata.update({f"qos.{key}": value for key, value in qos.items()})
  if "queue_size" in raw and "qos.depth" not in metadata:
    metadata["qos.depth"] = raw["queue_size"]
  if raw.get("security_profile"):
    metadata[SECURITY_METADATA_PROFILE] = raw["security_profile"]
  return Endpoint(
    transport=_transport(raw.get("transport", "")),
    address=str(raw.get("address", "")).strip(),
    message_type=str(raw.get("message_type", "")).strip(),
    metadata=metadata,
  )


def _transport(value: Any) -> TransportKind:
  if isinstance(value, TransportKind):
    return value
  normalized = str(value).strip().lower().replace("-", "_")
  aliases = {
    "dds": TransportKind.CYCLONE_DDS,
    "cyclone_dds": TransportKind.CYCLONE_DDS,
    "cyclonedds": TransportKind.CYCLONE_DDS,
  }
  return aliases.get(normalized, TransportKind(normalized))
