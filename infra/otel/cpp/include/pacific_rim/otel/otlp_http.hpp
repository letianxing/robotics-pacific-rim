#pragma once

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

namespace pacific_rim::otel {

inline std::uint64_t unix_nano() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(now).count());
}

inline std::string endpoint() {
  const char *value = std::getenv("OTEL_EXPORTER_OTLP_ENDPOINT");
  return value == nullptr || std::string(value).empty()
      ? "http://otel-collector:4318"
      : std::string(value);
}

inline std::string &service_name_storage() {
  static std::string value = []() {
    const char *service_name = std::getenv("OTEL_SERVICE_NAME");
    return service_name == nullptr || std::string(service_name).empty()
        ? std::string("pacific-rim")
        : std::string(service_name);
  }();
  return value;
}

inline void set_service_name(const std::string &service_name) {
  if (!service_name.empty()) {
    service_name_storage() = service_name;
  }
}

inline std::string service_name() { return service_name_storage(); }

inline std::string shell_escape(const std::string &value) {
  std::string escaped = "'";
  for (char ch : value) {
    if (ch == '\'') {
      escaped += "'\\''";
    } else {
      escaped += ch;
    }
  }
  escaped += "'";
  return escaped;
}

inline std::string json_escape(const std::string &value) {
  std::ostringstream stream;
  for (char ch : value) {
    switch (ch) {
    case '\\':
      stream << "\\\\";
      break;
    case '"':
      stream << "\\\"";
      break;
    case '\n':
      stream << "\\n";
      break;
    case '\r':
      stream << "\\r";
      break;
    case '\t':
      stream << "\\t";
      break;
    default:
      stream << ch;
      break;
    }
  }
  return stream.str();
}

inline void post_async(const std::string &path, const std::string &payload) {
  std::thread([path, payload]() {
    const char *debug = std::getenv("PACIFIC_RIM_OTEL_DEBUG");
    const std::string output =
        debug == nullptr || std::string(debug).empty()
            ? " >/dev/null 2>&1"
            : "";
    const std::string command =
        "curl -fsS -X POST " + shell_escape(endpoint() + path) +
        " -H 'Content-Type: application/json' --data " + shell_escape(payload) +
        output;
    const int code = std::system(command.c_str());
    if (code != 0 && debug != nullptr && !std::string(debug).empty()) {
      std::cerr << "OTLP export failed for " << path << " with code " << code
                << std::endl;
    }
  }).detach();
}

inline std::string resource_json(const std::string &service_name) {
  return R"("resource":{"attributes":[{"key":"service.name","value":{"stringValue":")" +
         json_escape(service_name) + R"("}}]})";
}

inline std::string resource_json() { return resource_json(service_name()); }

} // namespace pacific_rim::otel
