#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/security.hpp"

namespace pacific_rim::communication::core {

class SecurityCodec {
 public:
  explicit SecurityCodec(SecurityBinding binding)
      : binding_(std::move(binding)),
        sender_id_(RandomUint64()) {
    if (binding_.profile == nullptr) {
      throw std::invalid_argument("security profile is required");
    }
  }

  Bytes Encrypt(const Bytes& plaintext, const std::string& direction) {
    sequence_ += 1;
    std::array<std::uint8_t, 12> nonce{};
    FillRandom(nonce.data(), nonce.size());
    return EncryptWithOptions(plaintext, direction, sender_id_, sequence_, nonce);
  }

  Bytes Decrypt(const Bytes& encrypted, const std::string& direction) {
    const auto envelope = ParseEnvelope(encrypted);
    if (envelope.algorithm != binding_.profile->algorithm) {
      throw std::runtime_error("security algorithm mismatch");
    }
    const auto aad = BuildAAD(direction);
    if (First16(Sha256(aad)) != envelope.aad_hash) {
      throw std::runtime_error("security AAD hash mismatch");
    }
    const auto key_iter = binding_.profile->keys.find(envelope.key_id);
    if (key_iter == binding_.profile->keys.end()) {
      throw std::runtime_error("security key is not configured: " + envelope.key_id);
    }
    const auto route_key = DeriveRouteKey(key_iter->second);
    const auto encrypted_with_tag = Concat(envelope.ciphertext, envelope.tag);
    return AesGcmDecrypt(route_key, envelope.nonce, encrypted_with_tag, aad);
  }

  Bytes EncryptWithOptions(
      const Bytes& plaintext,
      const std::string& direction,
      std::uint64_t sender_id,
      std::uint64_t sequence,
      const std::array<std::uint8_t, 12>& nonce) {
    const auto key_iter = binding_.profile->keys.find(binding_.profile->encrypt_key_id);
    if (key_iter == binding_.profile->keys.end()) {
      throw std::runtime_error("security encrypt key is not configured: " + binding_.profile->encrypt_key_id);
    }
    const auto route_key = DeriveRouteKey(key_iter->second);
    const auto aad = BuildAAD(direction);
    const auto encrypted = AesGcmEncrypt(route_key, nonce, plaintext, aad);
    Bytes ciphertext(encrypted.begin(), encrypted.end() - 16);
    Bytes tag(encrypted.end() - 16, encrypted.end());
    return MarshalEnvelope(
        binding_.profile->algorithm,
        key_iter->second.key_id,
        sender_id,
        sequence,
        nonce,
        First16(Sha256(aad)),
        ciphertext,
        tag);
  }

 private:
  struct Envelope {
    SecurityAlgorithm algorithm{SecurityAlgorithm::kAes256Gcm};
    std::string key_id;
    std::uint64_t sender_id{0};
    std::uint64_t sequence{0};
    std::array<std::uint8_t, 12> nonce{};
    std::array<std::uint8_t, 16> aad_hash{};
    Bytes ciphertext;
    Bytes tag;
  };

  Bytes BuildAAD(const std::string& direction) const {
    std::string text = "pacific-rim|comm-security|v1\n";
    text += "profile=" + binding_.profile->name + "\n";
    text += "route=" + binding_.route + "\n";
    text += "binding=" + binding_.binding + "\n";
    text += "transport=" + binding_.transport + "\n";
    text += "address=" + binding_.address + "\n";
    text += "message_type=" + binding_.message_type + "\n";
    text += "direction=" + direction;
    if (!binding_.profile->aad_context.empty()) {
      text += "\ncontext=" + binding_.profile->aad_context;
    }
    return Bytes(text.begin(), text.end());
  }

  Bytes DeriveRouteKey(const SecurityKey& key) const {
    std::string info = "pacific-rim:comm-security:v1:";
    info += binding_.profile->name + ":" + binding_.route + ":" + binding_.message_type;
    const auto length = binding_.profile->algorithm == SecurityAlgorithm::kAes128Gcm ? 16 : 32;
    return HkdfSha256(key.master_key, key.salt, Bytes(info.begin(), info.end()), length);
  }

