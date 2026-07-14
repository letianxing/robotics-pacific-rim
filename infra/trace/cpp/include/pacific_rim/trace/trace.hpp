#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <vector>
#include <utility>

#include "pacific_rim/otel/otlp_http.hpp"

namespace pacific_rim::trace {

struct TraceIds {
  std::string trace_id;
  std::string span_id;
};

class Span {
public:
  explicit Span(
      std::string name,
      std::string trace_id = "",
      std::string parent_span_id = "")
      : name_(std::move(name)),
        ids_{trace_id.empty() ? random_hex(32) : std::move(trace_id),
             random_hex(16)},
        parent_span_id_(std::move(parent_span_id)),
        start_time_unix_nano_(pacific_rim::otel::unix_nano()) {}

  const std::string &name() const { return name_; }
  const TraceIds &ids() const { return ids_; }

  void set_attribute(const std::string &key, const std::string &value) {
    attributes_[key] = value;
  }

  void end() const {
    std::ostringstream payload;
    payload << R"({"resourceSpans":[{)"
            << pacific_rim::otel::resource_json()
            << R"(,"scopeSpans":[{"scope":{"name":")"
            << pacific_rim::otel::json_escape(pacific_rim::otel::service_name())
            << R"("},"spans":[{)"
            << R"("traceId":")" << ids_.trace_id
            << R"(","spanId":")" << ids_.span_id
            << R"(","name":")" << pacific_rim::otel::json_escape(name_)
            << R"(","kind":1)";
    if (!parent_span_id_.empty()) {
      payload << R"(,"parentSpanId":")" << parent_span_id_ << R"(")";
    }
    payload << R"(,"startTimeUnixNano":")" << start_time_unix_nano_
            << R"(","endTimeUnixNano":")" << pacific_rim::otel::unix_nano()
            << R"(","attributes":[)";
    bool first = true;
    for (const auto &[key, value] : attributes_) {
      payload << (first ? "" : ",")
              << R"({"key":")" << pacific_rim::otel::json_escape(key)
              << R"(","value":{"stringValue":")"
              << pacific_rim::otel::json_escape(value) << R"("}})";
      first = false;
    }
    payload << R"(]}]}]}]})";
    pacific_rim::otel::post_async("/v1/traces", payload.str());
  }

private:
  static std::string random_hex(std::size_t length) {
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    static constexpr char digits[] = "0123456789abcdef";
    std::string value;
    value.reserve(length);
    for (std::size_t index = 0; index < length; ++index) {
      value.push_back(digits[rng() % 16]);
    }
    return value;
  }

  std::string name_;
  TraceIds ids_;
  std::string parent_span_id_;
  std::map<std::string, std::string> attributes_;
  std::uint64_t start_time_unix_nano_;
};

inline Span start_span(const std::string &name) { return Span{name}; }

inline bool is_trace_hex(const std::string &value, std::size_t length) {
  if (value.size() != length) {
    return false;
  }
  for (char ch : value) {
    const bool digit = ch >= '0' && ch <= '9';
    const bool lower_hex = ch >= 'a' && ch <= 'f';
    if (!digit && !lower_hex) {
      return false;
    }
  }
  return true;
}

inline std::optional<TraceIds> parse_traceparent(const std::string &value) {
  if (value.size() < 55 || value[2] != '-' || value[35] != '-' ||
      value[52] != '-') {
    return std::nullopt;
  }
  const auto trace_id = value.substr(3, 32);
  const auto span_id = value.substr(36, 16);
  if (!is_trace_hex(trace_id, 32) || !is_trace_hex(span_id, 16)) {
    return std::nullopt;
  }
  if (trace_id == std::string(32, '0') || span_id == std::string(16, '0')) {
    return std::nullopt;
  }
  return TraceIds{trace_id, span_id};
}

inline Span start_child_span(const std::string &name, const TraceIds &parent) {
  return Span{name, parent.trace_id, parent.span_id};
}

inline Span start_child_span(
    const std::string &name,
    const std::string &traceparent_value) {
  const auto parent = parse_traceparent(traceparent_value);
  if (!parent.has_value()) {
    return start_span(name);
  }
  return start_child_span(name, *parent);
}

inline std::string traceparent(const TraceIds &ids) {
  return "00-" + ids.trace_id + "-" + ids.span_id + "-01";
}

inline std::vector<TraceIds> &current_trace_stack() {
  static thread_local std::vector<TraceIds> stack;
  return stack;
}

inline std::optional<TraceIds> current_trace_ids() {
  auto &stack = current_trace_stack();
  if (stack.empty()) {
    return std::nullopt;
  }
  return stack.back();
}

inline std::string current_traceparent() {
  const auto current = current_trace_ids();
  return current.has_value() ? traceparent(*current) : "";
}

class ScopedTraceContext {
public:
  explicit ScopedTraceContext(TraceIds ids) : active_(true) {
    current_trace_stack().push_back(std::move(ids));
  }

  explicit ScopedTraceContext(const Span &span)
      : ScopedTraceContext(span.ids()) {}

  ~ScopedTraceContext() {
    if (active_) {
      auto &stack = current_trace_stack();
      if (!stack.empty()) {
        stack.pop_back();
      }
    }
  }

  ScopedTraceContext(const ScopedTraceContext &) = delete;
  ScopedTraceContext &operator=(const ScopedTraceContext &) = delete;

  ScopedTraceContext(ScopedTraceContext &&other) noexcept
      : active_(other.active_) {
    other.active_ = false;
  }

  ScopedTraceContext &operator=(ScopedTraceContext &&) = delete;

private:
  bool active_{false};
};

inline std::string route_span_name(
    const std::string &fallback,
    const std::map<std::string, std::string> &metadata,
    const std::string &kind) {
  auto configured = metadata.find("trace.span_name");
  if (configured != metadata.end() && !configured->second.empty()) {
    return configured->second;
  }
  auto logical = metadata.find("logical_route");
  std::string name =
      logical != metadata.end() && !logical->second.empty() ? logical->second
                                                            : fallback;
  if (!kind.empty() && name.find('.') == std::string::npos) {
    name += "." + kind;
  }
  return name;
}

} // namespace pacific_rim::trace
