#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if __has_include(<fastdds/dds/domain/DomainParticipantFactory.hpp>) && \
    __has_include(<fastdds/dds/topic/TopicDataType.hpp>) && \
    __has_include(<fastcdr/Cdr.h>)
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API 1
#include <fastcdr/Cdr.h>
#include <fastcdr/FastBuffer.h>
#include <fastdds/dds/core/status/PublicationMatchedStatus.hpp>
#include <fastdds/dds/core/policy/QosPolicies.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/subscriber/DataReader.hpp>
#include <fastdds/dds/subscriber/SampleInfo.hpp>
#include <fastdds/dds/subscriber/Subscriber.hpp>
#include <fastdds/dds/topic/Topic.hpp>
#include <fastdds/dds/topic/TopicDataType.hpp>
#include <fastdds/dds/topic/TypeSupport.hpp>
#include <fastrtps/rtps/common/SerializedPayload.h>
#include <fastrtps/types/TypesBase.h>
#else
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API 0
#endif

#include "infra/communication/cpp/dds/bus.hpp"

namespace pacific_rim::communication::dds {

#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_FASTDDS_CPP_API

struct FastDdsEnvelope {
  const std::uint8_t* payload_data{nullptr};
  std::size_t payload_size{0};
  Bytes payload_storage;

  const std::uint8_t* Data() const {
    return payload_data != nullptr ? payload_data : payload_storage.data();
  }