  static Bytes MarshalEnvelope(
      SecurityAlgorithm algorithm,
      const std::string& key_id,
      std::uint64_t sender_id,
      std::uint64_t sequence,
      const std::array<std::uint8_t, 12>& nonce,
      const std::array<std::uint8_t, 16>& aad_hash,
      const Bytes& ciphertext,
      const Bytes& tag) {
    if (key_id.size() > 255) {
      throw std::invalid_argument("security key_id is too long");
    }
    Bytes out;
    out.reserve(57 + key_id.size() + ciphertext.size() + tag.size());
    out.insert(out.end(), {'P', 'R', 'S', 'C'});
    out.push_back(1);
    out.push_back(static_cast<std::uint8_t>(algorithm));
    AppendLE16(&out, 0);
    out.push_back(static_cast<std::uint8_t>(key_id.size()));
    AppendLE64(&out, sender_id);
    AppendLE64(&out, sequence);
    out.insert(out.end(), nonce.begin(), nonce.end());
    out.insert(out.end(), aad_hash.begin(), aad_hash.end());
    AppendLE32(&out, static_cast<std::uint32_t>(ciphertext.size()));
    out.insert(out.end(), key_id.begin(), key_id.end());
    out.insert(out.end(), ciphertext.begin(), ciphertext.end());
    out.insert(out.end(), tag.begin(), tag.end());
    return out;
  }

  static Envelope ParseEnvelope(const Bytes& data) {
    if (data.size() < 57 + 16) {
      throw std::runtime_error("security envelope is too short");
    }
    if (data[0] != 'P' || data[1] != 'R' || data[2] != 'S' || data[3] != 'C') {
      throw std::runtime_error("security envelope magic mismatch");
    }
    std::size_t offset = 4;
    if (data[offset++] != 1) {
      throw std::runtime_error("unsupported security envelope version");
    }
    Envelope envelope;
    envelope.algorithm = static_cast<SecurityAlgorithm>(data[offset++]);
    offset += 2;
    const auto key_id_len = static_cast<std::size_t>(data[offset++]);
    envelope.sender_id = ReadLE64(data, offset);
    offset += 8;
    envelope.sequence = ReadLE64(data, offset);
    offset += 8;
    std::copy_n(data.begin() + offset, 12, envelope.nonce.begin());
    offset += 12;
    std::copy_n(data.begin() + offset, 16, envelope.aad_hash.begin());
    offset += 16;
    const auto ciphertext_len = static_cast<std::size_t>(ReadLE32(data, offset));
    offset += 4;
    if (key_id_len == 0 || data.size() != offset + key_id_len + ciphertext_len + 16) {
      throw std::runtime_error("security envelope length mismatch");
    }
    envelope.key_id.assign(data.begin() + offset, data.begin() + offset + key_id_len);
    offset += key_id_len;
    envelope.ciphertext.assign(data.begin() + offset, data.begin() + offset + ciphertext_len);
    offset += ciphertext_len;
    envelope.tag.assign(data.begin() + offset, data.begin() + offset + 16);
    return envelope;
  }

  static Bytes AesGcmEncrypt(
      const Bytes& key,
      const std::array<std::uint8_t, 12>& nonce,
      const Bytes& plaintext,
      const Bytes& aad) {
    AesCipher cipher(key);
    const auto h = cipher.EncryptBlock({});
    std::array<std::uint8_t, 16> j0{};
    std::copy(nonce.begin(), nonce.end(), j0.begin());
    j0[15] = 1;
    const auto ciphertext = Gctr(cipher, Inc32(j0), plaintext);
    auto tag_block = Xor(cipher.EncryptBlock(j0), GHash(h, aad, ciphertext));
    return Concat(ciphertext, Bytes(tag_block.begin(), tag_block.end()));
  }

