import { renderCppScaffoldFiles } from "./render-cpp.mjs";
import { renderGoScaffoldFiles } from "./render-go.mjs";
import { renderPythonScaffoldFiles } from "./render-python.mjs";
import { pascalToSnake, toCamelCase, toPascalCase } from "./naming.mjs";

export function renderScaffoldFiles(manifest) {
  const idlService = manifestIdlService(manifest);
  const files = {
    "interface_scaffold_README.md": renderReadme(manifest),
    [`pkg/idl/${idlService}/protocol_manifest.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
  };
  Object.assign(files, renderSharedProtocolFiles(manifest));
  Object.assign(files, renderDdsTypedCodegenFiles(manifest));

  if (manifest.language === "go") {
    Object.assign(files, renderGoScaffoldFiles(manifest));
  } else if (manifest.language === "python") {
    Object.assign(files, renderPythonScaffoldFiles(manifest));
  } else {
    Object.assign(files, renderCppScaffoldFiles(manifest));
  }

  return normalizeScaffoldFiles(files);
}

function renderDdsTypedCodegenFiles(manifest) {
  const targetsByService = new Map();
  for (const iface of manifest.interfaces ?? []) {
    if (!isGeneratedModuleRoute(iface)) {
      continue;
    }
    for (const target of iface.ddsTyped?.codegen ?? []) {
      const service = ddsCodegenService(target, manifest);
      const targets = targetsByService.get(service) ?? [];
      if (!targets.some((item) => ddsCodegenTargetKey(item) === ddsCodegenTargetKey(target))) {
        targets.push(target);
      }
      targetsByService.set(service, targets);
    }
  }
  const files = {};
  for (const [service, targets] of targetsByService) {
    const base = `pkg/idl/${service}/generated/dds`;
    const plan = {
      service,
      mode: "typed_native_dds",
      fallback: "byte_envelope",
      targets,
    };
    files[`${base}/dds_typed_codegen_plan.json`] = `${JSON.stringify(plan, null, 2)}\n`;
    files[`${base}/generate-dds-typed-bindings.sh`] = renderDdsTypedCodegenScript(service, targets);
    files[`${base}/README.md`] = renderDdsTypedCodegenReadme(service, targets);
  }
  return files;
}

function manifestIdlService(manifest) {
  return String(manifest.idlService || manifest.module || "module_service").trim() || "module_service";
}

function ddsCodegenTargetKey(target) {
  return [
    target.middleware ?? "",
    target.language ?? "",
    target.generator ?? "",
    target.input ?? "",
    target.outputDir ?? "",
  ].join("|");
}

function ddsCodegenService(target, manifest) {
  const match = String(target.outputDir || "").match(/^pkg\/idl\/([^/]+)\//);
  return match?.[1] || target.idlService || manifest.idlService || manifest.module;
}

function renderDdsTypedCodegenScript(service, targets) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"',
    `PLAN="\${ROOT_DIR}/pkg/idl/${service}/generated/dds/dds_typed_codegen_plan.json"`,
    'if [ ! -f "${PLAN}" ]; then',
    '  echo "missing DDS typed codegen plan: ${PLAN}" >&2',
    "  exit 1",
    "fi",
    "",
  ];
  for (const target of targets) {
    const input = shellQuote(target.input || "");
    const output = shellQuote(target.outputDir || "");
    if (target.generator === "fastddsgen") {
      lines.push(
        "if command -v fastddsgen >/dev/null 2>&1; then",
        `  mkdir -p "\${ROOT_DIR}/${target.outputDir}"`,
        `  fastddsgen -replace -d "\${ROOT_DIR}/${target.outputDir}" "\${ROOT_DIR}/${target.input}"`,
        "else",
        `  echo "fastddsgen not found; cannot generate FastDDS typed bindings for ${input}" >&2`,
        "fi",
        "",
      );
    } else if (target.generator === "idlc" && target.language === "python") {
      lines.push(
        "if command -v idlc >/dev/null 2>&1; then",
        `  mkdir -p "\${ROOT_DIR}/${target.outputDir}"`,
        `  idlc -l py -o "\${ROOT_DIR}/${target.outputDir}" "\${ROOT_DIR}/${target.input}"`,
        "else",
        `  echo "idlc not found; cannot generate CycloneDDS Python typed bindings for ${input}" >&2`,
        "fi",
        "",
      );
    } else if (target.generator === "idlc") {
      lines.push(
        "if command -v idlc >/dev/null 2>&1; then",
        `  mkdir -p "\${ROOT_DIR}/${target.outputDir}"`,
        `  idlc -l c++ -o "\${ROOT_DIR}/${target.outputDir}" "\${ROOT_DIR}/${target.input}"`,
        "else",
        `  echo "idlc not found; cannot generate CycloneDDS C++ typed bindings for ${input}" >&2`,
        "fi",
        "",
      );
    } else {
      lines.push(`# Unknown typed DDS generator target: ${output}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderDdsTypedCodegenReadme(service, targets) {
  const rows = targets.map((target) => (
    `| ${target.middleware} | ${target.language} | ${target.generator} | ${target.input} | ${target.outputDir} | ${(target.types ?? []).join(", ")} |`
  )).join("\n");
  return `# DDS Typed Codegen

This generated directory describes the typed native DDS path for \`${service}\`.

The runtime metadata prefers typed DDS for \`data: dds_idl\` / \`data: omg_idl\`
and falls back to the existing byte envelope when generated typed support is not
registered in the current language or middleware runtime.

| middleware | language | generator | input | output | types |
| --- | --- | --- | --- | --- | --- |
${rows || "|  |  |  |  |  |  |"}

Run:

\`\`\`bash
bash pkg/idl/${service}/generated/dds/generate-dds-typed-bindings.sh
\`\`\`

`;
}

function shellQuote(value) {
  return String(value).replace(/'/g, "'\\''");
}

function normalizeScaffoldFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [
    path,
    typeof content === "string" ? `${content.trimEnd()}\n` : content,
  ]));
}

function renderSharedProtocolFiles(manifest) {
  const files = {};
  const services = generatedIdlServiceRoutes(manifest);
  for (const [service, routes] of services) {
    if (manifest.language === "go") {
      Object.assign(files, renderGoSharedProtocolFiles(service, routes));
    } else if (manifest.language === "python") {
      Object.assign(files, renderPythonSharedProtocolFiles(service, routes));
    } else {
      Object.assign(files, renderCppSharedProtocolFiles(service, routes));
    }
  }
  return files;
}

