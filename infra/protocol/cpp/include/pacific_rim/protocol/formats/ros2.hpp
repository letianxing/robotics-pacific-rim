#pragma once

#include <string>

#include "pacific_rim/protocol/formats/base.hpp"

namespace pacific_rim::protocol {

inline DataFormat Ros2MsgFormat(std::string type_name) {
  DataFormat format;
  format.kind = DataFormatKind::kRos2Msg;
  format.type_name = std::move(type_name);
  return format;
}

inline DataFormat Ros2SrvFormat(std::string type_name) {
  DataFormat format;
  format.kind = DataFormatKind::kRos2Srv;
  format.type_name = std::move(type_name);
  return format;
}

inline DataFormat Ros2IdlFormat(std::string type_name) {
  DataFormat format;
  format.kind = DataFormatKind::kRos2Idl;
  format.type_name = std::move(type_name);
  return format;
}

inline DataFormat Ros2TypeSupportFormat(std::string type_name) {
  DataFormat format;
  format.kind = DataFormatKind::kRos2TypeSupport;
  format.type_name = std::move(type_name);
  return format;
}

}  // namespace pacific_rim::protocol
