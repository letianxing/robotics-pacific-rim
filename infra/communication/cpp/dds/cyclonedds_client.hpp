#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "pacific_rim/communication/contracts.hpp"

namespace pacific_rim::communication::dds {

struct CycloneDdsConfig {
  int domain_id{0};
  std::string participant_name{"pacific-rim"};
  std::string config_uri;
};

struct DdsTopicConfig {
  std::string topic_name;
  std::string type_name{"PacificRimMessageEnvelope"};
  std::map<std::string, std::string> qos;
};

struct DdsSubscription {
  DdsTopicConfig topic;
};

struct DdsRpcBinding {
  std::string standard{"omg_dds_rpc"};
  DdsTopicConfig request_channel;
  DdsTopicConfig response_channel;
};

class CycloneDdsRpcAdapter {
 public:
  virtual ~CycloneDdsRpcAdapter() = default;

  virtual bool Request(
      const DdsRpcBinding& binding,
      const std::vector<std::uint8_t>& payload,
      std::chrono::milliseconds timeout,
      std::vector<std::uint8_t>* response) = 0;
  virtual bool HandleRequest(
      const DdsRpcBinding& binding,
      pacific_rim::communication::core::RequestHandler handler) = 0;
};

class CycloneDdsClient {
 public:
  using MessageHandler =
      std::function<void(const pacific_rim::communication::CommunicationMessage&)>;

  virtual ~CycloneDdsClient() = default;

  virtual bool Connect(const CycloneDdsConfig& config) = 0;
  virtual void Close() = 0;
  virtual bool Publish(
      const DdsTopicConfig& topic,
      const pacific_rim::communication::CommunicationMessage& message) = 0;
  virtual bool Subscribe(
      const DdsSubscription& subscription,
      MessageHandler handler) = 0;
};

}  // namespace pacific_rim::communication::dds
