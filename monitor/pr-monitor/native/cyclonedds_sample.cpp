#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>

#include "infra/communication/cpp/dds/native_byte_client.hpp"

namespace {

using pacific_rim::communication::dds::CycloneDdsConfig;
using pacific_rim::communication::dds::DdsSubscription;
using pacific_rim::communication::dds::DdsTopicConfig;
using pacific_rim::communication::dds::NativeCycloneDdsByteEnvelopeClient;
using pacific_rim::communication::core::Bytes;

struct Options {
  std::string topic;
  std::string config_uri;
  int domain_id{42};
  int milliseconds{1000};
};

struct Counters {
  std::atomic<std::uint64_t> count{0};
  std::atomic<std::uint64_t> bytes{0};
  std::atomic<std::uint64_t> latency_count{0};
  std::atomic<std::uint64_t> latency_sum_ms{0};
};

std::string JsonEscape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (ch < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(ch);
        } else {
          out << static_cast<char>(ch);
        }
        break;
    }
  }
  return out.str();
}

std::uint64_t UnixMillisNow() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

std::size_t CdrPayloadOffset(std::size_t offset) {
  return offset <= 4 ? 0 : offset - 4;
}

void Align(std::size_t* offset, std::size_t alignment) {
  if (offset == nullptr || alignment <= 1) {
    return;
  }
  const auto padding = (alignment - (CdrPayloadOffset(*offset) % alignment)) % alignment;
  *offset += padding;
}

bool ReadUint32(const Bytes& data, std::size_t* offset, std::uint32_t* value) {
  if (offset == nullptr || value == nullptr || *offset + 4 > data.size()) {
    return false;
  }
  *value = static_cast<std::uint32_t>(data[*offset]) |
           (static_cast<std::uint32_t>(data[*offset + 1]) << 8) |
           (static_cast<std::uint32_t>(data[*offset + 2]) << 16) |
           (static_cast<std::uint32_t>(data[*offset + 3]) << 24);
  *offset += 4;
  return true;
}

bool SkipCdrString(const Bytes& data, std::size_t* offset) {
  Align(offset, 4);
  std::uint32_t length = 0;
  if (!ReadUint32(data, offset, &length) || length == 0 || *offset + length > data.size()) {
    return false;
  }
  *offset += length;
  return true;
}

std::optional<std::uint64_t> CdrCreatedAtUnixMs(const Bytes& data) {
  if (data.size() < 4 || data[0] != 0x00 || data[1] != 0x01) {
    return std::nullopt;
  }

  std::size_t offset = 4;
  for (int i = 0; i < 4; ++i) {
    if (!SkipCdrString(data, &offset)) {
      return std::nullopt;
    }
  }
  Align(&offset, 8);
  if (offset + 8 > data.size()) {
    return std::nullopt;
  }

  std::uint64_t value = 0;
  for (int shift = 0; shift < 64; shift += 8) {
    value |= static_cast<std::uint64_t>(data[offset++]) << shift;
  }
  return value > 0 ? std::optional<std::uint64_t>(value) : std::nullopt;
}

std::optional<std::uint64_t> JsonPublishedAtUnixMs(const Bytes& data) {
  if (data.empty() || data.front() != static_cast<std::uint8_t>('{')) {
    return std::nullopt;
  }

  const std::string text(data.begin(), data.end());
  const std::string key = "\"published_at_unix_ms\":";
  const auto position = text.find(key);
  if (position == std::string::npos) {
    return std::nullopt;
  }

  std::size_t cursor = position + key.size();
  while (cursor < text.size() && (text[cursor] == ' ' || text[cursor] == '\t')) {
    ++cursor;
  }
  std::uint64_t value = 0;
  bool saw_digit = false;
  while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
    saw_digit = true;
    value = (value * 10) + static_cast<std::uint64_t>(text[cursor] - '0');
    ++cursor;
  }
  return saw_digit && value > 0 ? std::optional<std::uint64_t>(value) : std::nullopt;
}

std::optional<std::uint64_t> CreatedAtUnixMs(const Bytes& data) {
  if (auto cdr = CdrCreatedAtUnixMs(data)) {
    return cdr;
  }
  return JsonPublishedAtUnixMs(data);
}

void PrintUsage(const char* program) {
  std::cerr << "Usage: " << program
            << " --topic <route> [--domain-id <id>] [--milliseconds <ms>] [--config-uri <uri>]\n";
}

