#pragma once

#include <map>
#include <string>

namespace pacific_rim::protocol {

enum class DataFormatKind {
  kRawBytes,
  kJson,
  kProtobuf,
  kRos2Msg,
  kRos2Srv,
  kRos2Idl,
  kRos2TypeSupport,
};

inline std::string ContentTypeForFormat(DataFormatKind kind) {
  switch (kind) {
    case DataFormatKind::kRawBytes:
      return "application/octet-stream";
    case DataFormatKind::kJson:
      return "application/json";
    case DataFormatKind::kProtobuf:
      return "application/protobuf";
    case DataFormatKind::kRos2Msg:
      return "application/vnd.ros2.msg";
    case DataFormatKind::kRos2Srv:
      return "application/vnd.ros2.srv";
    case DataFormatKind::kRos2Idl:
      return "application/vnd.ros2.idl";
    case DataFormatKind::kRos2TypeSupport:
      return "application/vnd.ros2.type-support";
  }
  return "application/octet-stream";
}

struct DataFormat {
  DataFormatKind kind{DataFormatKind::kRawBytes};
  std::string type_name;
  std::string package;
  std::string schema_path;
  std::string content_type;
  std::map<std::string, std::string> metadata;

  std::string ResolvedContentType() const {
    if (!content_type.empty()) {
      return content_type;
    }
    return ContentTypeForFormat(kind);
  }
};

}  // namespace pacific_rim::protocol
