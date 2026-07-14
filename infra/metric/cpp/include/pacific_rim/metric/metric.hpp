#pragma once

#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "pacific_rim/otel/otlp_http.hpp"

namespace pacific_rim::metric {

inline constexpr const char *module_health = "pacific_rim.module.health";
inline constexpr const char *module_restarts = "pacific_rim.module.restarts";
inline constexpr const char *message_latency = "pacific_rim.message.latency";
inline constexpr const char *message_count = "pacific_rim.message.count";

inline std::string attributes_json(const std::map<std::string, std::string> &attributes) {
  if (attributes.empty()) {
    return "";
  }
  std::ostringstream payload;
  payload << R"(,"attributes":[)";
  bool first = true;
  for (const auto &[key, value] : attributes) {
    if (!first) {
      payload << ",";
    }
    first = false;
    payload << R"({"key":")" << pacific_rim::otel::json_escape(key)
            << R"(","value":{"stringValue":")"
            << pacific_rim::otel::json_escape(value)
            << R"("}})";
  }
  payload << "]";
  return payload.str();
}

class Counter {
public:
  explicit Counter(std::string name) : name_(std::move(name)) {}

  void add(double value = 1.0) {
    std::lock_guard<std::mutex> lock(mutex_);
    value_ += value;
    export_value();
  }

  double value() const { return value_; }
  const std::string &name() const { return name_; }

private:
  std::string name_;
  double value_{0};
  mutable std::mutex mutex_;

  void export_value() const {
    std::ostringstream payload;
    payload << R"({"resourceMetrics":[{)"
            << pacific_rim::otel::resource_json()
            << R"(,"scopeMetrics":[{"scope":{"name":")"
            << pacific_rim::otel::json_escape(pacific_rim::otel::service_name())
            << R"("},"metrics":[{)"
            << R"("name":")" << pacific_rim::otel::json_escape(name_)
            << R"(","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"asDouble":)"
            << value_
            << R"(,"timeUnixNano":")" << pacific_rim::otel::unix_nano()
            << R"("}]}}]}]}]})";
    pacific_rim::otel::post_async("/v1/metrics", payload.str());
  }
};

class Histogram {
public:
  explicit Histogram(std::string name) : name_(std::move(name)) {}

  void record(
      double value,
      const std::map<std::string, std::string> &attributes = {}) {
    std::lock_guard<std::mutex> lock(mutex_);
    values_.push_back(value);
    export_value(value, attributes);
  }

  const std::string &name() const { return name_; }

private:
  std::string name_;
  std::vector<double> values_;
  mutable std::mutex mutex_;

  void export_value(
      double value,
      const std::map<std::string, std::string> &attributes) const {
    std::ostringstream payload;
    payload << R"({"resourceMetrics":[{)"
            << pacific_rim::otel::resource_json()
            << R"(,"scopeMetrics":[{"scope":{"name":")"
            << pacific_rim::otel::json_escape(pacific_rim::otel::service_name())
            << R"("},"metrics":[{)"
            << R"("name":")" << pacific_rim::otel::json_escape(name_)
            << R"(","unit":"ms","gauge":{"dataPoints":[{"asDouble":)"
            << value
            << R"(,"timeUnixNano":")" << pacific_rim::otel::unix_nano()
            << R"(")" << attributes_json(attributes)
            << R"(}]}}]}]}]})";
    pacific_rim::otel::post_async("/v1/metrics", payload.str());
  }
};

} // namespace pacific_rim::metric