  static Bytes AesGcmDecrypt(
      const Bytes& key,
      const std::array<std::uint8_t, 12>& nonce,
      const Bytes& encrypted,
      const Bytes& aad) {
    if (encrypted.size() < 16) {
      throw std::runtime_error("ciphertext is shorter than GCM tag");
    }
    AesCipher cipher(key);
    Bytes ciphertext(encrypted.begin(), encrypted.end() - 16);
    Bytes tag(encrypted.end() - 16, encrypted.end());
    const auto h = cipher.EncryptBlock({});
    std::array<std::uint8_t, 16> j0{};
    std::copy(nonce.begin(), nonce.end(), j0.begin());
    j0[15] = 1;
    auto expected = Xor(cipher.EncryptBlock(j0), GHash(h, aad, ciphertext));
    if (!std::equal(tag.begin(), tag.end(), expected.begin())) {
      throw std::runtime_error("security decrypt failed");
    }
    return Gctr(cipher, Inc32(j0), ciphertext);
  }

  class AesCipher {
   public:
    explicit AesCipher(const Bytes& key) {
      const auto nk = key.size() / 4;
      if (nk != 4 && nk != 8) {
        throw std::invalid_argument("AES key must be 16 or 32 bytes");
      }
      rounds_ = static_cast<int>(nk) + 6;
      std::vector<std::uint32_t> words;
      for (std::size_t index = 0; index < key.size(); index += 4) {
        words.push_back(
            (static_cast<std::uint32_t>(key[index]) << 24) |
            (static_cast<std::uint32_t>(key[index + 1]) << 16) |
            (static_cast<std::uint32_t>(key[index + 2]) << 8) |
            key[index + 3]);
      }
      int rcon = 1;
      while (words.size() < 4 * static_cast<std::size_t>(rounds_ + 1)) {
        auto temp = words.back();
        if (words.size() % nk == 0) {
          temp = SubWord(RotWord(temp)) ^ (static_cast<std::uint32_t>(kRcon[rcon++]) << 24);
        } else if (nk > 6 && words.size() % nk == 4) {
          temp = SubWord(temp);
        }
        words.push_back(words[words.size() - nk] ^ temp);
      }
      round_keys_ = std::move(words);
    }

    std::array<std::uint8_t, 16> EncryptBlock(std::array<std::uint8_t, 16> state) const {
      AddRoundKey(&state, 0);
      for (int round = 1; round < rounds_; ++round) {
        SubBytes(&state);
        ShiftRows(&state);
        MixColumns(&state);
        AddRoundKey(&state, round);
      }
      SubBytes(&state);
      ShiftRows(&state);
      AddRoundKey(&state, rounds_);
      return state;
    }

   private:
    void AddRoundKey(std::array<std::uint8_t, 16>* state, int round) const {
      for (int column = 0; column < 4; ++column) {
        const auto word = round_keys_[round * 4 + column];
        (*state)[4 * column] ^= static_cast<std::uint8_t>((word >> 24) & 0xFF);
        (*state)[4 * column + 1] ^= static_cast<std::uint8_t>((word >> 16) & 0xFF);
        (*state)[4 * column + 2] ^= static_cast<std::uint8_t>((word >> 8) & 0xFF);
        (*state)[4 * column + 3] ^= static_cast<std::uint8_t>(word & 0xFF);
      }
    }

    static std::uint32_t RotWord(std::uint32_t word) {
      return ((word << 8) & 0xFFFFFFFFU) | (word >> 24);
    }

    static std::uint32_t SubWord(std::uint32_t word) {
      return (static_cast<std::uint32_t>(kSbox[(word >> 24) & 0xFF]) << 24) |
             (static_cast<std::uint32_t>(kSbox[(word >> 16) & 0xFF]) << 16) |
             (static_cast<std::uint32_t>(kSbox[(word >> 8) & 0xFF]) << 8) |
             kSbox[word & 0xFF];
    }

    static void SubBytes(std::array<std::uint8_t, 16>* state) {
      for (auto& item : *state) {
        item = kSbox[item];
      }
    }