  std::size_t Size() const {
    return payload_data != nullptr ? payload_size : payload_storage.size();
  }
};

inline std::string FastDdsNormalizeQos(std::string value) {
  for (auto& ch : value) {
    if (ch == '-') {
      ch = '_';
    } else {
      ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
  }
  return value;
}

inline int FastDdsIntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int fallback) {
  const auto iter = options.find(key);
  if (iter == options.end() || iter->second.empty()) {
    return fallback;
  }
  try {
    return std::stoi(iter->second);
  } catch (...) {
    return fallback;
  }
}

class FastDdsEnvelopeTopicDataType final
    : public eprosima::fastdds::dds::TopicDataType {
 public:
  explicit FastDdsEnvelopeTopicDataType(std::uint32_t max_payload_bytes) {
    setName("pacific_rim::communication::PacificRimMessageEnvelope");
    m_typeSize = max_payload_bytes + 16;
    m_isGetKeyDefined = false;
  }

  bool serialize(
      void* data,
      eprosima::fastrtps::rtps::SerializedPayload_t* payload) override {
    if (data == nullptr || payload == nullptr) {
      return false;
    }
    auto* sample = static_cast<FastDdsEnvelope*>(data);
    const auto sample_size = sample->Size();
    if (sample_size + 16 > payload->max_size) {
      return false;
    }
    eprosima::fastcdr::FastBuffer buffer(
        reinterpret_cast<char*>(payload->data),
        payload->max_size);
    eprosima::fastcdr::Cdr cdr(buffer);
    cdr.serialize_encapsulation();
    cdr << static_cast<std::uint32_t>(sample_size);
    if (sample_size > 0) {
      cdr.serializeArray(sample->Data(), sample_size);
    }
    payload->encapsulation =
        cdr.endianness() == eprosima::fastcdr::Cdr::BIG_ENDIANNESS
            ? CDR_BE
            : CDR_LE;
    payload->length = static_cast<std::uint32_t>(cdr.getSerializedDataLength());
    return true;
  }

  bool deserialize(
      eprosima::fastrtps::rtps::SerializedPayload_t* payload,
      void* data) override {
    if (data == nullptr || payload == nullptr) {
      return false;
    }
    auto* sample = static_cast<FastDdsEnvelope*>(data);
    eprosima::fastcdr::FastBuffer buffer(
        reinterpret_cast<char*>(payload->data),
        payload->length);
    eprosima::fastcdr::Cdr cdr(buffer);
    cdr.read_encapsulation();
    std::uint32_t sample_size = 0;
    cdr >> sample_size;
    sample->payload_storage.resize(sample_size);
    if (sample_size > 0) {
      cdr.deserializeArray(sample->payload_storage.data(), sample_size);
    }
    sample->payload_data = nullptr;
    sample->payload_size = 0;
    return true;
  }

  std::function<std::uint32_t()> getSerializedSizeProvider(void* data) override {
    auto* sample = static_cast<FastDdsEnvelope*>(data);
    const auto size = sample == nullptr
                          ? 16u
                          : static_cast<std::uint32_t>(sample->Size() + 16);
    return [size]() { return size; };
  }

  void* createData() override { return new FastDdsEnvelope(); }

  void deleteData(void* data) override {
    delete static_cast<FastDdsEnvelope*>(data);
  }

  bool getKey(
      void*,
      eprosima::fastrtps::rtps::InstanceHandle_t*,
      bool = false) override {
    return false;
  }
};

inline void ApplyFastDdsDataWriterQos(
    const std::map<std::string, std::string>& options,
    eprosima::fastdds::dds::DataWriterQos* qos) {
  if (qos == nullptr) {
    return;
  }
  const auto reliability = FastDdsNormalizeQos(
      options.count("reliability") ? options.at("reliability") : "reliable");
  if (reliability == "reliable") {
    qos->reliability().kind = eprosima::fastdds::dds::RELIABLE_RELIABILITY_QOS;
  } else if (reliability == "best_effort" || reliability == "besteffort") {
    qos->reliability().kind = eprosima::fastdds::dds::BEST_EFFORT_RELIABILITY_QOS;
  }

  const auto history = FastDdsNormalizeQos(
      options.count("history") ? options.at("history") : "keep_last");
  const auto depth = FastDdsIntOption(options, "depth", 10);
  if (history == "keep_all" || history == "keepall") {
    qos->history().kind = eprosima::fastdds::dds::KEEP_ALL_HISTORY_QOS;
  } else {
    qos->history().kind = eprosima::fastdds::dds::KEEP_LAST_HISTORY_QOS;
    qos->history().depth = depth > 0 ? depth : 10;
  }

  const auto durability = FastDdsNormalizeQos(
      options.count("durability") ? options.at("durability") : "");
  if (durability == "transient_local" || durability == "transientlocal") {
    qos->durability().kind =
        eprosima::fastdds::dds::TRANSIENT_LOCAL_DURABILITY_QOS;
  } else if (durability == "volatile") {
    qos->durability().kind = eprosima::fastdds::dds::VOLATILE_DURABILITY_QOS;
  }
}

inline void ApplyFastDdsDataReaderQos(
    const std::map<std::string, std::string>& options,
    eprosima::fastdds::dds::DataReaderQos* qos) {
  if (qos == nullptr) {
    return;
  }
  const auto reliability = FastDdsNormalizeQos(
      options.count("reliability") ? options.at("reliability") : "reliable");
  if (reliability == "reliable") {
    qos->reliability().kind = eprosima::fastdds::dds::RELIABLE_RELIABILITY_QOS;
  } else if (reliability == "best_effort" || reliability == "besteffort") {
    qos->reliability().kind = eprosima::fastdds::dds::BEST_EFFORT_RELIABILITY_QOS;
  }

  const auto history = FastDdsNormalizeQos(
      options.count("history") ? options.at("history") : "keep_last");
  const auto depth = FastDdsIntOption(options, "depth", 10);
  if (history == "keep_all" || history == "keepall") {
    qos->history().kind = eprosima::fastdds::dds::KEEP_ALL_HISTORY_QOS;
  } else {
    qos->history().kind = eprosima::fastdds::dds::KEEP_LAST_HISTORY_QOS;
    qos->history().depth = depth > 0 ? depth : 10;
  }

  const auto durability = FastDdsNormalizeQos(
      options.count("durability") ? options.at("durability") : "");
  if (durability == "transient_local" || durability == "transientlocal") {
    qos->durability().kind =
        eprosima::fastdds::dds::TRANSIENT_LOCAL_DURABILITY_QOS;
  } else if (durability == "volatile") {
    qos->durability().kind = eprosima::fastdds::dds::VOLATILE_DURABILITY_QOS;
  }
}

class NativeFastDdsByteEnvelopeClient final : public CycloneDdsByteClient {
 public:
  ~NativeFastDdsByteEnvelopeClient() override { Close(); }

  void ConfigureOptions(
      const std::map<std::string, std::string>& options) override {
    config_options_ = options;
  }

