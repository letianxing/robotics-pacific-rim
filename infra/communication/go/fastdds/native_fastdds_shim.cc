//go:build pacific_rim_fastdds

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/dds/fastdds_native_byte_client.hpp"

namespace prdds = pacific_rim::communication::dds;

extern "C" {

typedef void (*pr_go_fastdds_callback)(void*, uint8_t*, size_t);

struct pr_go_fastdds_client {
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  prdds::NativeFastDdsByteEnvelopeClient client;
#endif
  prdds::CycloneDdsConfig config;
  std::map<std::string, std::string> options;
  std::mutex mutex;
  std::vector<std::function<void()>> subscriptions;
  std::string last_error;
};

static std::map<std::string, std::string> pr_go_fastdds_parse_options(
    const char* encoded) {
  std::map<std::string, std::string> options;
  if (encoded == nullptr || encoded[0] == '\0') {
    return options;
  }
  std::istringstream in(encoded);
  std::string line;
  while (std::getline(in, line)) {
    const auto pos = line.find('=');
    if (pos == std::string::npos || pos == 0) {
      continue;
    }
    options[line.substr(0, pos)] = line.substr(pos + 1);
  }
  return options;
}

static prdds::DdsTopicConfig pr_go_fastdds_topic(
    const char* topic_name,
    const char* type_name,
    const char* qos) {
  prdds::DdsTopicConfig topic;
  topic.topic_name = topic_name == nullptr || topic_name[0] == '\0'
                         ? "default"
                         : topic_name;
  topic.type_name = type_name == nullptr || type_name[0] == '\0'
                        ? "PacificRimMessageEnvelope"
                        : type_name;
  topic.qos = pr_go_fastdds_parse_options(qos);
  return topic;
}

static void pr_go_fastdds_set_error(
    pr_go_fastdds_client* client,
    const std::string& message) {
  if (client != nullptr) {
    client->last_error = message;
  }
}

pr_go_fastdds_client* pr_go_fastdds_create(
    int domain_id,
    const char* participant_name,
    const char* options) {
  auto* client = new pr_go_fastdds_client();
  client->config.domain_id = domain_id;
  client->config.participant_name =
      participant_name == nullptr ? "" : participant_name;
  client->options = pr_go_fastdds_parse_options(options);
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  client->client.ConfigureOptions(client->options);
#else
  client->last_error = "Fast DDS C++ headers/libraries were not available at build time";
#endif
  return client;
}

void pr_go_fastdds_destroy(pr_go_fastdds_client* client) {
  if (client == nullptr) {
    return;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  client->client.Close();
#endif
  delete client;
}

const char* pr_go_fastdds_last_error(pr_go_fastdds_client* client) {
  if (client == nullptr) {
    return "native Fast DDS client is null";
  }
  return client->last_error.c_str();
}

int pr_go_fastdds_connect(pr_go_fastdds_client* client) {
  if (client == nullptr) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  if (!client->client.Connect(client->config)) {
    pr_go_fastdds_set_error(client, "Fast DDS participant/type setup failed");
    return 0;
  }
  client->last_error.clear();
  return 1;
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

int pr_go_fastdds_prepare_publish(
    pr_go_fastdds_client* client,
    const char* topic_name,
    const char* type_name,
    const char* qos) {
  if (client == nullptr) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  if (!client->client.PreparePublish(
          pr_go_fastdds_topic(topic_name, type_name, qos))) {
    pr_go_fastdds_set_error(client, "Fast DDS create writer failed");
    return 0;
  }
  client->last_error.clear();
  return 1;
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

int pr_go_fastdds_publish(
    pr_go_fastdds_client* client,
    const char* topic_name,
    const char* type_name,
    const char* qos,
    const uint8_t* data,
    size_t len) {
  if (client == nullptr || (data == nullptr && len > 0)) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  if (!client->client.PublishRaw(
          pr_go_fastdds_topic(topic_name, type_name, qos),
          data,
          len)) {
    pr_go_fastdds_set_error(client, "Fast DDS write failed");
    return 0;
  }
  client->last_error.clear();
  return 1;
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

int pr_go_fastdds_wait_for_subscribers(
    pr_go_fastdds_client* client,
    const char* topic_name,
    const char* type_name,
    const char* qos,
    int timeout_ms) {
  if (client == nullptr) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  return client->client.WaitForSubscribers(
             pr_go_fastdds_topic(topic_name, type_name, qos),
             std::chrono::milliseconds(timeout_ms < 0 ? 0 : timeout_ms))
      ? 1
      : 0;
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

int pr_go_fastdds_wait_for_publishers(
    pr_go_fastdds_client* client,
    const char* topic_name,
    const char* type_name,
    const char* qos,
    int timeout_ms) {
  if (client == nullptr) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  return client->client.WaitForPublishers(
             pr_go_fastdds_topic(topic_name, type_name, qos),
             std::chrono::milliseconds(timeout_ms < 0 ? 0 : timeout_ms))
      ? 1
      : 0;
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

int pr_go_fastdds_subscribe(
    pr_go_fastdds_client* client,
    const char* topic_name,
    const char* type_name,
    const char* qos,
    pr_go_fastdds_callback callback,
    void* user_data) {
  if (client == nullptr || callback == nullptr) {
    return 0;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  const auto topic = pr_go_fastdds_topic(topic_name, type_name, qos);
  auto unsubscribe = client->client.SubscribeManaged(
      prdds::DdsSubscription{topic},
      [callback, user_data](const prdds::Bytes& payload) {
        callback(user_data, const_cast<uint8_t*>(payload.data()), payload.size());
      });
  if (!unsubscribe) {
    pr_go_fastdds_set_error(client, "Fast DDS create reader failed");
    return 0;
  }
  std::lock_guard<std::mutex> lock(client->mutex);
  client->subscriptions.push_back(std::move(unsubscribe));
  client->last_error.clear();
  return static_cast<int>(client->subscriptions.size());
#else
  pr_go_fastdds_set_error(
      client,
      "Fast DDS C++ headers/libraries were not available at build time");
  return 0;
#endif
}

void pr_go_fastdds_unsubscribe(
    pr_go_fastdds_client* client,
    int subscription_id) {
  if (client == nullptr || subscription_id <= 0) {
    return;
  }
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API
  std::function<void()> unsubscribe;
  {
    std::lock_guard<std::mutex> lock(client->mutex);
    const auto index = static_cast<std::size_t>(subscription_id - 1);
    if (index >= client->subscriptions.size()) {
      return;
    }
    unsubscribe = std::move(client->subscriptions[index]);
    client->subscriptions[index] = {};
  }
  if (unsubscribe) {
    unsubscribe();
  }
#endif
}

}  // extern "C"