    static void ShiftRows(std::array<std::uint8_t, 16>* state) {
      const auto original = *state;
      for (int row = 0; row < 4; ++row) {
        for (int column = 0; column < 4; ++column) {
          (*state)[4 * column + row] = original[4 * ((column + row) % 4) + row];
        }
      }
    }

    static void MixColumns(std::array<std::uint8_t, 16>* state) {
      for (int column = 0; column < 4; ++column) {
        const auto offset = 4 * column;
        const auto a0 = (*state)[offset];
        const auto a1 = (*state)[offset + 1];
        const auto a2 = (*state)[offset + 2];
        const auto a3 = (*state)[offset + 3];
        const auto t = a0 ^ a1 ^ a2 ^ a3;
        (*state)[offset] ^= t ^ Xtime(a0 ^ a1);
        (*state)[offset + 1] ^= t ^ Xtime(a1 ^ a2);
        (*state)[offset + 2] ^= t ^ Xtime(a2 ^ a3);
        (*state)[offset + 3] ^= t ^ Xtime(a3 ^ a0);
      }
    }

    static std::uint8_t Xtime(std::uint8_t value) {
      return static_cast<std::uint8_t>((value & 0x80) ? ((value << 1) ^ 0x1B) : (value << 1));
    }

    int rounds_{0};
    std::vector<std::uint32_t> round_keys_;
  };

  static Bytes Gctr(const AesCipher& cipher, std::array<std::uint8_t, 16> counter, const Bytes& data) {
    Bytes out;
    out.reserve(data.size());
    for (std::size_t offset = 0; offset < data.size(); offset += 16) {
      const auto stream = cipher.EncryptBlock(counter);
      const auto block_size = std::min<std::size_t>(16, data.size() - offset);
      for (std::size_t index = 0; index < block_size; ++index) {
        out.push_back(data[offset + index] ^ stream[index]);
      }
      counter = Inc32(counter);
    }
    return out;
  }

  static std::array<std::uint8_t, 16> GHash(
      const std::array<std::uint8_t, 16>& h,
      const Bytes& aad,
      const Bytes& ciphertext) {
    std::array<std::uint8_t, 16> y{};
    for (const auto& block : GHashBlocks(aad)) {
      y = GfMul(Xor(y, block), h);
    }
    for (const auto& block : GHashBlocks(ciphertext)) {
      y = GfMul(Xor(y, block), h);
    }
    std::array<std::uint8_t, 16> length_block{};
    WriteBE64(&length_block, 0, static_cast<std::uint64_t>(aad.size() * 8));
    WriteBE64(&length_block, 8, static_cast<std::uint64_t>(ciphertext.size() * 8));
    return GfMul(Xor(y, length_block), h);
  }

  static std::vector<std::array<std::uint8_t, 16>> GHashBlocks(const Bytes& data) {
    std::vector<std::array<std::uint8_t, 16>> blocks;
    for (std::size_t offset = 0; offset < data.size(); offset += 16) {
      std::array<std::uint8_t, 16> block{};
      const auto block_size = std::min<std::size_t>(16, data.size() - offset);
      std::copy_n(data.begin() + offset, block_size, block.begin());
      blocks.push_back(block);
    }
    return blocks;
  }

  static std::array<std::uint8_t, 16> GfMul(
      const std::array<std::uint8_t, 16>& x,
      std::array<std::uint8_t, 16> v) {
    std::array<std::uint8_t, 16> z{};
    for (int bit = 0; bit < 128; ++bit) {
      if ((x[bit / 8] >> (7 - (bit % 8))) & 1U) {
        z = Xor(z, v);
      }
      const bool lsb = (v[15] & 1U) != 0;
      ShiftRightOne(&v);
      if (lsb) {
        v[0] ^= 0xE1;
      }
    }
    return z;
  }