  bool Connect(const CycloneDdsConfig& config) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (participant_ != nullptr) {
      return true;
    }
    config_ = config;
    closed_ = false;
    participant_ =
        eprosima::fastdds::dds::DomainParticipantFactory::get_instance()
            ->create_participant(
                static_cast<std::uint32_t>(config.domain_id),
                eprosima::fastdds::dds::PARTICIPANT_QOS_DEFAULT);
    if (participant_ == nullptr) {
      closed_ = true;
      return false;
    }
    type_support_ = eprosima::fastdds::dds::TypeSupport(
        new FastDdsEnvelopeTopicDataType(
            static_cast<std::uint32_t>(MaxPayloadBytes())));
    if (type_support_.register_type(participant_) !=
        eprosima::fastrtps::types::ReturnCode_t::RETCODE_OK) {
      closed_ = true;
      return false;
    }
    publisher_ =
        participant_->create_publisher(eprosima::fastdds::dds::PUBLISHER_QOS_DEFAULT);
    subscriber_ =
        participant_->create_subscriber(eprosima::fastdds::dds::SUBSCRIBER_QOS_DEFAULT);
    if (publisher_ == nullptr || subscriber_ == nullptr) {
      closed_ = true;
      return false;
    }
    return true;
  }

  void Close() override {
    closed_ = true;
    for (auto& thread : threads_) {
      if (thread != nullptr && thread->joinable()) {
        thread->join();
      }
    }
    threads_.clear();
    std::lock_guard<std::mutex> lock(mutex_);
    if (participant_ != nullptr) {
      WaitForAcknowledgmentsLocked();
      participant_->delete_contained_entities();
      eprosima::fastdds::dds::DomainParticipantFactory::get_instance()
          ->delete_participant(participant_);
    }
    participant_ = nullptr;
    publisher_ = nullptr;
    subscriber_ = nullptr;
    writers_.clear();
    topics_.clear();
    discovery_readers_.clear();
    active_readers_.clear();
    readers_.clear();
    type_support_.reset();
  }

  bool PreparePublish(const DdsTopicConfig& topic) override {
    return Writer(topic) != nullptr;
  }

  bool Publish(const DdsTopicConfig& topic, const Bytes& payload) override {
    return PublishRaw(topic, payload.data(), payload.size());
  }

  bool PublishRaw(
      const DdsTopicConfig& topic,
      const std::uint8_t* payload,
      std::size_t size) {
    if (payload == nullptr && size > 0) {
      return false;
    }
    auto* writer = Writer(topic);
    if (writer == nullptr || size > MaxPayloadBytes()) {
      return false;
    }
    FastDdsEnvelope sample;
    sample.payload_data = payload;
    sample.payload_size = size;
    return writer->write(&sample);
  }

