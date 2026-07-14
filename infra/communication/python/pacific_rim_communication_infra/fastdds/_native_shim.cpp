#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/dds/fastdds_native_byte_client.hpp"

namespace pr = pacific_rim::communication::dds;

extern "C" {

typedef void (*pr_fastdds_callback)(void*, const std::uint8_t*, std::size_t);

struct pr_fastdds_client {
  pr::CycloneDdsConfig config;
  std::map<std::string, std::string> options;
  pr::NativeFastDdsByteEnvelopeClient client;
  std::mutex mutex;
  std::vector<std::function<void()>> unsubscribers;
  std::string last_error;
};

static std::map<std::string, std::string> pr_fastdds_parse_options(const char* raw) {
  std::map<std::string, std::string> options;
  if (raw == nullptr) {
    return options;
  }
  std::istringstream input(raw);
  std::string line;
  while (std::getline(input, line)) {
    const auto pos = line.find('=');
    if (pos == std::string::npos) {
      continue;
    }
    options[line.substr(0, pos)] = line.substr(pos + 1);
  }
  return options;
}

static pr::DdsTopicConfig pr_fastdds_topic(
    const char* topic_name,
    const char* type_name,
    const char* qos_options) {
  pr::DdsTopicConfig topic;
  topic.topic_name = topic_name == nullptr ? "" : topic_name;
  topic.type_name =
      type_name == nullptr || std::string(type_name).empty()
          ? "PacificRimMessageEnvelope"
          : type_name;
  topic.qos = pr_fastdds_parse_options(qos_options);
  return topic;
}

pr_fastdds_client* pr_fastdds_create(
    int domain_id,
    const char* participant_name,
    const char* options) {
  auto* handle = new pr_fastdds_client();
  handle->config.domain_id = domain_id;
  if (participant_name != nullptr && std::string(participant_name).size() > 0) {
    handle->config.participant_name = participant_name;
  }
  handle->options = pr_fastdds_parse_options(options);
  handle->client.ConfigureOptions(handle->options);
  return handle;
}

int pr_fastdds_connect(pr_fastdds_client* handle) {
  if (handle == nullptr) {
    return 0;
  }
  if (!handle->client.Connect(handle->config)) {
    handle->last_error = "native Fast DDS connect failed";
    return 0;
  }
  return 1;
}

void pr_fastdds_destroy(pr_fastdds_client* handle) {
  if (handle == nullptr) {
    return;
  }
  handle->client.Close();
  delete handle;
}

const char* pr_fastdds_last_error(pr_fastdds_client* handle) {
  if (handle == nullptr) {
    return "native Fast DDS handle is null";
  }
  return handle->last_error.c_str();
}

int pr_fastdds_prepare_publish(
    pr_fastdds_client* handle,
    const char* topic_name,
    const char* type_name,
    const char* qos_options) {
  if (handle == nullptr) {
    return 0;
  }
  auto topic = pr_fastdds_topic(topic_name, type_name, qos_options);
  if (!handle->client.PreparePublish(topic)) {
    handle->last_error = "native Fast DDS prepare_publish failed";
    return 0;
  }
  return 1;
}

int pr_fastdds_publish(
    pr_fastdds_client* handle,
    const char* topic_name,
    const char* type_name,
    const char* qos_options,
    const std::uint8_t* data,
    std::size_t size) {
  if (handle == nullptr) {
    return 0;
  }
  auto topic = pr_fastdds_topic(topic_name, type_name, qos_options);
  if (!handle->client.PublishRaw(topic, data, size)) {
    handle->last_error = "native Fast DDS publish failed";
    return 0;
  }
  return 1;
}

int pr_fastdds_wait_for_subscribers(
    pr_fastdds_client* handle,
    const char* topic_name,
    const char* type_name,
    const char* qos_options,
    int timeout_ms) {
  if (handle == nullptr) {
    return 0;
  }
  auto topic = pr_fastdds_topic(topic_name, type_name, qos_options);
  return handle->client.WaitForSubscribers(
             topic,
             std::chrono::milliseconds(timeout_ms < 0 ? 0 : timeout_ms))
      ? 1
      : 0;
}

int pr_fastdds_wait_for_publishers(
    pr_fastdds_client* handle,
    const char* topic_name,
    const char* type_name,
    const char* qos_options,
    int timeout_ms) {
  if (handle == nullptr) {
    return 0;
  }
  auto topic = pr_fastdds_topic(topic_name, type_name, qos_options);
  return handle->client.WaitForPublishers(
             topic,
             std::chrono::milliseconds(timeout_ms < 0 ? 0 : timeout_ms))
      ? 1
      : 0;
}

int pr_fastdds_subscribe(
    pr_fastdds_client* handle,
    const char* topic_name,
    const char* type_name,
    const char* qos_options,
    pr_fastdds_callback callback,
    void* user_data) {
  if (handle == nullptr || callback == nullptr) {
    return -1;
  }
  auto topic = pr_fastdds_topic(topic_name, type_name, qos_options);
  auto unsubscribe = handle->client.SubscribeManaged(
      pr::DdsSubscription{topic},
      [callback, user_data](const pr::Bytes& payload) {
        callback(user_data, payload.data(), payload.size());
      });
  if (!unsubscribe) {
    handle->last_error = "native Fast DDS subscribe failed";
    return -1;
  }
  std::lock_guard<std::mutex> lock(handle->mutex);
  handle->unsubscribers.push_back(std::move(unsubscribe));
  return static_cast<int>(handle->unsubscribers.size() - 1);
}

void pr_fastdds_unsubscribe(pr_fastdds_client* handle, int subscription_id) {
  if (handle == nullptr || subscription_id < 0) {
    return;
  }
  std::function<void()> unsubscribe;
  {
    std::lock_guard<std::mutex> lock(handle->mutex);
    const auto index = static_cast<std::size_t>(subscription_id);
    if (index >= handle->unsubscribers.size()) {
      return;
    }
    unsubscribe = std::move(handle->unsubscribers[index]);
    handle->unsubscribers[index] = nullptr;
  }
  if (unsubscribe) {
    unsubscribe();
  }
}

}
