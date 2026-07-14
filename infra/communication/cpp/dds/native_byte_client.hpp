#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
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

#if __has_include(<dds/dds.h>)
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_CYCLONEDDS_C_API 1
#include <dds/dds.h>
#else
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_CYCLONEDDS_C_API 0
#endif

#include "infra/communication/cpp/dds/bus.hpp"

namespace pacific_rim::communication::dds {

#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_CYCLONEDDS_C_API

struct PrDdsSequenceOctet {
  std::uint32_t _maximum;
  std::uint32_t _length;
  std::uint8_t* _buffer;
  bool _release;
};

struct PrDdsEnvelope {
  PrDdsSequenceOctet payload;
};

struct NativeDdsQosDeleter {
  void operator()(dds_qos_t* qos) const {
    if (qos != nullptr) {
      dds_delete_qos(qos);
    }
  }
};

using NativeDdsQosPtr = std::unique_ptr<dds_qos_t, NativeDdsQosDeleter>;

inline std::string NativeDdsNormalizeQos(std::string value) {
  for (auto& ch : value) {
    if (ch == '-') {
      ch = '_';
    } else {
      ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
  }
  return value;
}

inline long NativeDdsLongOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    long fallback) {
  const auto iter = options.find(key);
  if (iter == options.end() || iter->second.empty()) {
    return fallback;
  }
  try {
    return std::stol(iter->second);
  } catch (...) {
    return fallback;
  }
}

inline NativeDdsQosPtr NativeDdsQosFromOptions(
    const std::map<std::string, std::string>& options) {
  if (options.empty()) {
    return NativeDdsQosPtr(nullptr);
  }

  NativeDdsQosPtr qos(dds_create_qos());
  if (qos == nullptr) {
    return qos;
  }

  const auto reliability = NativeDdsNormalizeQos(
      options.count("reliability") ? options.at("reliability") : "");
  if (reliability == "reliable") {
    const auto blocking_ms = NativeDdsLongOption(options, "max_blocking_time_ms", 100);
    dds_qset_reliability(
        qos.get(),
        DDS_RELIABILITY_RELIABLE,
        DDS_MSECS(blocking_ms > 0 ? blocking_ms : 100));
  } else if (reliability == "best_effort" || reliability == "besteffort") {
    dds_qset_reliability(qos.get(), DDS_RELIABILITY_BEST_EFFORT, 0);
  }

  const auto history = NativeDdsNormalizeQos(
      options.count("history") ? options.at("history") : "keep_last");
  const auto depth = NativeDdsLongOption(options, "depth", 0);
  if (history == "keep_all" || history == "keepall") {
    dds_qset_history(qos.get(), DDS_HISTORY_KEEP_ALL, 0);
  } else if (depth > 0) {
    dds_qset_history(
        qos.get(),
        DDS_HISTORY_KEEP_LAST,
        static_cast<std::int32_t>(depth));
  }

  const auto durability = NativeDdsNormalizeQos(
      options.count("durability") ? options.at("durability") : "");
  if (durability == "transient_local" || durability == "transientlocal") {
    dds_qset_durability(qos.get(), DDS_DURABILITY_TRANSIENT_LOCAL);
  } else if (durability == "volatile") {
    dds_qset_durability(qos.get(), DDS_DURABILITY_VOLATILE);
  }

  return qos;
}

inline const dds_topic_descriptor_t* PacificRimEnvelopeDescriptor() {
  static const std::uint32_t ops[] = {
      DDS_OP_ADR | DDS_OP_TYPE_SEQ | DDS_OP_SUBTYPE_1BY,
      static_cast<std::uint32_t>(offsetof(PrDdsEnvelope, payload)),
      DDS_OP_RTS};

#ifdef DDS_TOPIC_XTYPES_METADATA
  static unsigned char type_info[] = {
      0x60, 0x00, 0x00, 0x00, 0x01, 0x10, 0x00, 0x40, 0x28, 0x00, 0x00, 0x00,
      0x24, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0xf1, 0x53, 0x55, 0x15,
      0xd9, 0xc7, 0x9c, 0xa0, 0x0f, 0x11, 0x41, 0x26, 0xb2, 0x97, 0x71, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x02, 0x10, 0x00, 0x40, 0x28, 0x00, 0x00, 0x00,
      0x24, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0xf2, 0x23, 0x20, 0x6d,
      0x85, 0xca, 0x89, 0x19, 0xf5, 0x4c, 0xbc, 0xa3, 0x30, 0x93, 0x82, 0x00,
      0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00};
  static unsigned char type_map[] = {
      0x40, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xf1, 0x53, 0x55, 0x15,
      0xd9, 0xc7, 0x9c, 0xa0, 0x0f, 0x11, 0x41, 0x26, 0xb2, 0x97, 0x71, 0x00,
      0x28, 0x00, 0x00, 0x00, 0xf1, 0x51, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x80, 0xf3,
      0x01, 0x00, 0x00, 0x02, 0x32, 0x1c, 0x3c, 0xf4, 0x86, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0xf2, 0x23, 0x20, 0x6d, 0x85, 0xca, 0x89, 0x19,
      0xf5, 0x4c, 0xbc, 0xa3, 0x30, 0x93, 0x82, 0x00, 0x6e, 0x00, 0x00, 0x00,
      0xf2, 0x51, 0x01, 0x00, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x36, 0x00, 0x00, 0x00, 0x70, 0x61, 0x63, 0x69, 0x66, 0x69, 0x63, 0x5f,
      0x72, 0x69, 0x6d, 0x3a, 0x3a, 0x63, 0x6f, 0x6d, 0x6d, 0x75, 0x6e, 0x69,
      0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x3a, 0x3a, 0x50, 0x61, 0x63, 0x69,
      0x66, 0x69, 0x63, 0x52, 0x69, 0x6d, 0x4d, 0x65, 0x73, 0x73, 0x61, 0x67,
      0x65, 0x45, 0x6e, 0x76, 0x65, 0x6c, 0x6f, 0x70, 0x65, 0x00, 0x00, 0x00,
      0x22, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x80, 0xf3, 0x01, 0x00, 0x00, 0x02,
      0x08, 0x00, 0x00, 0x00, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x22, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0xf2, 0x23, 0x20, 0x6d, 0x85, 0xca, 0x89, 0x19, 0xf5, 0x4c, 0xbc, 0xa3,
      0x30, 0x93, 0x82, 0xf1, 0x53, 0x55, 0x15, 0xd9, 0xc7, 0x9c, 0xa0, 0x0f,
      0x11, 0x41, 0x26, 0xb2, 0x97, 0x71};

  static const dds_topic_descriptor_t descriptor = {
      sizeof(PrDdsEnvelope),
      alignof(PrDdsEnvelope),
      DDS_TOPIC_XTYPES_METADATA,
      0u,
      "pacific_rim::communication::PacificRimMessageEnvelope",
      nullptr,
      2u,
      ops,
      "",
      {type_info, sizeof(type_info)},
      {type_map, sizeof(type_map)}
#ifdef DDS_TOPIC_RESTRICT_DATA_REPRESENTATION
      ,
      0u
#endif
  };
#else
  static const dds_topic_descriptor_t descriptor = {
      sizeof(PrDdsEnvelope),
      alignof(PrDdsEnvelope),
      0u,
      0u,
      "pacific_rim::communication::PacificRimMessageEnvelope",
      nullptr,
      2u,
      ops,
      ""};
#endif
  return &descriptor;
}

class NativeCycloneDdsByteEnvelopeClient final : public CycloneDdsByteClient {
 public:
  ~NativeCycloneDdsByteEnvelopeClient() override { Close(); }

