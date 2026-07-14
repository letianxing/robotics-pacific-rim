#pragma once

#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

#include <string>
#include <utility>

namespace pacific_rim::communication::nats {

using NatsEndpoint = std::pair<std::string, std::string>;

inline NatsEndpoint ParseNatsEndpoint(std::string url) {
  const std::string prefix = "nats://";
  if (url.rfind(prefix, 0) == 0) {
    url = url.substr(prefix.size());
  }
  const auto colon = url.rfind(':');
  if (colon == std::string::npos) {
    return {url, "4222"};
  }
  return {url.substr(0, colon), url.substr(colon + 1)};
}

inline int OpenNatsSocket(const std::string& host, const std::string& port) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* result = nullptr;
  if (getaddrinfo(host.c_str(), port.c_str(), &hints, &result) != 0) {
    return -1;
  }
  int fd = -1;
  for (auto* item = result; item != nullptr; item = item->ai_next) {
    fd = socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (fd < 0) {
      continue;
    }
    if (connect(fd, item->ai_addr, item->ai_addrlen) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(result);
  return fd;
}

inline bool WriteAll(int fd, const std::string& data) {
  const char* cursor = data.data();
  std::size_t remaining = data.size();
  while (remaining > 0) {
    const auto sent = send(fd, cursor, remaining, 0);
    if (sent <= 0) {
      return false;
    }
    cursor += sent;
    remaining -= static_cast<std::size_t>(sent);
  }
  return true;
}

inline bool ReadLine(int fd, std::string* line) {
  line->clear();
  char ch = 0;
  while (recv(fd, &ch, 1, 0) == 1) {
    if (ch == '\n') {
      if (!line->empty() && line->back() == '\r') {
        line->pop_back();
      }
      return true;
    }
    line->push_back(ch);
  }
  return false;
}

}  // namespace pacific_rim::communication::nats
