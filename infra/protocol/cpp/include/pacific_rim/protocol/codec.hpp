#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pacific_rim/protocol/formats/base.hpp"
#include "pacific_rim/protocol/formats/protobuf.hpp"

namespace pacific_rim::protocol {

using Bytes = std::vector<std::uint8_t>;

class BytesCodec {
 public:
  virtual ~BytesCodec() = default;
  virtual std::string ContentType() const = 0;
  virtual Bytes Encode(const Bytes& value) const = 0;
  virtual Bytes Decode(const Bytes& data) const = 0;
};

class RawBytesCodec final : public BytesCodec {
 public:
  std::string ContentType() const override { return "application/octet-stream"; }
  Bytes Encode(const Bytes& value) const override { return value; }
  Bytes Decode(const Bytes& data) const override { return data; }
};

template <typename MessageT>
class ProtobufCodec final {
 public:
  std::string ContentType() const { return "application/protobuf"; }

  Bytes Encode(const MessageT& value) const {
    std::string serialized;
    if (!value.SerializeToString(&serialized)) {
      throw std::runtime_error("failed to serialize protobuf message");
    }
    return Bytes(serialized.begin(), serialized.end());
  }

  MessageT Decode(const Bytes& data) const {
    MessageT value;
    const std::string serialized(data.begin(), data.end());
    if (!value.ParseFromString(serialized)) {
      throw std::runtime_error("failed to parse protobuf message");
    }
    return value;
  }
};

}  // namespace pacific_rim::protocol