bool ParseInt(const std::string& raw, int* value) {
  if (value == nullptr || raw.empty()) {
    return false;
  }
  char* end = nullptr;
  const long parsed = std::strtol(raw.c_str(), &end, 10);
  if (end == raw.c_str() || *end != '\0') {
    return false;
  }
  *value = static_cast<int>(parsed);
  return true;
}

Options ParseArgs(int argc, char** argv) {
  Options options;
  if (const char* domain = std::getenv("ROS_DOMAIN_ID")) {
    int parsed = 0;
    if (ParseInt(domain, &parsed)) {
      options.domain_id = parsed;
    }
  }
  if (const char* uri = std::getenv("CYCLONEDDS_URI")) {
    options.config_uri = uri;
  }

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const auto value = [&]() -> std::string {
      if (i + 1 >= argc) {
        return "";
      }
      return argv[++i];
    };

    if (arg == "--topic") {
      options.topic = value();
    } else if (arg == "--domain-id") {
      int parsed = 0;
      if (!ParseInt(value(), &parsed)) {
        throw std::runtime_error("--domain-id must be an integer");
      }
      options.domain_id = parsed;
    } else if (arg == "--milliseconds") {
      int parsed = 0;
      if (!ParseInt(value(), &parsed)) {
        throw std::runtime_error("--milliseconds must be an integer");
      }
      options.milliseconds = parsed;
    } else if (arg == "--config-uri") {
      options.config_uri = value();
    } else if (arg == "--help" || arg == "-h") {
      PrintUsage(argv[0]);
      std::exit(0);
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }

  if (options.topic.empty()) {
    throw std::runtime_error("--topic is required");
  }
  if (options.milliseconds < 100) {
    options.milliseconds = 100;
  }
  if (options.milliseconds > 10000) {
    options.milliseconds = 10000;
  }
  return options;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = ParseArgs(argc, argv);

    CycloneDdsConfig config;
    config.domain_id = options.domain_id;
    config.participant_name = "pr-monitor";
    config.config_uri = options.config_uri;

    NativeCycloneDdsByteEnvelopeClient client;
    if (!client.Connect(config)) {
      std::cerr << "failed to create CycloneDDS participant for domain "
                << options.domain_id << "\n";
      return 2;
    }

    DdsTopicConfig topic;
    topic.topic_name = options.topic;
    topic.type_name = "PacificRimMessageEnvelope";

    Counters counters;
    auto unsubscribe = client.SubscribeManaged(DdsSubscription{topic}, [&](const Bytes& payload) {
      counters.count.fetch_add(1, std::memory_order_relaxed);
      counters.bytes.fetch_add(payload.size(), std::memory_order_relaxed);
      if (const auto created_at = CreatedAtUnixMs(payload)) {
        const auto now = UnixMillisNow();
        if (now >= *created_at) {
          counters.latency_count.fetch_add(1, std::memory_order_relaxed);
          counters.latency_sum_ms.fetch_add(now - *created_at, std::memory_order_relaxed);
        }
      }
    });

    if (!unsubscribe) {
      std::cerr << "failed to subscribe native CycloneDDS topic " << options.topic << "\n";
      client.Close();
      return 3;
    }

    const auto started = std::chrono::steady_clock::now();
    std::this_thread::sleep_for(std::chrono::milliseconds(options.milliseconds));
    const auto finished = std::chrono::steady_clock::now();
    unsubscribe();
    client.Close();

    const double elapsed = std::max(
        0.001,
        std::chrono::duration<double>(finished - started).count());
    const auto count = counters.count.load(std::memory_order_relaxed);
    const auto bytes = counters.bytes.load(std::memory_order_relaxed);
    const auto latency_count = counters.latency_count.load(std::memory_order_relaxed);
    const auto latency_sum = counters.latency_sum_ms.load(std::memory_order_relaxed);

    std::cout << std::fixed << std::setprecision(3)
              << "{\"topic\":\"" << JsonEscape(options.topic) << "\""
              << ",\"domain_id\":" << options.domain_id
              << ",\"count\":" << count
              << ",\"bytes\":" << bytes
              << ",\"elapsed_sec\":" << elapsed
              << ",\"freq\":" << (static_cast<double>(count) / elapsed)
              << ",\"rate\":" << (static_cast<double>(bytes) / elapsed);
    if (latency_count > 0) {
      std::cout << ",\"latency_ms\":"
                << (static_cast<double>(latency_sum) / static_cast<double>(latency_count));
    }
    std::cout << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    PrintUsage(argc > 0 ? argv[0] : "cyclonedds_sample");
    return 1;
  }
}