  static std::array<std::uint8_t, 16> Inc32(std::array<std::uint8_t, 16> block) {
    std::uint32_t value = (static_cast<std::uint32_t>(block[12]) << 24) |
                          (static_cast<std::uint32_t>(block[13]) << 16) |
                          (static_cast<std::uint32_t>(block[14]) << 8) |
                          block[15];
    value += 1;
    block[12] = static_cast<std::uint8_t>((value >> 24) & 0xFF);
    block[13] = static_cast<std::uint8_t>((value >> 16) & 0xFF);
    block[14] = static_cast<std::uint8_t>((value >> 8) & 0xFF);
    block[15] = static_cast<std::uint8_t>(value & 0xFF);
    return block;
  }

  static void ShiftRightOne(std::array<std::uint8_t, 16>* value) {
    std::uint8_t carry = 0;
    for (auto& item : *value) {
      const auto next_carry = static_cast<std::uint8_t>(item & 1U);
      item = static_cast<std::uint8_t>((item >> 1) | (carry << 7));
      carry = next_carry;
    }
  }

  static std::array<std::uint8_t, 16> Xor(
      const std::array<std::uint8_t, 16>& a,
      const std::array<std::uint8_t, 16>& b) {
    std::array<std::uint8_t, 16> out{};
    for (std::size_t index = 0; index < out.size(); ++index) {
      out[index] = a[index] ^ b[index];
    }
    return out;
  }

  static Bytes HkdfSha256(const Bytes& secret, const Bytes& salt, const Bytes& info, std::size_t length) {
    const auto effective_salt = salt.empty() ? Bytes(32, 0) : salt;
    const auto prk = HmacSha256(effective_salt, secret);
    Bytes out;
    Bytes previous;
    std::uint8_t counter = 1;
    while (out.size() < length) {
      Bytes input = previous;
      input.insert(input.end(), info.begin(), info.end());
      input.push_back(counter++);
      previous = HmacSha256(prk, input);
      out.insert(out.end(), previous.begin(), previous.end());
    }
    out.resize(length);
    return out;
  }

  static Bytes HmacSha256(const Bytes& key, const Bytes& data) {
    Bytes hmac_key = key;
    if (hmac_key.size() > 64) {
      hmac_key = Sha256(hmac_key);
    }
    hmac_key.resize(64, 0);
    Bytes outer(64, 0x5c);
    Bytes inner(64, 0x36);
    for (std::size_t index = 0; index < 64; ++index) {
      outer[index] ^= hmac_key[index];
      inner[index] ^= hmac_key[index];
    }
    inner.insert(inner.end(), data.begin(), data.end());
    auto inner_hash = Sha256(inner);
    outer.insert(outer.end(), inner_hash.begin(), inner_hash.end());
    return Sha256(outer);
  }

