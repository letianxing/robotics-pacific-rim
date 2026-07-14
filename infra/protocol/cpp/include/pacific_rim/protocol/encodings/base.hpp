#pragma once

#include <map>
#include <string>

namespace pacific_rim::protocol {

enum class WireEncodingKind {
  kCdr,
};

inline std::string ContentTypeForEncoding(WireEncodingKind kind) {
  switch (kind) {
    case WireEncodingKind::kCdr:
      return "application/vnd.omg.cdr";
  }
  return "application/octet-stream";
}

struct WireEncoding {
  WireEncodingKind kind{WireEncodingKind::kCdr};
  std::string type_name;
  std::string package;
  std::string schema_path;
  std::string content_type;
  std::map<std::string, std::string> metadata;

  std::string ResolvedContentType() const {
    if (!content_type.empty()) {
      return content_type;
    }
    return ContentTypeForEncoding(kind);
  }
};

}  // namespace pacific_rim::protocol