function renderGoSharedProtocolFiles(service, routes) {
  const base = `pkg/idl/${service}/generated/go`;
  const serverRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "server");
  const clientRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "client");
  const publisherRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "publisher");
  const subscriberRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "subscriber");
  const providerRoutes = routes.filter(isProviderInjectionRoute);
  const providerFields = providerRoutes.map((iface) => `\t${providerField(iface)} ${goProviderType(iface)}`).join("\n");
  const defaultFields = providerRoutes.map((iface) => `\t\t${providerField(iface)}: ${goDefaultProviderValue(iface)},`).join("\n");
  const overrideLines = providerRoutes.map((iface) => {
    const field = providerField(iface);
    return `\tif overrides.${field} != nil {
\t\tbase.${field} = overrides.${field}
\t}`;
  }).join("\n");
  const serviceWrappers = serverRoutes.map(renderGoSharedRouteWrapper).join("\n");
  const publisherWrappers = publisherRoutes.map(renderGoSharedRouteWrapper).join("\n");
  const clientWrappers = clientRoutes.map(renderGoClientWrapper).join("\n");
  const subscriberWrappers = subscriberRoutes.map(renderGoSubscriberWrapper).join("\n");
  const registerLines = routes.flatMap(renderGoRegisterRouteLines).join("\n");
  return {
    [`${base}/service.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared service-side byte-level contracts for ${service}.

package generated

import (
\t"context"
)

// ByteServiceHandler handles one request/reply exchange encoded by the selected protocol codec.
type ByteServiceHandler interface {
\tHandle(context.Context, []byte) ([]byte, error)
}

// ByteService executes provider-side service business logic.
type ByteService interface {
\tExecute(context.Context, []byte) ([]byte, error)
}

// NoopByteService keeps request/reply routes alive before business logic is injected.
type NoopByteService struct{}

func (NoopByteService) Execute(ctx context.Context, payload []byte) ([]byte, error) {
\t_ = ctx
\t_ = payload
\treturn nil, nil
}

${serviceWrappers}
`,
    [`${base}/ports.go`]: renderGoPorts(service, routes),
    [`${base}/publisher.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared publisher-side byte-level contracts for ${service}.

package generated

import (
\t"context"

\tcommcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

// BytePublisher publishes one encoded topic payload through a configured endpoint.
type BytePublisher interface {
\tPublish(context.Context, commcore.BoundEndpoint, []byte) error
}

// BytePublisherService executes provider-side topic publish orchestration.
type BytePublisherService interface {
\tExecute(context.Context, commcore.BoundEndpoint, []byte) error
}

// DefaultBytePublisherService publishes the already encoded payload to the selected endpoint.
type DefaultBytePublisherService struct{}

func (DefaultBytePublisherService) Execute(ctx context.Context, endpoint commcore.BoundEndpoint, payload []byte) error {
\treturn endpoint.Bus.Publish(ctx, endpoint.Channel, payload)
}

${publisherWrappers}
`,
    [`${base}/client.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared client-side byte-level contracts for ${service}.

package generated

import (
\t"context"
\t"time"

\tcommcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

// ByteServiceClient calls one configured request/reply endpoint with an encoded payload.
type ByteServiceClient interface {
\tRequest(context.Context, commcore.BoundEndpoint, []byte, time.Duration) ([]byte, error)
}

// DefaultByteServiceClient requests through the already bound endpoint.
type DefaultByteServiceClient struct{}

func (DefaultByteServiceClient) Request(ctx context.Context, endpoint commcore.BoundEndpoint, payload []byte, timeout time.Duration) ([]byte, error) {
\treturn endpoint.Bus.Request(ctx, endpoint.Channel, payload, timeout)
}

${clientWrappers}
`,
    [`${base}/subscriber.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared subscriber-side byte-level contracts for ${service}.

package generated

import "context"

// ByteReceiver handles one encoded topic payload received from a configured endpoint.
type ByteReceiver interface {
\tReceive(context.Context, []byte) error
}

${subscriberWrappers}
`,
    [`${base}/provider.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Provider slots for ${service}. Business modules inject concrete implementations here.

package generated

// Provider contains concrete business implementations for routes this service exposes.
type Provider struct {
${providerFields || "\t// No provider routes are configured for this service."}
}

func DefaultProvider() Provider {
\treturn Provider{
${defaultFields}
\t}
}

func (base Provider) WithOverrides(overrides Provider) Provider {
${overrideLines || "\t_ = overrides"}
\treturn base
}

func (base Provider) WithDefaults() Provider {
\treturn DefaultProvider().WithOverrides(base)
}

`,
    [`${base}/registry.go`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Middleware route registry for ${service}.

package generated

import (
\t"context"

\tcommcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

// RegisterGeneratedInterfaces binds provider-owned routes to byte-level middleware handlers.
func RegisterGeneratedInterfaces(ctx context.Context, runtime *commcore.CommunicationRuntime, providers ...Provider) error {
\tprovider := DefaultProvider()
\tif len(providers) > 0 {
\t\tprovider = provider.WithOverrides(providers[0])
\t}
${registerLines || "\t_ = ctx\n\t_ = runtime\n\t_ = provider"}
\treturn nil
}
`,
  };
}

function renderPythonSharedProtocolFiles(service, routes) {
  const base = `pkg/idl/${service}/generated/python`;
  const serverRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "server");
  const clientRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "client");
  const publisherRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "publisher");
  const subscriberRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "subscriber");
  const providerRoutes = routes.filter(isProviderInjectionRoute);
  const providerParams = providerRoutes.map((iface) => `    ${pythonProviderAttr(iface)}=None,`).join("\n");
  const providerAssigns = providerRoutes.map((iface) => `    self.${pythonProviderAttr(iface)} = ${pythonProviderAttr(iface)} or ${pythonDefaultProviderValue(iface)}`).join("\n");
  const serviceWrappers = serverRoutes.map(renderPythonSharedRouteWrapper).join("\n");
  const publisherWrappers = publisherRoutes.map(renderPythonSharedRouteWrapper).join("\n");
  const clientWrappers = clientRoutes.map(renderPythonClientWrapper).join("\n");
  const subscriberWrappers = subscriberRoutes.map(renderPythonSubscriberWrapper).join("\n");
  const registerLines = routes.flatMap(renderPythonRegisterRouteLines).join("\n");
  return {
    [`${base}/service.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Shared service-side byte-level contracts for ${service}.

from __future__ import annotations

from typing import Protocol


class ByteServiceHandler(Protocol):
  async def handle(self, payload: bytes) -> bytes:
    ...


class ByteService(Protocol):
  async def execute(self, payload: bytes) -> bytes:
    ...


class NoopByteService:
  async def execute(self, payload: bytes) -> bytes:
    _ = payload
    return b""


${serviceWrappers}
`,
    [`${base}/ports.py`]: renderPythonPorts(service, routes),
    [`${base}/publisher.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Shared publisher-side byte-level contracts for ${service}.

from __future__ import annotations

from typing import Protocol


class BytePublisher(Protocol):
  async def publish(self, endpoint, payload: bytes) -> None:
    ...


class BytePublisherService(Protocol):
  async def execute(self, endpoint, payload: bytes) -> None:
    ...


class DefaultBytePublisherService:
  async def execute(self, endpoint, payload: bytes) -> None:
    await endpoint.bus.publish_bytes(endpoint.channel, payload)


${publisherWrappers}
`,
    [`${base}/client.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Shared client-side byte-level contracts for ${service}.

from __future__ import annotations

from typing import Protocol


class ByteServiceClient(Protocol):
  async def request(self, endpoint, payload: bytes, timeout) -> bytes:
    ...


class DefaultByteServiceClient:
  async def request(self, endpoint, payload: bytes, timeout) -> bytes:
    return await endpoint.bus.request_bytes(endpoint.channel, payload, timeout_sec=timeout)


${clientWrappers}
`,
    [`${base}/subscriber.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Shared subscriber-side byte-level contracts for ${service}.

from __future__ import annotations

from typing import Protocol


class ByteReceiver(Protocol):
  async def receive(self, payload: bytes) -> None:
    ...


${subscriberWrappers}
`,
    [`${base}/provider.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Provider slots for ${service}. Business modules inject concrete implementations here.

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_role(name: str):
  candidate = Path(__file__).resolve().with_name(f"{name}.py")
  spec = importlib.util.spec_from_file_location(f"{__name__}_{name}", candidate)
  module = importlib.util.module_from_spec(spec)
  assert spec and spec.loader
  spec.loader.exec_module(module)
  return module


_service = _load_role("service")
_publisher = _load_role("publisher")
_client = _load_role("client")
_subscriber = _load_role("subscriber")
_ports = _load_role("ports")
NoopByteService = _service.NoopByteService
DefaultBytePublisherService = _publisher.DefaultBytePublisherService


class Provider:
  def __init__(
    self,
${providerParams || "    # No provider routes are configured for this service."}
  ):
${providerAssigns || "    pass"}


def default_provider() -> Provider:
  return Provider()


`,
    [`${base}/registry.py`]: `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Middleware route registry for ${service}.

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_role(name: str):
  candidate = Path(__file__).resolve().with_name(f"{name}.py")
  spec = importlib.util.spec_from_file_location(f"{__name__}_{name}", candidate)
  module = importlib.util.module_from_spec(spec)
  assert spec and spec.loader
  spec.loader.exec_module(module)
  return module


_provider = _load_role("provider")
_service = _load_role("service")
_subscriber = _load_role("subscriber")
Provider = _provider.Provider
default_provider = _provider.default_provider
${serverRoutes.map((iface) => `${toPascalCase(iface.name)}Handler = _service.${toPascalCase(iface.name)}Handler`).join("\n")}
${subscriberRoutes.map((iface) => `${toPascalCase(iface.name)}Subscriber = _subscriber.${toPascalCase(iface.name)}Subscriber`).join("\n")}

async def register_generated_interfaces(runtime, provider: Provider | None = None) -> None:
  provider = provider or default_provider()
${registerLines || "  _ = runtime\n  _ = provider"}
`,
  };
}

function renderCppSharedProtocolFiles(service, routes) {
  const base = `pkg/idl/${service}/generated/cpp`;
  const serverRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "server");
  const clientRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "client");
  const publisherRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "publisher");
  const subscriberRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "subscriber");
  const providerFields = routes
    .filter(isProviderInjectionRoute)
    .map((iface) => `  std::shared_ptr<${cppProviderType(iface)}> ${providerField(iface)};`)
    .join("\n");
  const serviceWrapperClasses = serverRoutes.map(renderCppSharedRouteWrapper).join("\n");
  const publisherWrapperClasses = publisherRoutes.map(renderCppSharedRouteWrapper).join("\n");
  const clientWrapperClasses = clientRoutes.map(renderCppClientWrapper).join("\n");
  const subscriberWrapperClasses = subscriberRoutes.map(renderCppSubscriberWrapper).join("\n");
  const registerLines = routes.flatMap(renderCppRegisterRouteLines).join("\n");
  return {
    [`${base}/ports.hpp`]: renderCppPorts(service, routes),
    [`${base}/service.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared service-side byte-level contracts for ${service}.
#pragma once

#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

#include "pkg/idl/${service}/generated/cpp/ports.hpp"

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

class ByteServiceHandler {
 public:
  virtual ~ByteServiceHandler() = default;
  virtual std::vector<std::uint8_t> HandleBytes(const std::vector<std::uint8_t>& payload) = 0;
};

class ByteService {
 public:
  virtual ~ByteService() = default;
  virtual std::vector<std::uint8_t> ExecuteBytes(const std::vector<std::uint8_t>& payload) = 0;
};

class NoopByteService : public ByteService {
 public:
  std::vector<std::uint8_t> ExecuteBytes(const std::vector<std::uint8_t>& payload) override {
    (void)payload;
    return {};
  }
};

${serviceWrapperClasses}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
    [`${base}/publisher.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared publisher-side byte-level contracts for ${service}.
#pragma once

#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/bootstrap.hpp"
#include "pkg/idl/${service}/generated/cpp/ports.hpp"

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

class BytePublisher {
 public:
  virtual ~BytePublisher() = default;
  virtual void Publish(
      pacific_rim::communication::core::CommunicationRuntime& runtime,
      const std::vector<std::uint8_t>& payload) = 0;
};

class BytePublisherService {
 public:
  virtual ~BytePublisherService() = default;
  virtual void Execute(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload) = 0;
};

class DefaultBytePublisherService : public BytePublisherService {
 public:
  void Execute(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload) override {
    if (endpoint.bus != nullptr) {
      endpoint.bus->Publish(endpoint.channel, payload);
    }
  }
};

${publisherWrapperClasses}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
    [`${base}/client.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared client-side byte-level contracts for ${service}.
#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "infra/communication/cpp/core/bootstrap.hpp"

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

class ByteServiceClient {
 public:
  virtual ~ByteServiceClient() = default;
  virtual std::vector<std::uint8_t> RequestBytes(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload,
      std::chrono::milliseconds timeout) = 0;
};

class DefaultByteServiceClient final : public ByteServiceClient {
 public:
  std::vector<std::uint8_t> RequestBytes(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload,
      std::chrono::milliseconds timeout) override {
    std::vector<std::uint8_t> response;
    if (endpoint.bus != nullptr) {
      endpoint.bus->Request(endpoint.channel, payload, timeout, &response);
    }
    return response;
  }
};

${clientWrapperClasses}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
    [`${base}/subscriber.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Shared subscriber-side byte-level contracts for ${service}.
#pragma once

#include <cstdint>
#include <vector>

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

class ByteReceiver {
 public:
  virtual ~ByteReceiver() = default;
  virtual void ReceiveBytes(const std::vector<std::uint8_t>& payload) = 0;
};

${subscriberWrapperClasses}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
    [`${base}/provider.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Provider slots for ${service}. Business modules inject concrete implementations here.
#pragma once

#include <memory>

#include "pkg/idl/${service}/generated/cpp/client.hpp"
#include "pkg/idl/${service}/generated/cpp/ports.hpp"
#include "pkg/idl/${service}/generated/cpp/subscriber.hpp"

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

struct Provider {
${providerFields || "  // No provider routes are configured for this service."}

  void WithDefaults() {
${renderCppProviderDefaultLines(routes)}
  }
};

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
    [`${base}/registry.hpp`]: `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Middleware route registry for ${service}.
#pragma once

#include <cstdint>
#include <vector>

#include "infra/communication/cpp/core/bootstrap.hpp"
#include "pkg/idl/${service}/generated/cpp/provider.hpp"

namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated {

inline void RegisterGeneratedRpcRoutes(
    pacific_rim::communication::core::CommunicationRuntime& runtime,
    Provider provider = Provider{}) {
  provider.WithDefaults();
${registerLines || "  (void)runtime;\n  (void)provider;"}
}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated
`,
  };
}

function generatedIdlServiceRoutes(manifest) {
  const services = new Map();
  for (const iface of manifest.interfaces ?? []) {
    if (!isGeneratedModuleRoute(iface)) {
      continue;
    }
    const service = String(manifest.idlService || manifest.module || "module_service").trim() || "module_service";
    const routes = services.get(service) ?? [];
    routes.push(iface);
    services.set(service, routes);
  }
  return Array.from(services.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function isGeneratedModuleRoute(iface) {
  return isProviderRoute(iface) || isConsumerRoute(iface);
}

function isProviderOwnedRoute(manifest, iface) {
  const idlService = String(iface.idlService || manifest.idlService || "").trim();
  const ownerService = String(manifest.idlService || manifest.module || "").trim();
  if (idlService && ownerService && idlService !== ownerService) {
    return false;
  }
  return (iface.kind === "service" && iface.role === "server") || (iface.kind === "topic" && iface.role === "publisher");
}

function cppIdlNamespace(service) {
  return toPascalCase(service).replace(/[^A-Za-z0-9]/g, "");
}

function primaryRos2Protocol(iface) {
  return iface.protocols?.find((protocol) => protocol.format === "ros2_srv" || protocol.format === "ros2_msg");
}

function cppType(routeType) {
  const [packageName, kind, name] = String(routeType || "").split("/");
  return `::${packageName}::${kind}::${name}`;
}

function ros2Header(routeType) {
  const [packageName, kind, name] = String(routeType || "").split("/");
  return `${packageName}/${kind}/${pascalToSnake(name)}.hpp`;
}

function isProviderRoute(iface) {
  return (iface.kind === "service" && iface.role === "server") || (iface.kind === "topic" && iface.role === "publisher");
}

function isConsumerRoute(iface) {
  return (iface.kind === "service" && iface.role === "client") || (iface.kind === "topic" && iface.role === "subscriber");
}

function isProviderInjectionRoute(iface) {
  return isProviderRoute(iface) || (iface.kind === "topic" && iface.role === "subscriber");
}

function providerField(iface) {
  let suffix = "Service";
  if (iface.kind === "topic") {
    suffix = iface.role === "subscriber" ? "Subscriber" : "Publisher";
  } else if (iface.role === "client") {
    suffix = "Client";
  }
  return `${toPascalCase(iface.name)}${suffix}`;
}

function goProviderType(iface) {
  if (iface.kind === "topic") {
    return iface.role === "subscriber" ? `${toPascalCase(iface.name)}Receiver` : `${toPascalCase(iface.name)}PublisherService`;
  }
  return `${toPascalCase(iface.name)}Service`;
}

function goDefaultProviderValue(iface) {
  if (iface.kind === "topic") {
    return iface.role === "subscriber" ? `Noop${toPascalCase(iface.name)}Receiver{}` : `Default${toPascalCase(iface.name)}PublisherService{}`;
  }
  return `Noop${toPascalCase(iface.name)}Service{}`;
}

function renderGoPorts(service, routes) {
  const serverRoutes = routes.filter((iface) => iface.kind === "service" && iface.role === "server");
  const publisherRoutes = routes.filter((iface) => iface.kind === "topic" && iface.role === "publisher");
  const imports = [
    (serverRoutes.length > 0 || publisherRoutes.length > 0) ? `\t"context"` : "",
    publisherRoutes.length > 0 ? `\tcommcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"` : "",
  ].filter(Boolean);
  const importBlock = imports.length > 0 ? `
import (
${imports.join("\n")}
)
` : "";
  const servicePorts = serverRoutes
    .map((iface) => {
      const typeName = `${toPascalCase(iface.name)}Service`;
      return `// ${typeName} is the route-specific provider port for ${iface.name}.
type ${typeName} interface {
\tByteService
}

// Noop${typeName} keeps ${iface.name} registered before business logic is injected.
type Noop${typeName} struct{}

func (Noop${typeName}) Execute(ctx context.Context, payload []byte) ([]byte, error) {
\t_ = ctx
\t_ = payload
\treturn nil, nil
}`;
    })
    .join("\n\n");
  const topicPorts = publisherRoutes
    .map((iface) => {
      const typeName = `${toPascalCase(iface.name)}PublisherService`;
      return `// ${typeName} is the route-specific provider port for ${iface.name}.
type ${typeName} interface {
\tBytePublisherService
}

// Default${typeName} publishes an already encoded payload for ${iface.name}.
type Default${typeName} struct{}

func (Default${typeName}) Execute(ctx context.Context, endpoint commcore.BoundEndpoint, payload []byte) error {
\treturn endpoint.Bus.Publish(ctx, endpoint.Channel, payload)
}`;
    })
    .join("\n\n");
  return `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Route-specific provider ports for ${service}.

package generated
${importBlock}

${[servicePorts, topicPorts].filter(Boolean).join("\n\n") || "// This service currently has no provider-owned route ports."}
`;
}

function renderGoSharedRouteWrapper(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    const typeName = `${toPascalCase(iface.name)}Publisher`;
    const fieldName = toCamelCase(iface.name);
    const providerType = goProviderType(iface);
    const defaultProvider = goDefaultProviderValue(iface);
    return `var _ BytePublisher = (*${typeName})(nil)

type ${typeName} struct {
\t${fieldName} ${providerType}
}

func New${typeName}(${fieldName} ${providerType}) *${typeName} {
\tif ${fieldName} == nil {
\t\t${fieldName} = ${defaultProvider}
\t}
\treturn &${typeName}{${fieldName}: ${fieldName}}
}

func (p *${typeName}) Publish(ctx context.Context, endpoint commcore.BoundEndpoint, payload []byte) error {
\treturn p.${fieldName}.Execute(ctx, endpoint, payload)
}
`;
  }
  const typeName = `${toPascalCase(iface.name)}Handler`;
  const fieldName = toCamelCase(iface.name);
  const providerType = goProviderType(iface);
  const defaultProvider = goDefaultProviderValue(iface);
  return `var _ ByteServiceHandler = (*${typeName})(nil)

type ${typeName} struct {
\t${fieldName} ${providerType}
}

func New${typeName}(${fieldName} ${providerType}) *${typeName} {
\tif ${fieldName} == nil {
\t\t${fieldName} = ${defaultProvider}
\t}
\treturn &${typeName}{${fieldName}: ${fieldName}}
}

func (h *${typeName}) Handle(ctx context.Context, payload []byte) ([]byte, error) {
\treturn h.${fieldName}.Execute(ctx, payload)
}
`;
}

function renderGoClientWrapper(iface) {
  const typeName = `${toPascalCase(iface.name)}Client`;
  const fieldName = toCamelCase(iface.name);
  const routeNames = expandedRouteNames(iface);
  const defaultRoute = routeNames[0] ?? iface.name;
  return `type ${typeName} struct {
\tclient ByteServiceClient
}

func New${typeName}(client ByteServiceClient) *${typeName} {
\tif client == nil {
\t\tclient = DefaultByteServiceClient{}
\t}
\treturn &${typeName}{client: client}
}

func (c *${typeName}) Request(ctx context.Context, runtime *commcore.CommunicationRuntime, payload []byte, timeout time.Duration, routeName string) ([]byte, error) {
\tif routeName == "" {
\t\trouteName = "${defaultRoute}"
\t}
\tendpoint, err := runtime.Fabric.RPCClient(routeName)
\tif err != nil {
\t\treturn nil, err
\t}
\treturn c.client.Request(ctx, endpoint, payload, timeout)
}

func (c *${typeName}) RequestDefault(ctx context.Context, runtime *commcore.CommunicationRuntime, payload []byte, timeout time.Duration) ([]byte, error) {
\treturn c.Request(ctx, runtime, payload, timeout, "")
}
`;
}

function renderGoSubscriberWrapper(iface) {
  const typeName = `${toPascalCase(iface.name)}Subscriber`;
  const receiverType = `${toPascalCase(iface.name)}Receiver`;
  const noopType = `Noop${receiverType}`;
  const fieldName = toCamelCase(iface.name);
  return `type ${receiverType} interface {
\tByteReceiver
}

type ${noopType} struct{}

func (${noopType}) Receive(ctx context.Context, payload []byte) error {
\t_ = ctx
\t_ = payload
\treturn nil
}

type ${typeName} struct {
\t${fieldName} ${receiverType}
}

func New${typeName}(${fieldName} ${receiverType}) *${typeName} {
\tif ${fieldName} == nil {
\t\t${fieldName} = ${noopType}{}
\t}
\treturn &${typeName}{${fieldName}: ${fieldName}}
}

func (s *${typeName}) Receive(ctx context.Context, payload []byte) error {
\treturn s.${fieldName}.Receive(ctx, payload)
}
`;
}

function renderGoRegisterRouteLines(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    return expandedRouteNames(iface).map(
      (routeName) => `\t// Publisher route "${routeName}" is available through runtime.Fabric.Publisher("${routeName}").`,
    );
  }
  if (iface.kind === "topic" && iface.role === "subscriber") {
    const subscriberName = `${toCamelCase(iface.name)}Subscriber`;
    const fieldName = providerField(iface);
    const routeNames = expandedRouteNames(iface);
    return [
      `\t${subscriberName} := New${toPascalCase(iface.name)}Subscriber(provider.${fieldName})`,
      ...routeNames.flatMap((routeName, index) => {
        const endpointName = routeNames.length === 1 ? `${toCamelCase(iface.name)}Endpoint` : `${toCamelCase(iface.name)}Endpoint${index + 1}`;
        return [
          `\t${endpointName}, err := runtime.Fabric.Subscriber("${routeName}")`,
          `\tif err != nil {`,
          `\t\treturn err`,
          `\t}`,
          `\tif ${endpointName}.Bus != nil {`,
          `\t\tif err := ${endpointName}.Bus.Subscribe(ctx, ${endpointName}.Channel, ${subscriberName}.Receive); err != nil {`,
          `\t\t\treturn err`,
          `\t\t}`,
          `\t}`,
        ];
      }),
    ];
  }
  if (iface.kind === "service" && iface.role === "client") {
    return expandedRouteNames(iface).map(
      (routeName) => `\t// Client route "${routeName}" is available through New${toPascalCase(iface.name)}Client(nil).Request(...).`,
    );
  }
  const handlerName = `${toPascalCase(iface.name)}Handler`;
  const fieldName = providerField(iface);
  const routeNames = expandedRouteNames(iface);
  return [
    `\t${toCamelCase(iface.name)}Handler := New${handlerName}(provider.${fieldName})`,
    ...routeNames.flatMap((routeName, index) => {
      const endpointName = routeNames.length === 1 ? `${toCamelCase(iface.name)}Endpoint` : `${toCamelCase(iface.name)}Endpoint${index + 1}`;
      return [
        `\t${endpointName}, err := runtime.Fabric.RPCServer("${routeName}")`,
        `\tif err != nil {`,
        `\t\treturn err`,
        `\t}`,
        `\tif ${endpointName}.Bus != nil {`,
        `\t\tif err := ${endpointName}.Bus.HandleRequest(ctx, ${endpointName}.Channel, ${toCamelCase(iface.name)}Handler.Handle); err != nil {`,
        `\t\t\treturn err`,
        `\t\t}`,
        `\t}`,
      ];
    }),
  ];
}

function pythonProviderAttr(iface) {
  const name = pythonRouteKey(iface);
  if (iface.kind === "topic") {
    return iface.role === "subscriber" ? `${name}_subscriber` : `${name}_publisher`;
  }
  return iface.role === "client" ? `${name}_client` : `${name}_service`;
}

function pythonRouteKey(iface) {
  return pascalToSnake(iface.name) || "route";
}

function pythonDefaultProviderValue(iface) {
  if (iface.kind === "topic") {
    if (iface.role === "subscriber") {
      return `_subscriber.Noop${toPascalCase(iface.name)}Receiver()`;
    }
    return `_ports.Default${toPascalCase(iface.name)}PublisherService()`;
  }
  return `_ports.Noop${toPascalCase(iface.name)}Service()`;
}

function renderPythonPorts(service, routes) {
  const servicePorts = routes
    .filter((iface) => iface.kind === "service" && iface.role === "server")
    .map((iface) => {
      const className = `${toPascalCase(iface.name)}Service`;
      return `class ${className}(Protocol):
  async def execute(self, payload: bytes) -> bytes:
    ...


class Noop${className}:
  async def execute(self, payload: bytes) -> bytes:
    _ = payload
    return b""`;
    })
    .join("\n\n\n");
  const topicPorts = routes
    .filter((iface) => iface.kind === "topic" && iface.role === "publisher")
    .map((iface) => {
      const className = `${toPascalCase(iface.name)}PublisherService`;
      return `class ${className}(Protocol):
  async def execute(self, endpoint, payload: bytes) -> None:
    ...


class Default${className}:
  async def execute(self, endpoint, payload: bytes) -> None:
    await endpoint.bus.publish_bytes(endpoint.channel, payload)`;
    })
    .join("\n\n\n");
  return `# Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
# Route-specific provider ports for ${service}.

from __future__ import annotations

from typing import Protocol


${[servicePorts, topicPorts].filter(Boolean).join("\n\n\n")}
`;
}

function renderPythonSharedRouteWrapper(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    const className = `${toPascalCase(iface.name)}Publisher`;
    return `class ${className}:
  def __init__(self, service=None):
    self.service = service or DefaultBytePublisherService()

  async def publish(self, endpoint, payload: bytes) -> None:
    await self.service.execute(endpoint, payload)
`;
  }
  const className = `${toPascalCase(iface.name)}Handler`;
  return `class ${className}:
  def __init__(self, service=None):
    self.service = service or NoopByteService()

  async def handle(self, payload: bytes) -> bytes:
    return await self.service.execute(payload)
`;
}

function renderPythonClientWrapper(iface) {
  const className = `${toPascalCase(iface.name)}Client`;
  const defaultRoute = expandedRouteNames(iface)[0] ?? iface.name;
  return `class ${className}:
  default_route = "${defaultRoute}"

  def __init__(self, client=None):
    self.client = client or DefaultByteServiceClient()

  async def request(self, runtime, payload: bytes, timeout_sec: float = 2.0, route_name: str | None = None) -> bytes:
    endpoint = runtime.rpc_client(route_name or self.default_route)
    return await self.client.request(endpoint, payload, timeout_sec)
`;
}

function renderPythonSubscriberWrapper(iface) {
  const className = `${toPascalCase(iface.name)}Subscriber`;
  const receiverName = `${toPascalCase(iface.name)}Receiver`;
  const noopName = `Noop${receiverName}`;
  return `class ${receiverName}(Protocol):
  async def receive(self, payload: bytes) -> None:
    ...


class ${noopName}:
  async def receive(self, payload: bytes) -> None:
    _ = payload


class ${className}:
  def __init__(self, receiver=None):
    self.receiver = receiver or ${noopName}()

  async def receive(self, payload: bytes) -> None:
    await self.receiver.receive(payload)
`;
}

function renderPythonRegisterRouteLines(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    return expandedRouteNames(iface).map(
      (routeName) => `  # Publisher route "${routeName}" is available through runtime.publisher("${routeName}").`,
    );
  }
  if (iface.kind === "topic" && iface.role === "subscriber") {
    const routeKey = pythonRouteKey(iface);
    const subscriberName = `${routeKey}_subscriber`;
    const routeNames = expandedRouteNames(iface);
    return [
      `  ${subscriberName} = ${toPascalCase(iface.name)}Subscriber(provider.${pythonProviderAttr(iface)})`,
      ...routeNames.flatMap((routeName, index) => {
        const endpointName = routeNames.length === 1 ? `${routeKey}_endpoint` : `${routeKey}_endpoint_${index + 1}`;
        return [
          `  ${endpointName} = runtime.subscriber("${routeName}")`,
          `  await ${endpointName}.bus.subscribe_bytes(${endpointName}.channel, ${subscriberName}.receive)`,
        ];
      }),
    ];
  }
  if (iface.kind === "service" && iface.role === "client") {
    return expandedRouteNames(iface).map(
      (routeName) => `  # Client route "${routeName}" is available through ${toPascalCase(iface.name)}Client().request(...).`,
    );
  }
  const handlerName = `${toPascalCase(iface.name)}Handler`;
  const attrName = pythonProviderAttr(iface);
  const routeNames = expandedRouteNames(iface);
  const routeKey = pythonRouteKey(iface);
  const handlerVar = `${routeKey}_handler`;
  return [
    `  ${handlerVar} = ${handlerName}(provider.${attrName})`,
    ...routeNames.flatMap((routeName, index) => {
      const endpointName = routeNames.length === 1 ? `${routeKey}_endpoint` : `${routeKey}_endpoint_${index + 1}`;
      return [
        `  ${endpointName} = runtime.rpc_server("${routeName}")`,
        `  await ${endpointName}.bus.handle_request_bytes(${endpointName}.channel, ${handlerVar}.handle)`,
      ];
    }),
  ];
}

function cppProviderType(iface) {
  if (iface.kind === "topic") {
    return iface.role === "subscriber" ? `${toPascalCase(iface.name)}Receiver` : `ports::${toPascalCase(iface.name)}PublisherService`;
  }
  return `ports::${toPascalCase(iface.name)}Service`;
}

function renderCppProviderDefaultLines(routes) {
  return routes.filter(isProviderInjectionRoute).map((iface) => {
    const field = providerField(iface);
    let type = `ports::Noop${toPascalCase(iface.name)}Service`;
    if (iface.kind === "topic") {
      type = iface.role === "subscriber" ? `Noop${toPascalCase(iface.name)}Receiver` : `ports::Default${toPascalCase(iface.name)}PublisherService`;
    }
    return `    if (!${field}) {
      ${field} = std::make_shared<${type}>();
    }`;
  }).join("\n");
}

function renderCppPorts(service, routes) {
  const ros2Includes = Array.from(new Set(routes
    .filter((iface) => iface.kind === "service" && iface.role === "server")
    .map(primaryRos2Protocol)
    .filter(Boolean)
    .map((protocol) => `#include "${ros2Header(protocol.type)}"`))).sort();
  const servicePorts = routes
    .filter((iface) => iface.kind === "service" && iface.role === "server")
    .map(renderCppServicePort)
    .join("\n\n");
  const topicPorts = routes
    .filter((iface) => iface.kind === "topic" && iface.role === "publisher")
    .map(renderCppPublisherPort)
    .join("\n\n");
  return `// Code generated by bin/generate-interface-scaffold.mjs; DO NOT EDIT.
// Route-specific provider ports for ${service}.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "infra/communication/cpp/core/bootstrap.hpp"
${ros2Includes.length > 0 ? `${ros2Includes.join("\n")}\n` : ""}
namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated::ports {

${[servicePorts, topicPorts].filter(Boolean).join("\n\n")}

}  // namespace pacific_rim::idl::${cppIdlNamespace(service)}::generated::ports
`;
}

function renderCppServicePort(iface) {
  const className = `${toPascalCase(iface.name)}Service`;
  const ros2 = primaryRos2Protocol(iface);
  const typedMethod = ros2
    ? `
  virtual Result Execute(const ${cppType(ros2.type)}::Request& request) = 0;`
    : "";
  const noopTypedMethod = ros2
    ? `
  Result Execute(const ${cppType(ros2.type)}::Request& request) override {
    (void)request;
    return {};
  }`
    : "";
  return `class ${className} {
 public:
  struct Result {
    bool success{false};
    std::string message;
  };

  virtual ~${className}() = default;
  virtual std::vector<std::uint8_t> ExecuteBytes(const std::vector<std::uint8_t>& payload) = 0;${typedMethod}
};

class Noop${className} final : public ${className} {
 public:
  std::vector<std::uint8_t> ExecuteBytes(const std::vector<std::uint8_t>& payload) override {
    (void)payload;
    return {};
  }${noopTypedMethod}
};`;
}

function renderCppPublisherPort(iface) {
  const className = `${toPascalCase(iface.name)}PublisherService`;
  return `class ${className} {
 public:
  virtual ~${className}() = default;
  virtual void Execute(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload) = 0;
};

class Default${className} final : public ${className} {
 public:
  void Execute(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload) override {
    if (endpoint.bus != nullptr) {
      endpoint.bus->Publish(endpoint.channel, payload);
    }
  }
};`;
}

function renderCppSharedRouteWrapper(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    const className = `${toPascalCase(iface.name)}Publisher`;
    const fieldName = toCamelCase(iface.name);
    const providerType = cppProviderType(iface);
    const defaultProvider = iface.kind === "topic" ? `ports::Default${toPascalCase(iface.name)}PublisherService` : `ports::Noop${toPascalCase(iface.name)}Service`;
    return `class ${className} final : public BytePublisher {
 public:
  explicit ${className}(std::shared_ptr<${providerType}> ${fieldName} = nullptr)
      : ${fieldName}_(std::move(${fieldName})) {
    if (!${fieldName}_) {
      ${fieldName}_ = std::make_shared<${defaultProvider}>();
    }
  }

  void Publish(
      pacific_rim::communication::core::CommunicationRuntime& runtime,
      const std::vector<std::uint8_t>& payload) override {
${expandedRouteNames(iface).map((routeName) => `    ${fieldName}_->Execute(runtime.Publisher("${routeName}"), payload);`).join("\n")}
  }

 private:
  std::shared_ptr<${providerType}> ${fieldName}_;
};
`;
  }
  const className = `${toPascalCase(iface.name)}Handler`;
  const fieldName = toCamelCase(iface.name);
  const providerType = cppProviderType(iface);
  const defaultProvider = `ports::Noop${toPascalCase(iface.name)}Service`;
  return `class ${className} final : public ByteServiceHandler {
 public:
  explicit ${className}(std::shared_ptr<${providerType}> ${fieldName} = nullptr)
      : ${fieldName}_(std::move(${fieldName})) {
    if (!${fieldName}_) {
      ${fieldName}_ = std::make_shared<${defaultProvider}>();
    }
  }

  std::vector<std::uint8_t> HandleBytes(const std::vector<std::uint8_t>& payload) override {
    return ${fieldName}_->ExecuteBytes(payload);
  }

 private:
  std::shared_ptr<${providerType}> ${fieldName}_;
};
`;
}

function renderCppClientWrapper(iface) {
  const className = `${toPascalCase(iface.name)}Client`;
  const defaultRoute = expandedRouteNames(iface)[0] ?? iface.name;
  return `class ${className} : public ByteServiceClient {
 public:
  explicit ${className}(std::shared_ptr<ByteServiceClient> client = nullptr)
      : client_(std::move(client)) {
    if (!client_) {
      client_ = std::make_shared<DefaultByteServiceClient>();
    }
  }

  std::vector<std::uint8_t> RequestBytes(
      pacific_rim::communication::core::BoundEndpoint endpoint,
      const std::vector<std::uint8_t>& payload,
      std::chrono::milliseconds timeout) override {
    return client_->RequestBytes(endpoint, payload, timeout);
  }

  std::vector<std::uint8_t> RequestBytes(
      pacific_rim::communication::core::CommunicationRuntime& runtime,
      const std::vector<std::uint8_t>& payload,
      std::chrono::milliseconds timeout,
      const std::string& route_name = "") {
    return RequestBytes(
        runtime.RpcClient(route_name.empty() ? DefaultRoute() : route_name),
        payload,
        timeout);
  }

  static const std::string& DefaultRoute() {
    static const std::string route = "${defaultRoute}";
    return route;
  }

 private:
  std::shared_ptr<ByteServiceClient> client_;
};
`;
}

function renderCppSubscriberWrapper(iface) {
  const receiverName = `${toPascalCase(iface.name)}Receiver`;
  const noopName = `Noop${receiverName}`;
  const className = `${toPascalCase(iface.name)}Subscriber`;
  const fieldName = toCamelCase(iface.name);
  return `class ${receiverName} : public ByteReceiver {
 public:
  ~${receiverName}() override = default;
};

class ${noopName} final : public ${receiverName} {
 public:
  void ReceiveBytes(const std::vector<std::uint8_t>& payload) override {
    (void)payload;
  }
};

class ${className} final : public ByteReceiver {
 public:
  explicit ${className}(std::shared_ptr<${receiverName}> ${fieldName} = nullptr)
      : ${fieldName}_(std::move(${fieldName})) {
    if (!${fieldName}_) {
      ${fieldName}_ = std::make_shared<${noopName}>();
    }
  }

  void ReceiveBytes(const std::vector<std::uint8_t>& payload) override {
    ${fieldName}_->ReceiveBytes(payload);
  }

 private:
  std::shared_ptr<${receiverName}> ${fieldName}_;
};
`;
}

function renderCppRegisterRouteLines(iface) {
  if (iface.kind === "topic" && iface.role === "publisher") {
    return [];
  }
  if (iface.kind === "topic" && iface.role === "subscriber") {
    const routeNames = expandedRouteNames(iface);
    const subscriberClass = `${toPascalCase(iface.name)}Subscriber`;
    const field = providerField(iface);
    return routeNames.map((routeName) => `  if (runtime.fabric) {
    auto endpoint = runtime.Subscriber("${routeName}");
    if (endpoint.bus != nullptr) {
      auto receiver = std::make_shared<${subscriberClass}>(provider.${field});
      endpoint.bus->Subscribe(
          endpoint.channel,
          [receiver](const std::vector<std::uint8_t>& payload) {
            receiver->ReceiveBytes(payload);
          });
    }
  }`);
  }
  if (iface.kind === "service" && iface.role === "client") {
    return [];
  }
  const routeNames = expandedRouteNames(iface);
  const handlerClass = `${toPascalCase(iface.name)}Handler`;
  const field = providerField(iface);
  return routeNames.map((routeName) => `  if (runtime.fabric) {
    auto endpoint = runtime.RpcServer("${routeName}");
    if (endpoint.bus != nullptr) {
      endpoint.bus->HandleRequest(endpoint.channel, [provider](const std::vector<std::uint8_t>& payload) mutable {
        ${handlerClass} handler(provider.${field});
        return handler.HandleBytes(payload);
      });
    }
  }`);
}

function expandedRouteNames(iface) {
  if (Array.isArray(iface.routeNames) && iface.routeNames.length > 0) {
    return iface.routeNames;
  }
  if (!Array.isArray(iface.bindings) || iface.bindings.length === 0) {
    return [iface.name];
  }
  return iface.bindings.map((binding, index) => `${iface.name}_${canonicalRouteName(bindingName(binding, index))}`);
}

function bindingName(binding, index) {
  const values = [
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
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return values.length > 0 ? values.join("_") : `binding_${index}`;
}

function canonicalRouteName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function renderReadme(manifest) {
  const registryNote = manifest.includeRuntimeRegistry
    ? "- C++ runtime registry files are module-local route/callback bindings, not infra client registration."
    : "- Runtime registry files were not generated; keep existing runtime registration or add it manually.";

  return `# ${manifest.module} Interface Scaffold

Generated from:

- Config: ${manifest.config}
- Protocol sources:
${manifest.protocolSources.map((source) => `  - ${source}`).join("\n")}
- Language: ${manifest.language}

Server/publisher and consumer routes refresh role-based shared protocol files
under the current service scope:
pkg/idl/<service>/generated/<language>. Provider routes add route-specific
business ports, byte-level wrappers, provider slots, and middleware registrars.
Subscriber/client routes add current-service protocol receivers or clients for
the upstream public contract; they do not generate files under the upstream
provider's pkg/idl tree. Module-local output is limited to thin registration or
typed callback shims plus user-editable service/publisher/subscriber/client
implementations. Use --force only when intentionally resetting module-local
business implementation skeletons after IDL/config changes.

Layer direction:

external caller -> communication config -> runtime callback -> api handler -> service -> scheduler/executor -> adapter

Protocol rule:

- Public IDL source files live under pkg/idl.
- Generated protocol role files live under
  pkg/idl/<service>/generated/<language>. They are split by role
  (ports, service, publisher, client, subscriber, provider, registry). Provider
  routes add route-specific ports, wrappers, provider slots, and registrars.
  Consumer routes add current-service client/subscriber protocol adapters for
  the upstream contract. These files must not contain business logic, and each
  service should normally keep only its own implementation language there.
  Subscriber/client routes that consume another service do not generate another
  language copy under the provider's pkg/idl tree.
- Module-local generated files are thin shims plus user-editable
  service/publisher/subscriber/client implementations. The generated
  protocol_manifest.json lives under pkg/idl/<service>, next to the public
  contracts it summarizes. Provider routes implement pkg generated ports in
  module/service; consumer routes use module-local subscriber callbacks or
  downstream client helpers. Generated transport glue should stay stable.
- protobuf messages can model streaming topics.
- protobuf rpc entries should only model request/response services.
- ROS2 .msg maps to topics; ROS2 .srv maps to services.
- Public interface manifests live under pkg/idl/<service>/public/*.yaml.
  Provider routes for this module (topic publishers and service servers) are
  discovered from its public IDL. Local config.yaml is consumer-only and should
  contain only topic_ref/service_ref routes with subscribe/client direction.
- The scaffold writes user-editable implementation templates for routes this
  module provides to others (service servers and topic publishers) and for
  routes it consumes (topic subscriber callbacks and downstream service client
  helpers). Subscriber/client routes stay in local config, generate only
  current-service pkg/idl protocol adapters, and do not auto-call downstream
  RPCs.
- Generated language artifacts such as AimRT-style ROS2 type-support .cc files
  are scanned as metadata, not as protocol sources.
${registryNote}
`;
}
