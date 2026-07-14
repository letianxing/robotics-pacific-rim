#pragma once

#include <string>

#include "pacific_rim/protocol/encodings/base.hpp"

namespace pacific_rim::protocol {

inline WireEncoding CdrEncoding(std::string type_name = "") {
  WireEncoding encoding;
  encoding.kind = WireEncodingKind::kCdr;
  encoding.type_name = std::move(type_name);
  return encoding;
}

}  // namespace pacific_rim::protocol