  bool WaitForSubscribers(
      const DdsTopicConfig& topic,
      std::chrono::milliseconds timeout) override {
    auto* writer = Writer(topic);
    if (writer == nullptr) {
      return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      eprosima::fastdds::dds::PublicationMatchedStatus status;
      if (writer->get_publication_matched_status(status) ==
              eprosima::fastrtps::types::ReturnCode_t::RETCODE_OK &&
          status.current_count > 0) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return false;
  }

  bool WaitForPublishers(
      const DdsTopicConfig& topic,
      std::chrono::milliseconds timeout) override {
    auto* reader = ActiveReader(topic);
    if (reader == nullptr) {
      reader = DiscoveryReader(topic);
    }
    if (reader == nullptr) {
      return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      eprosima::fastdds::dds::SubscriptionMatchedStatus status;
      if (reader->get_subscription_matched_status(status) ==
              eprosima::fastrtps::types::ReturnCode_t::RETCODE_OK &&
          status.current_count > 0) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return false;
  }

  bool Subscribe(const DdsSubscription& subscription, BytesHandler handler) override {
    return static_cast<bool>(SubscribeManaged(subscription, std::move(handler)));
  }

  std::function<void()> SubscribeManaged(
      const DdsSubscription& subscription,
      BytesHandler handler) override {
    auto* reader = Reader(subscription.topic);
    if (reader == nullptr || !handler) {
      return {};
    }
    auto closed = std::make_shared<std::atomic_bool>(false);
    auto thread = std::make_shared<std::thread>(
        [this, reader, handler = std::move(handler), closed]() {
          while (!closed_ && !*closed) {
            if (!TakeAvailable(reader, handler)) {
              std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
          }
        });
    {
      std::lock_guard<std::mutex> lock(mutex_);
      readers_.push_back(reader);
      threads_.push_back(thread);
      active_readers_[TopicKey(subscription.topic)].push_back(reader);
    }
    const auto key = TopicKey(subscription.topic);
    return [this, closed, thread, reader, key]() {
      bool expected = false;
      if (!closed->compare_exchange_strong(expected, true)) {
        return;
      }
      if (thread != nullptr && thread->joinable()) {
        thread->join();
      }
      std::lock_guard<std::mutex> lock(mutex_);
      readers_.erase(
          std::remove(readers_.begin(), readers_.end(), reader),
          readers_.end());
      auto active_iter = active_readers_.find(key);
      if (active_iter != active_readers_.end()) {
        auto& active = active_iter->second;
        active.erase(std::remove(active.begin(), active.end(), reader), active.end());
        if (active.empty()) {
          active_readers_.erase(active_iter);
        }
      }
      if (subscriber_ != nullptr) {
        subscriber_->delete_datareader(reader);
      }
    };
  }

 private:
  std::size_t MaxPayloadBytes() const {
    const auto value =
        FastDdsIntOption(config_options_, "max_payload_bytes", 1024 * 1024);
    return value > 0 ? static_cast<std::size_t>(value) : 1024 * 1024;
  }

  int CloseAckTimeoutMs() const {
    return FastDdsIntOption(config_options_, "close_ack_timeout_ms", 1500);
  }

  void WaitForAcknowledgmentsLocked() {
    const int timeout_ms = CloseAckTimeoutMs();
    if (timeout_ms <= 0) {
      return;
    }
    const eprosima::fastrtps::Duration_t timeout(
        timeout_ms / 1000,
        static_cast<std::uint32_t>((timeout_ms % 1000) * 1000000));
    for (const auto& [_, writer] : writers_) {
      if (writer != nullptr) {
        writer->wait_for_acknowledgments(timeout);
      }
    }
  }

  static std::string TopicKey(const DdsTopicConfig& topic) {
    return topic.topic_name + ":" + topic.type_name;
  }

  eprosima::fastdds::dds::Topic* Topic(const DdsTopicConfig& topic) {
    const auto key = TopicKey(topic);
    auto iter = topics_.find(key);
    if (iter != topics_.end()) {
      return iter->second;
    }
    if (participant_ == nullptr || !type_support_) {
      return nullptr;
    }
    auto* fast_topic = participant_->create_topic(
        FastDdsTopicName(topic.topic_name),
        type_support_.get_type_name(),
        eprosima::fastdds::dds::TOPIC_QOS_DEFAULT);
    if (fast_topic != nullptr) {
      topics_[key] = fast_topic;
    }
    return fast_topic;
  }

  eprosima::fastdds::dds::DataWriter* Writer(const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (publisher_ == nullptr) {
      return nullptr;
    }
    const auto key = TopicKey(topic);
    auto iter = writers_.find(key);
    if (iter != writers_.end()) {
      return iter->second;
    }
    auto* fast_topic = Topic(topic);
    if (fast_topic == nullptr) {
      return nullptr;
    }
    auto qos = eprosima::fastdds::dds::DATAWRITER_QOS_DEFAULT;
    ApplyFastDdsDataWriterQos(topic.qos, &qos);
    auto* writer = publisher_->create_datawriter(fast_topic, qos);
    if (writer != nullptr) {
      writers_[key] = writer;
    }
    return writer;
  }

  eprosima::fastdds::dds::DataReader* Reader(const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (subscriber_ == nullptr) {
      return nullptr;
    }
    auto* fast_topic = Topic(topic);
    if (fast_topic == nullptr) {
      return nullptr;
    }
    auto qos = eprosima::fastdds::dds::DATAREADER_QOS_DEFAULT;
    ApplyFastDdsDataReaderQos(topic.qos, &qos);
    return subscriber_->create_datareader(fast_topic, qos);
  }

  eprosima::fastdds::dds::DataReader* ActiveReader(
      const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto iter = active_readers_.find(TopicKey(topic));
    if (iter == active_readers_.end() || iter->second.empty()) {
      return nullptr;
    }
    return iter->second.front();
  }

  eprosima::fastdds::dds::DataReader* DiscoveryReader(
      const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (subscriber_ == nullptr) {
      return nullptr;
    }
    const auto key = TopicKey(topic);
    auto iter = discovery_readers_.find(key);
    if (iter != discovery_readers_.end()) {
      return iter->second;
    }
    auto* fast_topic = Topic(topic);
    if (fast_topic == nullptr) {
      return nullptr;
    }
    auto qos = eprosima::fastdds::dds::DATAREADER_QOS_DEFAULT;
    ApplyFastDdsDataReaderQos(topic.qos, &qos);
    qos.reliability().kind = eprosima::fastdds::dds::BEST_EFFORT_RELIABILITY_QOS;
    auto* reader = subscriber_->create_datareader(fast_topic, qos);
    if (reader != nullptr) {
      discovery_readers_[key] = reader;
    }
    return reader;
  }

  bool TakeAvailable(
      eprosima::fastdds::dds::DataReader* reader,
      const BytesHandler& handler) {
    bool took_any = false;
    while (!closed_) {
      FastDdsEnvelope sample;
      eprosima::fastdds::dds::SampleInfo info;
      const auto rc = reader->take_next_sample(&sample, &info);
      if (rc == eprosima::fastrtps::types::ReturnCode_t::RETCODE_NO_DATA) {
        return took_any;
      }
      if (rc != eprosima::fastrtps::types::ReturnCode_t::RETCODE_OK) {
        return took_any;
      }
      took_any = true;
      if (info.valid_data) {
        handler(sample.payload_storage);
      }
    }
    return took_any;
  }

  static std::string FastDdsTopicName(const std::string& name) {
    std::ostringstream out;
    out << "pr_";
    for (unsigned char ch : name) {
      out << std::hex << std::setw(2) << std::setfill('0')
          << static_cast<int>(ch);
    }
    return out.str();
  }

  CycloneDdsConfig config_;
  std::map<std::string, std::string> config_options_;
  std::mutex mutex_;
  eprosima::fastdds::dds::DomainParticipant* participant_{nullptr};
  eprosima::fastdds::dds::Publisher* publisher_{nullptr};
  eprosima::fastdds::dds::Subscriber* subscriber_{nullptr};
  eprosima::fastdds::dds::TypeSupport type_support_;
  std::map<std::string, eprosima::fastdds::dds::Topic*> topics_;
  std::map<std::string, eprosima::fastdds::dds::DataWriter*> writers_;
  std::map<std::string, eprosima::fastdds::dds::DataReader*> discovery_readers_;
  std::map<std::string, std::vector<eprosima::fastdds::dds::DataReader*>>
      active_readers_;
  std::vector<eprosima::fastdds::dds::DataReader*> readers_;
  std::vector<std::shared_ptr<std::thread>> threads_;
  std::atomic_bool closed_{true};
};

inline void RegisterNativeByteEnvelopeFastDdsBus() {
  RegisterBus(
      [](const CycloneDdsConfig&) {
        return std::make_unique<NativeFastDdsByteEnvelopeClient>();
      },
      {},
      TransportKind::kFastDds);
}

#else

class UnavailableNativeFastDdsByteEnvelopeClient final
    : public CycloneDdsByteClient {
 public:
  bool Connect(const CycloneDdsConfig&) override { return false; }
  void Close() override {}
  bool PreparePublish(const DdsTopicConfig&) override { return false; }
  bool Publish(const DdsTopicConfig&, const Bytes&) override { return false; }
  bool Subscribe(const DdsSubscription&, BytesHandler) override { return false; }
};

inline void RegisterNativeByteEnvelopeFastDdsBus() {
  RegisterBus(
      [](const CycloneDdsConfig&) {
        return std::make_unique<UnavailableNativeFastDdsByteEnvelopeClient>();
      },
      {},
      TransportKind::kFastDds);
}

#endif

}  // namespace pacific_rim::communication::dds
