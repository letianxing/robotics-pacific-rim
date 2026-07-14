#pragma once

#include <functional>
#include <string>

#include "pacific_rim/communication/contracts.hpp"

namespace pacific_rim::communication::nats {

struct NatsConfig {
  std::string server_url{"nats://127.0.0.1:4222"};
  std::string name{"pacific-rim"};
  int connect_timeout_ms{2000};
  int reconnect_wait_ms{2000};
  int max_reconnect_attempts{-1};
};

class NatsClient {
 public:
  using MessageHandler =
      std::function<void(const pacific_rim::communication::CommunicationMessage&)>;

  virtual ~NatsClient() = default;

  virtual bool Connect(const NatsConfig& config) = 0;
  virtual void Close() = 0;
  virtual bool Publish(
      const std::string& subject,
      const pacific_rim::communication::CommunicationMessage& message) = 0;
  virtual bool Subscribe(
      const std::string& subject,
      const std::string& queue_group,
      MessageHandler handler) = 0;
};

}  // namespace pacific_rim::communication::nats
