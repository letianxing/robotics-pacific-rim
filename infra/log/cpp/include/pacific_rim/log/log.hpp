#pragma once

#include <map>
#include <sstream>
#include <string>

#include "pacific_rim/otel/otlp_http.hpp"
#include "rclcpp/rclcpp.hpp"

namespace pacific_rim::log {

inline std::string format_attributes(const std::map<std::string, std::string> &attributes) {
  std::ostringstream stream;
  bool first = true;
  for (const auto &[key, value] : attributes) {
    stream << (first ? "" : " ") << key << "=" << value;
    first = false;
  }
  return stream.str();
}

inline void export_record(
    const std::string &severity_text,
    int severity_number,
    const std::string &message,
    const std::map<std::string, std::string> &attributes = {}) {
  std::ostringstream payload;
  payload << R"({"resourceLogs":[{)"
          << pacific_rim::otel::resource_json()
          << R"(,"scopeLogs":[{"scope":{"name":")"
          << pacific_rim::otel::json_escape(pacific_rim::otel::service_name())
          << R"("},"logRecords":[{)"
          << R"("timeUnixNano":")" << pacific_rim::otel::unix_nano()
          << R"(","severityText":")" << severity_text
          << R"(","severityNumber":)" << severity_number
          << R"(,"body":{"stringValue":")"
          << pacific_rim::otel::json_escape(message)
          << R"("})";
  if (const auto trace = attributes.find("traceId"); trace != attributes.end()) {
    payload << R"(,"traceId":")" << pacific_rim::otel::json_escape(trace->second) << R"(")";
  }
  if (const auto span = attributes.find("spanId"); span != attributes.end()) {
    payload << R"(,"spanId":")" << pacific_rim::otel::json_escape(span->second) << R"(")";
  }
  payload << R"(,"attributes":[)";
  bool first = true;
  for (const auto &[key, value] : attributes) {
    payload << (first ? "" : ",")
            << R"({"key":")" << pacific_rim::otel::json_escape(key)
            << R"(","value":{"stringValue":")"
            << pacific_rim::otel::json_escape(value) << R"("}})";
    first = false;
  }
  payload << R"(]}]}]}]})";
  pacific_rim::otel::post_async("/v1/logs", payload.str());
}

inline void info(
    const rclcpp::Logger &logger,
    const std::string &message,
    const std::map<std::string, std::string> &attributes = {}) {
  RCLCPP_INFO(logger, "%s %s", message.c_str(), format_attributes(attributes).c_str());
  export_record("INFO", 9, message, attributes);
}

inline void warn(
    const rclcpp::Logger &logger,
    const std::string &message,
    const std::map<std::string, std::string> &attributes = {}) {
  RCLCPP_WARN(logger, "%s %s", message.c_str(), format_attributes(attributes).c_str());
  export_record("WARN", 13, message, attributes);
}

inline void error(
    const rclcpp::Logger &logger,
    const std::string &message,
    const std::map<std::string, std::string> &attributes = {}) {
  RCLCPP_ERROR(logger, "%s %s", message.c_str(), format_attributes(attributes).c_str());
  export_record("ERROR", 17, message, attributes);
}

} // namespace pacific_rim::log
