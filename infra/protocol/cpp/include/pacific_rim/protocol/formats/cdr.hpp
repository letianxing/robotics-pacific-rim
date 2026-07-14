#pragma once

#include <string>

#include "pacific_rim/protocol/encodings/cdr.hpp"
#include "pacific_rim/protocol/formats/base.hpp"

namespace pacific_rim::protocol {

// Compatibility wrapper for older callers.
//
// CDR is a wire encoding, not an IDL/data-format contract. Prefer CdrEncoding
// and describe the source schema with Ros2MsgFormat, Ros2SrvFormat,
// Ros2IdlFormat, or Ros2TypeSupportFormat.
inline DataFormat CdrFormat(std::string type_name = "") {
  DataFormat format;
  format.kind = DataFormatKind::kRawBytes;
  format.type_name = std::move(type_name);
  format.content_type = CdrEncoding(format.type_name).ResolvedContentType();
  format.metadata["encoding"] = "cdr";
  return format;
}

}  // namespace pacific_rim::protocol
