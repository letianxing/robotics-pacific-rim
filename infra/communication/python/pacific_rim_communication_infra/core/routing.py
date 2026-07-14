from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, PubSubRoute, RpcRoute, TransportKind

from .middleware import Channel, MessageBus, channel_from_endpoint, create_message_bus_from_config
from .security import SecureMessageBus, SecurityRuntime


@dataclass(frozen=True)
class BoundEndpoint:
  bus_name: str
  bus: MessageBus
  channel: Channel


class CommunicationFabric:
  def __init__(
    self,
    buses: Mapping[str, MessageBus],
    bus_configs: Mapping[str, MiddlewareConfig],
    pubsub_routes: Iterable[PubSubRoute] = (),
    rpc_routes: Iterable[RpcRoute] = (),
    security: SecurityRuntime | None = None,
  ):
    self._buses = dict(buses)
    self._bus_configs = dict(bus_configs)
    self._pubsub_routes = {route.name: route for route in pubsub_routes if route.enabled}
    self._rpc_routes = {route.name: route for route in rpc_routes if route.enabled}
    self._security = security

  @classmethod
  def from_configs(
    cls,
    middleware: Mapping[str, MiddlewareConfig],
    pubsub_routes: Iterable[PubSubRoute] = (),
    rpc_routes: Iterable[RpcRoute] = (),
    security: SecurityRuntime | None = None,
  ) -> "CommunicationFabric":
    buses = {name: create_message_bus_from_config(config) for name, config in middleware.items()}
    return cls(buses, middleware, pubsub_routes, rpc_routes, security=security)

  async def connect_all(self) -> None:
    for bus in self._buses.values():
      await bus.connect()

  async def close_all(self) -> None:
    for bus in self._buses.values():
      await bus.close()

  def bus(self, name: str) -> MessageBus:
    return self._buses[name]

  def publisher(self, route_name: str) -> BoundEndpoint:
    route = self._pubsub_routes[route_name]
    return self._bind_endpoint(route.publisher)

  def subscriber(self, route_name: str) -> BoundEndpoint:
    route = self._pubsub_routes[route_name]
    return self._bind_endpoint(route.subscriber)

  def rpc_client(self, route_name: str) -> BoundEndpoint:
    route = self._rpc_routes[route_name]
    bus_name, bus = self._bus_for_endpoint(route.client)
    bus = self._secure_bus_for_endpoint(bus_name, bus, route.server)
    channel = channel_from_endpoint(
      route.server.address,
      message_type=route.server.message_type,
      queue_group=str(route.server.metadata.get("queue_group", "")),
      metadata=route.server.metadata,
    )
    return BoundEndpoint(bus_name=bus_name, bus=bus, channel=channel)

  def rpc_server(self, route_name: str) -> BoundEndpoint:
    route = self._rpc_routes[route_name]
    return self._bind_endpoint(route.server)

  def _bind_endpoint(self, endpoint: Endpoint) -> BoundEndpoint:
    bus_name, bus = self._bus_for_endpoint(endpoint)
    bus = self._secure_bus_for_endpoint(bus_name, bus, endpoint)
    channel = channel_from_endpoint(
      endpoint.address,
      message_type=endpoint.message_type,
      queue_group=str(endpoint.metadata.get("queue_group", "")),
      metadata=endpoint.metadata,
    )
    return BoundEndpoint(bus_name=bus_name, bus=bus, channel=channel)

  def _bus_for_endpoint(self, endpoint: Endpoint) -> tuple[str, MessageBus]:
    explicit_name = endpoint.metadata.get("middleware.runtime") or endpoint.metadata.get("middleware_name") or endpoint.metadata.get("middleware")
    if explicit_name:
      return str(explicit_name), self._buses[str(explicit_name)]

    for name, config in self._bus_configs.items():
      if config.transport == endpoint.transport:
        return name, self._buses[name]

    raise KeyError(f"no middleware configured for transport {endpoint.transport}")

  def _secure_bus_for_endpoint(self, bus_name: str, bus: MessageBus, endpoint: Endpoint) -> MessageBus:
    if self._security is None:
      return bus
    binding = self._security.resolve_binding(bus_name, self._bus_configs[bus_name], endpoint)
    if binding is None:
      return bus
    return SecureMessageBus(bus, binding)


def default_middleware_name(transport: TransportKind) -> str:
  return transport.value