  bool Connect(const CycloneDdsConfig& config) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (participant_ > 0) {
      return true;
    }
    if (!config.config_uri.empty()) {
      setenv("CYCLONEDDS_URI", config.config_uri.c_str(), 1);
    }
    config_ = config;
    participant_ = dds_create_participant(static_cast<dds_domainid_t>(config.domain_id), nullptr, nullptr);
    closed_ = participant_ <= 0;
    return participant_ > 0;
  }

  void Close() override {
    closed_ = true;
    for (auto& thread : threads_) {
      if (thread != nullptr && thread->joinable()) {
        thread->join();
      }
    }
    threads_.clear();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      writers_.clear();
      readers_.clear();
      if (participant_ > 0) {
        dds_delete(participant_);
        participant_ = 0;
      }
    }
  }

  bool Publish(const DdsTopicConfig& topic, const Bytes& payload) override {
    auto writer = Writer(topic);
    if (writer <= 0) {
      return false;
    }
    PrDdsEnvelope sample{};
    sample.payload._maximum = static_cast<std::uint32_t>(payload.size());
    sample.payload._length = static_cast<std::uint32_t>(payload.size());
    sample.payload._release = false;
    sample.payload._buffer = const_cast<std::uint8_t*>(payload.data());
    return dds_write(writer, &sample) == DDS_RETCODE_OK;
  }

  bool PreparePublish(const DdsTopicConfig& topic) override {
    return Writer(topic) > 0;
  }

  bool Subscribe(const DdsSubscription& subscription, BytesHandler handler) override {
    return static_cast<bool>(SubscribeManaged(subscription, std::move(handler)));
  }

  std::function<void()> SubscribeManaged(
      const DdsSubscription& subscription,
      BytesHandler handler) override {
    auto reader = Reader(subscription.topic);
    if (reader <= 0 || !handler) {
      return {};
    }
    auto idle_period = std::chrono::milliseconds(1);
    auto closed = std::make_shared<std::atomic_bool>(false);
    auto thread = std::make_shared<std::thread>(
        [this, reader, handler = std::move(handler), idle_period, closed]() {
          while (!closed_ && !*closed) {
            if (!TakeAvailable(reader, handler)) {
              std::this_thread::sleep_for(idle_period);
            }
          }
        });
    {
      std::lock_guard<std::mutex> lock(mutex_);
      readers_.push_back(reader);
      threads_.push_back(thread);
    }
    return [this, closed, thread, reader]() {
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
      dds_delete(reader);
    };
  }

 private:
  static std::string TopicKey(const DdsTopicConfig& topic) {
    return topic.topic_name + ":" + topic.type_name;
  }

  dds_entity_t Writer(const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (participant_ <= 0) {
      return 0;
    }
    const auto key = TopicKey(topic);
    auto iter = writers_.find(key);
    if (iter != writers_.end()) {
      return iter->second;
    }
    auto topic_entity = dds_create_topic(
        participant_,
        PacificRimEnvelopeDescriptor(),
        NativeDdsTopicName(topic.topic_name).c_str(),
        nullptr,
        nullptr);
    if (topic_entity <= 0) {
      return 0;
    }
    auto qos = NativeDdsQosFromOptions(topic.qos);
    auto writer = dds_create_writer(participant_, topic_entity, qos.get(), nullptr);
    if (writer <= 0) {
      return 0;
    }
    writers_[key] = writer;
    return writer;
  }

  dds_entity_t Reader(const DdsTopicConfig& topic) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (participant_ <= 0) {
      return 0;
    }
    auto topic_entity = dds_create_topic(
        participant_,
        PacificRimEnvelopeDescriptor(),
        NativeDdsTopicName(topic.topic_name).c_str(),
        nullptr,
        nullptr);
    if (topic_entity <= 0) {
      return 0;
    }
    auto qos = NativeDdsQosFromOptions(topic.qos);
    return dds_create_reader(participant_, topic_entity, qos.get(), nullptr);
  }

  bool TakeAvailable(dds_entity_t reader, const BytesHandler& handler) {
    bool took_any = false;
    constexpr std::size_t kMaxSamples = 64;
    while (!closed_) {
      std::array<dds_sample_info_t, kMaxSamples> infos{};
      std::array<void*, kMaxSamples> samples{};
      auto rc = dds_take(
          reader,
          samples.data(),
          infos.data(),
          samples.size(),
          static_cast<std::uint32_t>(samples.size()));
      if (rc <= 0) {
        return took_any;
      }
      took_any = true;
      for (dds_return_t i = 0; i < rc; ++i) {
        auto* sample = static_cast<PrDdsEnvelope*>(samples[static_cast<std::size_t>(i)]);
        if (sample != nullptr && infos[static_cast<std::size_t>(i)].valid_data) {
          Bytes payload(
              sample->payload._buffer,
              sample->payload._buffer + sample->payload._length);
          handler(payload);
        }
      }
      dds_return_loan(reader, samples.data(), rc);
    }
    return took_any;
  }

  static std::string NativeDdsTopicName(const std::string& name) {
    std::ostringstream out;
    out << "pr_";
    for (unsigned char ch : name) {
      out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(ch);
    }
    return out.str();
  }

  CycloneDdsConfig config_;
  std::mutex mutex_;
  dds_entity_t participant_{0};
  std::map<std::string, dds_entity_t> writers_;
  std::vector<dds_entity_t> readers_;
  std::vector<std::shared_ptr<std::thread>> threads_;
  std::atomic_bool closed_{true};
};

inline void RegisterNativeByteEnvelopeCycloneDdsBus() {
  RegisterBus([](const CycloneDdsConfig&) {
    return std::make_unique<NativeCycloneDdsByteEnvelopeClient>();
  });
}

#else

class UnavailableNativeCycloneDdsByteEnvelopeClient final
    : public CycloneDdsByteClient {
 public:
  bool Connect(const CycloneDdsConfig&) override { return false; }
  void Close() override {}
  bool PreparePublish(const DdsTopicConfig&) override { return false; }
  bool Publish(const DdsTopicConfig&, const Bytes&) override { return false; }
  bool Subscribe(const DdsSubscription&, BytesHandler) override { return false; }
};

inline void RegisterNativeByteEnvelopeCycloneDdsBus() {
  RegisterBus([](const CycloneDdsConfig&) {
    return std::make_unique<UnavailableNativeCycloneDdsByteEnvelopeClient>();
  });
}

#endif

}  // namespace pacific_rim::communication::dds