  static Bytes Sha256(const Bytes& data) {
    static constexpr std::array<std::uint32_t, 64> k = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    std::array<std::uint32_t, 8> h = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    Bytes padded = data;
    const auto bit_len = static_cast<std::uint64_t>(padded.size()) * 8;
    padded.push_back(0x80);
    while ((padded.size() % 64) != 56) {
      padded.push_back(0);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
      padded.push_back(static_cast<std::uint8_t>((bit_len >> shift) & 0xFF));
    }
    for (std::size_t offset = 0; offset < padded.size(); offset += 64) {
      std::array<std::uint32_t, 64> w{};
      for (int index = 0; index < 16; ++index) {
        const auto base = offset + static_cast<std::size_t>(index) * 4;
        w[index] = (static_cast<std::uint32_t>(padded[base]) << 24) |
                   (static_cast<std::uint32_t>(padded[base + 1]) << 16) |
                   (static_cast<std::uint32_t>(padded[base + 2]) << 8) |
                   padded[base + 3];
      }
      for (int index = 16; index < 64; ++index) {
        const auto s0 = RotateRight(w[index - 15], 7) ^ RotateRight(w[index - 15], 18) ^ (w[index - 15] >> 3);
        const auto s1 = RotateRight(w[index - 2], 17) ^ RotateRight(w[index - 2], 19) ^ (w[index - 2] >> 10);
        w[index] = w[index - 16] + s0 + w[index - 7] + s1;
      }
      auto a = h[0];
      auto b = h[1];
      auto c = h[2];
      auto d = h[3];
      auto e = h[4];
      auto f = h[5];
      auto g = h[6];
      auto hh = h[7];
      for (int index = 0; index < 64; ++index) {
        const auto s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
        const auto ch = (e & f) ^ ((~e) & g);
        const auto temp1 = hh + s1 + ch + k[index] + w[index];
        const auto s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
        const auto maj = (a & b) ^ (a & c) ^ (b & c);
        const auto temp2 = s0 + maj;
        hh = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    Bytes out;
    out.reserve(32);
    for (const auto word : h) {
      out.push_back(static_cast<std::uint8_t>((word >> 24) & 0xFF));
      out.push_back(static_cast<std::uint8_t>((word >> 16) & 0xFF));
      out.push_back(static_cast<std::uint8_t>((word >> 8) & 0xFF));
      out.push_back(static_cast<std::uint8_t>(word & 0xFF));
    }
    return out;
  }

  static std::uint32_t RotateRight(std::uint32_t value, int bits) {
    return (value >> bits) | (value << (32 - bits));
  }

  static std::array<std::uint8_t, 16> First16(const Bytes& value) {
    std::array<std::uint8_t, 16> out{};
    std::copy_n(value.begin(), 16, out.begin());
    return out;
  }

  static Bytes Concat(const Bytes& a, const Bytes& b) {
    Bytes out = a;
    out.insert(out.end(), b.begin(), b.end());
    return out;
  }

  static void AppendLE16(Bytes* out, std::uint16_t value) {
    out->push_back(static_cast<std::uint8_t>(value & 0xFF));
    out->push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
  }

  static void AppendLE32(Bytes* out, std::uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
      out->push_back(static_cast<std::uint8_t>((value >> shift) & 0xFF));
    }
  }

  static void AppendLE64(Bytes* out, std::uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) {
      out->push_back(static_cast<std::uint8_t>((value >> shift) & 0xFF));
    }
  }

  static std::uint32_t ReadLE32(const Bytes& data, std::size_t offset) {
    return static_cast<std::uint32_t>(data[offset]) |
           (static_cast<std::uint32_t>(data[offset + 1]) << 8) |
           (static_cast<std::uint32_t>(data[offset + 2]) << 16) |
           (static_cast<std::uint32_t>(data[offset + 3]) << 24);
  }

  static std::uint64_t ReadLE64(const Bytes& data, std::size_t offset) {
    std::uint64_t value = 0;
    for (int index = 7; index >= 0; --index) {
      value = (value << 8) | data[offset + static_cast<std::size_t>(index)];
    }
    return value;
  }

  static void WriteBE64(std::array<std::uint8_t, 16>* out, std::size_t offset, std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) {
      (*out)[offset++] = static_cast<std::uint8_t>((value >> shift) & 0xFF);
    }
  }

  static void FillRandom(std::uint8_t* data, std::size_t size) {
    std::random_device device;
    for (std::size_t index = 0; index < size; ++index) {
      data[index] = static_cast<std::uint8_t>(device());
    }
  }

  static std::uint64_t RandomUint64() {
    std::array<std::uint8_t, 8> bytes{};
    FillRandom(bytes.data(), bytes.size());
    std::uint64_t value = 0;
    for (const auto byte : bytes) {
      value = (value << 8) | byte;
    }
    return value == 0 ? 1 : value;
  }

  SecurityBinding binding_;
  std::uint64_t sender_id_{1};
  std::uint64_t sequence_{0};

  static constexpr std::array<std::uint8_t, 11> kRcon = {
      0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36};

  static constexpr std::array<std::uint8_t, 256> kSbox = {
      0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
      0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
      0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
      0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
      0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
      0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
      0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
      0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
      0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
      0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
      0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
      0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
      0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
      0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
      0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
      0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16};
};

}  // namespace pacific_rim::communication::core
