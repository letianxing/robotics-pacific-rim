#pragma once

#include <string>

#include "pacific_rim/protocol/formats/base.hpp"

namespace pacific_rim::protocol {

inline DataFormat ProtobufFormat(std::string type_name) {
  DataFormat format;
  format.kind = DataFormatKind::kProtobuf;
  format.type_name = std::move(type_name);
  return format;
}

}  // namespace pacific_rim::protocol
