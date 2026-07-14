#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"

namespace pacific_rim::communication::core {

inline constexpr const char* kSecurityOptionProfile = "security.profile";
inline constexpr const char* kSecurityMetadataProfile = "security.profile";

enum class SecurityAlgorithm {
  kAes256Gcm = 1,
  kAes128Gcm = 2,
};

struct SecurityKey {
  std::string key_id;
  Bytes master_key;
  Bytes salt;
  bool decrypt_only{false};
};

struct SecurityProfile {
  std::string name;
  SecurityAlgorithm algorithm{SecurityAlgorithm::kAes256Gcm};
  std::string aad_context;
  std::uint64_t replay_window{4096};
  std::string encrypt_key_id;
  bool fail_open{false};
  std::map<std::string, SecurityKey> keys;
};

struct SecurityBinding {
  const SecurityProfile* profile{nullptr};
  std::string route;
  std::string binding;
  std::string transport;
  std::string address;
  std::string message_type;
};

class SecurityRuntime {
 public:
  explicit SecurityRuntime(bool require_explicit_profile = false)
      : require_explicit_profile_(require_explicit_profile) {}

  SecurityRuntime(
      bool require_explicit_profile,
      std::map<std::string, SecurityProfile> profiles)
      : require_explicit_profile_(require_explicit_profile),
        profiles_(std::move(profiles)) {}

  bool require_explicit_profile() const { return require_explicit_profile_; }

  SecurityBinding ResolveBinding(
      const std::string& bus_name,
      const BusConfig& bus_config,
      const Endpoint& endpoint) const {
    auto profile_name = EndpointProfile(endpoint);
    const auto explicit_profile = !profile_name.empty();
    if (profile_name.empty()) {
      profile_name = BusProfile(bus_config);
    }
    profile_name = NormalizeProfile(profile_name);
    if (profile_name.empty() || profile_name == "none") {
      if (require_explicit_profile_ && bus_config.transport == TransportKind::kNats) {
        throw std::runtime_error("security_profile is required for NATS endpoint: " + endpoint.address);
      }
      return {};
    }
    if (!explicit_profile && require_explicit_profile_ && bus_config.transport == TransportKind::kNats) {
      throw std::runtime_error("security_profile must be explicit for NATS endpoint: " + endpoint.address);
    }
    const auto profile_iter = profiles_.find(profile_name);
    if (profile_iter == profiles_.end()) {
      throw std::runtime_error("security profile is not configured or is disabled: " + profile_name);
    }
    SecurityBinding binding;
    binding.profile = &profile_iter->second;
    binding.route = MetadataValue(endpoint, "logical_route");
    if (binding.route.empty()) {
      binding.route = MetadataValue(endpoint, "source_name");
    }
    if (binding.route.empty()) {
      binding.route = endpoint.address;
    }
    binding.binding = MetadataValue(endpoint, "binding_name");
    if (binding.binding.empty()) {
      binding.binding = bus_name;
    }
    binding.transport = TransportName(bus_config.transport);
    binding.address = endpoint.address;
    binding.message_type = endpoint.message_type;
    return binding;
  }

 private:
  static std::string MetadataValue(const Endpoint& endpoint, const std::string& key) {
    const auto iter = endpoint.metadata.find(key);
    return iter == endpoint.metadata.end() ? "" : iter->second;
  }

  static std::string EndpointProfile(const Endpoint& endpoint) {
    auto value = MetadataValue(endpoint, kSecurityMetadataProfile);
    if (!value.empty()) {
      return value;
    }
    return MetadataValue(endpoint, "security_profile");
  }

  static std::string BusProfile(const BusConfig& bus_config) {
    auto iter = bus_config.options.find(kSecurityOptionProfile);
    if (iter != bus_config.options.end()) {
      return iter->second;
    }
    iter = bus_config.options.find("security_profile");
    return iter == bus_config.options.end() ? "" : iter->second;
  }

  static std::string NormalizeProfile(std::string value) {
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char ch) {
      return !std::isspace(ch);
    }));
    value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char ch) {
      return !std::isspace(ch);
    }).base(), value.end());
    auto lower = value;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    if (lower.empty() || lower == "inherit") {
      return "";
    }
    if (lower == "none" || lower == "disabled" || lower == "disable" ||
        lower == "off" || lower == "plaintext" || lower == "plain") {
      return "none";
    }
    return value;
  }

  static std::string TransportName(TransportKind kind) {
    switch (kind) {
      case TransportKind::kNats:
        return "nats";
      case TransportKind::kCycloneDds:
        return "cyclonedds";
      case TransportKind::kFastDds:
        return "fastdds";
      case TransportKind::kRos2:
        return "ros2";
      case TransportKind::kZenoh:
        return "zenoh";
      case TransportKind::kGrpc:
        return "grpc";
      case TransportKind::kMqtt:
        return "mqtt";
      default:
        return "in_process";
    }
  }

  bool require_explicit_profile_{false};
  std::map<std::string, SecurityProfile> profiles_;
};

inline SecurityAlgorithm SecurityAlgorithmFromString(std::string value) {
  std::replace(value.begin(), value.end(), '_', '-');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (value.empty() || value == "aes-256-gcm") {
    return SecurityAlgorithm::kAes256Gcm;
  }
  if (value == "aes-128-gcm") {
    return SecurityAlgorithm::kAes128Gcm;
  }
  throw std::invalid_argument("unsupported security algorithm: " + value);
}

inline Bytes DecodeSecuritySecret(std::string value) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char ch) {
    return std::isspace(ch);
  }), value.end());
  if (value.empty()) {
    return {};
  }
  std::map<char, int> decode;
  for (int index = 0; index < 64; ++index) {
    decode[kAlphabet[index]] = index;
  }
  Bytes out;
  int accumulator = 0;
  int bits = -8;
  bool base64 = true;
  for (char ch : value) {
    if (ch == '=') {
      break;
    }
    const auto iter = decode.find(ch);
    if (iter == decode.end()) {
      base64 = false;
      break;
    }
    accumulator = (accumulator << 6) | iter->second;
    bits += 6;
    if (bits >= 0) {
      out.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xFF));
      bits -= 8;
    }
  }
  if (base64 && !out.empty()) {
    return out;
  }
  return Bytes(value.begin(), value.end());
}

inline Bytes SecuritySecretFromEnv(const std::string& env_name) {
  if (env_name.empty()) {
    throw std::invalid_argument("key_env is required");
  }
  const char* value = std::getenv(env_name.c_str());
  if (value == nullptr || std::string(value).empty()) {
    throw std::runtime_error("environment variable is empty: " + env_name);
  }
  return DecodeSecuritySecret(value);
}

}  // namespace pacific_rim::communication::core
