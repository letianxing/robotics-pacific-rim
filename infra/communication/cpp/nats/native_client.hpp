#pragma once

#include <atomic>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include <sys/socket.h>
#include <unistd.h>

#include "infra/communication/cpp/nats/bus.hpp"
#include "infra/communication/cpp/nats/native_protocol.hpp"

namespace pacific_rim::communication::nats {

class NativeNatsByteClient final : public NatsByteClient {
 public:
  ~NativeNatsByteClient() override { Close(); }

  bool Connect(const NatsConfig& config) override {
    config_ = config;
    auto endpoint = ParseNatsEndpoint(config.server_url);
    fd_ = OpenNatsSocket(endpoint.first, endpoint.second);
    if (fd_ < 0) {
      return false;
    }
    std::string info;
    if (!ReadLine(fd_, &info)) {
      Close();
      return false;
    }
    if (!Write("CONNECT {\"verbose\":false,\"pedantic\":false,\"lang\":\"cpp\"}\r\nPING\r\n")) {
      Close();
      return false;
    }
    running_.store(true);
    reader_ = std::thread([this]() { ReadLoop(); });
    return true;
  }

  void Close() override {
    if (!running_.exchange(false) && fd_ < 0) {
      return;
    }
    if (fd_ >= 0) {
      shutdown(fd_, SHUT_RDWR);
    }
    if (reader_.joinable()) {
      reader_.join();
    }
    if (fd_ >= 0) {
      close(fd_);
      fd_ = -1;
    }
    std::lock_guard<std::mutex> lock(callbacks_mutex_);
    callbacks_.clear();
  }

  bool Publish(const std::string& subject, const Bytes& payload) override {
    return PublishMessage(subject, "", payload);
  }

  bool Subscribe(
      const std::string& subject,
      const std::string& queue_group,
      BytesHandler handler) override {
    const auto sid = NextSid();
    {
      std::lock_guard<std::mutex> lock(callbacks_mutex_);
      callbacks_[sid] = [handler = std::move(handler)](const Bytes& payload, const std::string&) {
        handler(payload);
      };
    }
    std::ostringstream command;
    command << "SUB " << subject;
    if (!queue_group.empty()) {
      command << " " << queue_group;
    }
    command << " " << sid << "\r\n";
    return Write(command.str());
  }

  bool HandleRequest(
      const std::string& subject,
      const std::string& queue_group,
      pacific_rim::communication::core::RequestHandler handler) override {
    const auto sid = NextSid();
    {
      std::lock_guard<std::mutex> lock(callbacks_mutex_);
      callbacks_[sid] = [this, handler = std::move(handler)](
                            const Bytes& payload,
                            const std::string& reply) {
        if (!reply.empty()) {
          PublishMessage(reply, "", handler(payload));
        }
      };
    }
    std::ostringstream command;
    command << "SUB " << subject;
    if (!queue_group.empty()) {
      command << " " << queue_group;
    }
    command << " " << sid << "\r\n";
    return Write(command.str());
  }

  bool Request(
      const std::string& subject,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    const auto sid = NextSid();
    const auto inbox = "_INBOX." + config_.name + "." + sid;
    auto state = std::make_shared<RequestState>();
    {
      std::lock_guard<std::mutex> lock(callbacks_mutex_);
      callbacks_[sid] = [state](const Bytes& data, const std::string&) {
        {
          std::lock_guard<std::mutex> response_lock(state->mutex);
          state->payload = data;
          state->received = true;
        }
        state->ready.notify_one();
      };
    }
    if (!Write("SUB " + inbox + " " + sid + "\r\n") ||
        !PublishMessage(subject, inbox, payload)) {
      EraseCallback(sid);
      return false;
    }
    std::unique_lock<std::mutex> lock(state->mutex);
    const bool ok = state->ready.wait_for(
        lock,
        timeout,
        [&]() { return state->received; });
    EraseCallback(sid);
    Write("UNSUB " + sid + "\r\n");
    if (ok && response != nullptr) {
      *response = std::move(state->payload);
    }
    return ok;
  }

 private:
  struct RequestState {
    std::mutex mutex;
    std::condition_variable ready;
    bool received{false};
    Bytes payload;
  };

  std::string NextSid() {
    return std::to_string(next_sid_.fetch_add(1));
  }

  bool PublishMessage(const std::string& subject, const std::string& reply, const Bytes& payload) {
    std::ostringstream command;
    command << "PUB " << subject;
    if (!reply.empty()) {
      command << " " << reply;
    }
    command << " " << payload.size() << "\r\n";
    std::string frame = command.str();
    frame.append(reinterpret_cast<const char*>(payload.data()), payload.size());
    frame.append("\r\n");
    return Write(frame);
  }

  bool Write(const std::string& data) {
    std::lock_guard<std::mutex> lock(write_mutex_);
    return WriteAll(fd_, data);
  }

  bool ReadBytes(std::size_t size, Bytes* payload) {
    payload->assign(size, 0);
    std::size_t offset = 0;
    while (offset < size) {
      const auto count = recv(fd_, payload->data() + offset, size - offset, 0);
      if (count <= 0) {
        return false;
      }
      offset += static_cast<std::size_t>(count);
    }
    char crlf[2]{};
    return recv(fd_, crlf, 2, 0) == 2;
  }

  void ReadLoop() {
    std::string line;
    while (running_.load() && ReadLine(fd_, &line)) {
      if (line == "PING") {
        Write("PONG\r\n");
        continue;
      }
      if (line.rfind("MSG ", 0) == 0) {
        HandleMessage(line);
      }
    }
  }

  void HandleMessage(const std::string& line) {
    std::istringstream input(line);
    std::string tag;
    std::string subject;
    std::string sid;
    std::string maybe_reply_or_size;
    std::string maybe_size;
    input >> tag >> subject >> sid >> maybe_reply_or_size >> maybe_size;
    const auto size_text = maybe_size.empty() ? maybe_reply_or_size : maybe_size;
    Bytes payload;
    if (!ReadBytes(static_cast<std::size_t>(std::stoul(size_text)), &payload)) {
      return;
    }
    ReplyBytesHandler handler;
    const auto reply = maybe_size.empty() ? "" : maybe_reply_or_size;
    {
      std::lock_guard<std::mutex> lock(callbacks_mutex_);
      const auto iter = callbacks_.find(sid);
      if (iter != callbacks_.end()) {
        handler = iter->second;
      }
    }
    if (handler) {
      handler(payload, reply);
    }
  }

  void EraseCallback(const std::string& sid) {
    std::lock_guard<std::mutex> lock(callbacks_mutex_);
    callbacks_.erase(sid);
  }

  NatsConfig config_;
  int fd_{-1};
  std::atomic_bool running_{false};
  std::atomic_int next_sid_{1};
  std::thread reader_;
  std::mutex write_mutex_;
  std::mutex callbacks_mutex_;
  using ReplyBytesHandler = std::function<void(const Bytes&, const std::string&)>;
  std::map<std::string, ReplyBytesHandler> callbacks_;
};

inline void RegisterNativeNatsBus() {
  RegisterBus([](const NatsConfig&) {
    return std::make_unique<NativeNatsByteClient>();
  });
}

}  // namespace pacific_rim::communication::nats
