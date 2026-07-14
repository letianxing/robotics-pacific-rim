from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import struct
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, TransportKind

from .middleware import BytesHandler, Channel, ChannelLike, MessageBus

SECURITY_OPTION_PROFILE = "security.profile"
SECURITY_METADATA_PROFILE = "security.profile"
SECURITY_PROFILE_NONE = "none"

_MAGIC = b"PRSC"
_VERSION = 1
_HEADER = struct.Struct("<4sBBHBQQ12s16sI")
_TAG_LEN = 16
_ALG_AES_256_GCM = 1
_ALG_AES_128_GCM = 2


@dataclass(frozen=True)
class SecurityKeyConfig:
  key_id: str
  key_env: str
  salt_env: str = ""
  decrypt_only: bool = False


@dataclass(frozen=True)
class SecurityProfileConfig:
  enabled: bool = True
  algorithm: str = "aes-256-gcm"
  key_id: str = ""
  encrypt_key_id: str = ""
  key_env: str = ""
  salt_env: str = ""
  aad_context: str = ""
  replay_window: int = 4096
  fail_open: bool = False
  keys: tuple[SecurityKeyConfig, ...] = ()


@dataclass(frozen=True)
class SecuritySettings:
  require_explicit_profile: bool = False
  profiles: Mapping[str, SecurityProfileConfig] = field(default_factory=dict)


@dataclass(frozen=True)
class ResolvedSecurityKey:
  key_id: str
  master_key: bytes
  salt: bytes
  decrypt_only: bool = False


@dataclass(frozen=True)
class ResolvedSecurityProfile:
  name: str
  algorithm: int
  aad_context: str
  replay_window: int
  encrypt_key_id: str
  fail_open: bool
  keys: Mapping[str, ResolvedSecurityKey]


@dataclass(frozen=True)
class SecurityBinding:
  profile: ResolvedSecurityProfile
  route: str
  binding: str
  transport: str
  address: str
  message_type: str = ""


class SecurityRuntime:
  def __init__(self, settings: SecuritySettings | None = None):
    settings = settings or SecuritySettings()
    self.require_explicit_profile = settings.require_explicit_profile
    self._profiles: dict[str, ResolvedSecurityProfile] = {}
    for name, config in settings.profiles.items():
      if not config.enabled:
        continue
      profile = _resolve_profile(str(name).strip(), config)
      self._profiles[profile.name] = profile

  def resolve_binding(
    self,
    bus_name: str,
    bus_config: MiddlewareConfig,
    endpoint: Endpoint,
  ) -> SecurityBinding | None:
    profile_name, explicit = _endpoint_security_profile(endpoint)
    if not profile_name:
      profile_name = _bus_security_profile(bus_config)
    normalized = _normalize_security_profile(profile_name)
    if normalized == SECURITY_PROFILE_NONE:
      return None
    if not normalized:
      if self.require_explicit_profile and bus_config.transport == TransportKind.NATS:
        raise ValueError(f"security_profile is required for route endpoint {endpoint.address!r} on middleware {bus_name!r}")
      return None
    if not explicit and self.require_explicit_profile and bus_config.transport == TransportKind.NATS:
      raise ValueError(f"security_profile must be explicit for route endpoint {endpoint.address!r} on middleware {bus_name!r}")
    profile = self._profiles.get(normalized)
    if profile is None:
      raise ValueError(f"security profile {normalized!r} is not configured or is disabled")
    metadata = endpoint.metadata or {}
    route = str(metadata.get("logical_route") or metadata.get("source_name") or endpoint.address).strip()
    binding = str(metadata.get("binding_name") or bus_name).strip()
    return SecurityBinding(
      profile=profile,
      route=route,
      binding=binding,
      transport=str(bus_config.transport.value),
      address=endpoint.address,
      message_type=endpoint.message_type,
    )


class SecurityCodec:
  def __init__(self, binding: SecurityBinding):
    self._binding = binding
    self._profile = binding.profile
    self._sender_id = int.from_bytes(os.urandom(8), "big") or 1
    self._sequence = 0
    self._lock = threading.Lock()
    self._replay = _ReplayWindow(self._profile.replay_window)

  def encrypt(self, plaintext: bytes, direction: str) -> bytes:
    with self._lock:
      self._sequence += 1
      sequence = self._sequence
    return self.encrypt_with_options(plaintext, direction, self._sender_id, sequence, None)

  def encrypt_with_options(
    self,
    plaintext: bytes,
    direction: str,
    sender_id: int,
    sequence: int,
    nonce: bytes | None,
  ) -> bytes:
    key = self._profile.keys[self._profile.encrypt_key_id]
    nonce_bytes = nonce or os.urandom(12)
    if len(nonce_bytes) != 12:
      raise ValueError("nonce must be 12 bytes")
    aad = self.aad(direction)
    route_key = _derive_route_key(key.master_key, key.salt, self._profile, self._binding)
    encrypted = _aes_gcm_encrypt(route_key, nonce_bytes, plaintext, aad, self._profile.algorithm)
    ciphertext, tag = encrypted[:-_TAG_LEN], encrypted[-_TAG_LEN:]
    aad_digest = hashlib.sha256(aad).digest()[:16]
    key_id = key.key_id.encode("utf-8")
    return b"".join(
      [
        _HEADER.pack(
          _MAGIC,
          _VERSION,
          self._profile.algorithm,
          0,
          len(key_id),
          sender_id,
          sequence,
          nonce_bytes,
          aad_digest,
          len(ciphertext),
        ),
        key_id,
        ciphertext,
        tag,
      ]
    )

  def decrypt(self, encrypted: bytes, direction: str) -> bytes:
    envelope = _parse_envelope(encrypted)
    if envelope["algorithm"] != self._profile.algorithm:
      raise ValueError("security algorithm mismatch")
    aad = self.aad(direction)
    if envelope["aad_hash"] != hashlib.sha256(aad).digest()[:16]:
      raise ValueError("security AAD hash mismatch")
    key = self._profile.keys.get(envelope["key_id"])
    if key is None:
      raise ValueError(f"security key {envelope['key_id']!r} is not configured for profile {self._profile.name!r}")
    route_key = _derive_route_key(key.master_key, key.salt, self._profile, self._binding)
    plaintext = _aes_gcm_decrypt(
      route_key,
      envelope["nonce"],
      envelope["ciphertext"] + envelope["tag"],
      aad,
      self._profile.algorithm,
    )
    if not self._replay.accept(envelope["sender_id"], envelope["sequence"]):
      raise ValueError("security replay rejected")
    return plaintext

  def aad(self, direction: str) -> bytes:
    return build_security_aad(self._profile.name, self._binding, direction, self._profile.aad_context)


class SecureMessageBus:
  def __init__(self, inner: MessageBus, binding: SecurityBinding):
    self._inner = inner
    self._codec = SecurityCodec(binding)

  @property
  def kind(self):
    return self._inner.kind

  @property
  def capabilities(self):
    return self._inner.capabilities

  async def connect(self) -> None:
    await self._inner.connect()

  async def close(self) -> None:
    await self._inner.close()

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    await self._inner.publish_bytes(channel, self._codec.encrypt(payload, "publish"))

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    async def wrapped(payload: bytes) -> None:
      result = handler(self._codec.decrypt(payload, "publish"))
      if hasattr(result, "__await__"):
        await result

    await self._inner.subscribe_bytes(channel, wrapped)

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    encrypted_request = self._codec.encrypt(payload, "rpc_request")
    encrypted_response = await self._inner.request_bytes(channel, encrypted_request, timeout_sec=timeout_sec)
    return self._codec.decrypt(encrypted_response, "rpc_response")


def load_security_settings(raw: Mapping[str, Any]) -> SecuritySettings:
  section = raw.get("communication", raw) if isinstance(raw.get("communication", raw), Mapping) else raw
  raw_security = section.get("security", {}) if isinstance(section, Mapping) else {}
  if not isinstance(raw_security, Mapping):
    return SecuritySettings()
  profiles: dict[str, SecurityProfileConfig] = {}
  for name, value in dict(raw_security.get("profiles", {}) or {}).items():
    if not isinstance(value, Mapping):
      continue
    item = dict(value)
    keys: list[SecurityKeyConfig] = []
    for key_item in item.get("keys") or []:
      if isinstance(key_item, Mapping):
        keys.append(
          SecurityKeyConfig(
            key_id=str(key_item.get("key_id", "")).strip(),
            key_env=str(key_item.get("key_env", "")).strip(),
            salt_env=str(key_item.get("salt_env", "")).strip(),
            decrypt_only=bool(key_item.get("decrypt_only", False)),
          )
        )
    profiles[str(name).strip()] = SecurityProfileConfig(
      enabled=bool(item.get("enabled", True)),
      algorithm=str(item.get("algorithm", "aes-256-gcm")).strip(),
      key_id=str(item.get("key_id", "")).strip(),
      encrypt_key_id=str(item.get("encrypt_key_id", "")).strip(),
      key_env=str(item.get("key_env", "")).strip(),
      salt_env=str(item.get("salt_env", "")).strip(),
      aad_context=str(item.get("aad_context", "")).strip(),
      replay_window=int(item.get("replay_window", 4096) or 4096),
      fail_open=bool(item.get("fail_open", False)),
      keys=tuple(keys),
    )
  return SecuritySettings(
    require_explicit_profile=bool(raw_security.get("require_explicit_profile", False)),
    profiles=profiles,
  )


def build_security_aad(profile_name: str, binding: SecurityBinding, direction: str, context: str = "") -> bytes:
  lines = [
    "pacific-rim|comm-security|v1",
    f"profile={profile_name}",
    f"route={binding.route}",
    f"binding={binding.binding}",
    f"transport={binding.transport}",
    f"address={binding.address}",
    f"message_type={binding.message_type}",
    f"direction={direction}",
  ]
  if context.strip():
    lines.append(f"context={context.strip()}")
  return "\n".join(lines).encode("utf-8")


def _resolve_profile(name: str, config: SecurityProfileConfig) -> ResolvedSecurityProfile:
  if not name:
    raise ValueError("security profile name is required")
  algorithm = _parse_algorithm(config.algorithm)
  raw_keys = list(config.keys)
  if not raw_keys:
    raw_keys = [
      SecurityKeyConfig(
        key_id=config.key_id or config.encrypt_key_id,
        key_env=config.key_env,
        salt_env=config.salt_env,
      )
    ]
  keys: dict[str, ResolvedSecurityKey] = {}
  for raw_key in raw_keys:
    if not raw_key.key_id:
      raise ValueError(f"security profile {name!r}: key_id is required")
    keys[raw_key.key_id] = ResolvedSecurityKey(
      key_id=raw_key.key_id,
      master_key=_secret_from_env(raw_key.key_env),
      salt=_optional_secret_from_env(raw_key.salt_env),
      decrypt_only=raw_key.decrypt_only,
    )
  encrypt_key_id = config.encrypt_key_id or config.key_id
  if not encrypt_key_id:
    raise ValueError(f"security profile {name!r}: encrypt_key_id or key_id is required")
  if encrypt_key_id not in keys:
    raise ValueError(f"security profile {name!r}: encrypt key {encrypt_key_id!r} is not configured")
  if keys[encrypt_key_id].decrypt_only:
    raise ValueError(f"security profile {name!r}: encrypt key {encrypt_key_id!r} is decrypt_only")
  return ResolvedSecurityProfile(
    name=name,
    algorithm=algorithm,
    aad_context=config.aad_context.strip(),
    replay_window=config.replay_window or 4096,
    encrypt_key_id=encrypt_key_id,
    fail_open=config.fail_open,
    keys=keys,
  )


def _parse_algorithm(value: str) -> int:
  normalized = str(value or "aes-256-gcm").strip().lower().replace("_", "-")
  if normalized in {"", "aes-256-gcm"}:
    return _ALG_AES_256_GCM
  if normalized == "aes-128-gcm":
    return _ALG_AES_128_GCM
  raise ValueError(f"unsupported security algorithm {value!r}")


def _endpoint_security_profile(endpoint: Endpoint) -> tuple[str, bool]:
  metadata = endpoint.metadata or {}
  if SECURITY_METADATA_PROFILE in metadata:
    return str(metadata.get(SECURITY_METADATA_PROFILE) or ""), True
  if "security_profile" in metadata:
    return str(metadata.get("security_profile") or ""), True
  return "", False


def _bus_security_profile(config: MiddlewareConfig) -> str:
  options = config.options or {}
  return str(options.get(SECURITY_OPTION_PROFILE) or options.get("security_profile") or "")


def _normalize_security_profile(value: str) -> str:
  normalized = str(value or "").strip().lower()
  if normalized in {"", "inherit"}:
    return ""
  if normalized in {"none", "disabled", "disable", "off", "plaintext", "plain"}:
    return SECURITY_PROFILE_NONE
  return str(value).strip()


def _secret_from_env(env_name: str) -> bytes:
  name = str(env_name or "").strip()
  if not name:
    raise ValueError("key_env is required")
  value = os.environ.get(name, "").strip()
  if not value:
    raise ValueError(f"environment variable {name} is empty")
  return _decode_secret(value)


def _optional_secret_from_env(env_name: str) -> bytes:
  name = str(env_name or "").strip()
  if not name:
    return b""
  value = os.environ.get(name, "").strip()
  if not value:
    raise ValueError(f"environment variable {name} is empty")
  return _decode_secret(value)


def _decode_secret(value: str) -> bytes:
  text = value.strip()
  for decoder in (base64.b64decode, base64.urlsafe_b64decode):
    try:
      decoded = decoder(text + "=" * (-len(text) % 4))
      if decoded:
        return decoded
    except (binascii.Error, ValueError):
      pass
  try:
    return bytes.fromhex(text)
  except ValueError:
    return text.encode("utf-8")


def _parse_envelope(data: bytes) -> dict[str, Any]:
  if len(data) < _HEADER.size + _TAG_LEN:
    raise ValueError("security envelope is too short")
  magic, version, algorithm, _flags, key_id_len, sender_id, sequence, nonce, aad_hash, ciphertext_len = _HEADER.unpack_from(data, 0)
  if magic != _MAGIC:
    raise ValueError("security envelope magic mismatch")
  if version != _VERSION:
    raise ValueError(f"unsupported security envelope version {version}")
  offset = _HEADER.size
  expected_len = offset + key_id_len + ciphertext_len + _TAG_LEN
  if key_id_len == 0 or len(data) != expected_len:
    raise ValueError("security envelope length mismatch")
  key_id = data[offset : offset + key_id_len].decode("utf-8")
  offset += key_id_len
  ciphertext = data[offset : offset + ciphertext_len]
  offset += ciphertext_len
  tag = data[offset : offset + _TAG_LEN]
  return {
    "algorithm": algorithm,
    "key_id": key_id,
    "sender_id": sender_id,
    "sequence": sequence,
    "nonce": nonce,
    "aad_hash": aad_hash,
    "ciphertext": ciphertext,
    "tag": tag,
  }


def _derive_route_key(master_key: bytes, salt: bytes, profile: ResolvedSecurityProfile, binding: SecurityBinding) -> bytes:
  info = f"pacific-rim:comm-security:v1:{profile.name}:{binding.route}:{binding.message_type}".encode("utf-8")
  length = 16 if profile.algorithm == _ALG_AES_128_GCM else 32
  return _hkdf_sha256(master_key, salt, info, length)


def _hkdf_sha256(secret: bytes, salt: bytes, info: bytes, length: int) -> bytes:
  salt = salt or bytes(hashlib.sha256().digest_size)
  prk = hmac.new(salt, secret, hashlib.sha256).digest()
  out = b""
  previous = b""
  counter = 1
  while len(out) < length:
    previous = hmac.new(prk, previous + info + bytes([counter]), hashlib.sha256).digest()
    out += previous
    counter += 1
  return out[:length]


class _ReplayWindow:
  def __init__(self, limit: int):
    self._limit = int(limit or 4096)
    self._seen: dict[int, set[int]] = {}
    self._lock = threading.Lock()

  def accept(self, sender_id: int, sequence: int) -> bool:
    with self._lock:
      sequences = self._seen.setdefault(sender_id, set())
      if sequence in sequences:
        return False
      sequences.add(sequence)
      if len(sequences) > self._limit:
        sequences.remove(min(sequences))
      return True


def _aes_gcm_encrypt(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes, algorithm: int) -> bytes:
  cipher = _AESCipher(key, algorithm)
  return _gcm_encrypt(cipher.encrypt_block, nonce, plaintext, aad)


def _aes_gcm_decrypt(key: bytes, nonce: bytes, encrypted: bytes, aad: bytes, algorithm: int) -> bytes:
  if len(encrypted) < _TAG_LEN:
    raise ValueError("ciphertext is shorter than GCM tag")
  cipher = _AESCipher(key, algorithm)
  return _gcm_decrypt(cipher.encrypt_block, nonce, encrypted, aad)


def _gcm_encrypt(encrypt_block, nonce: bytes, plaintext: bytes, aad: bytes) -> bytes:
  h = encrypt_block(bytes(16))
  j0 = nonce + b"\x00\x00\x00\x01"
  ciphertext = _gctr(encrypt_block, _inc32(j0), plaintext)
  tag = bytes(a ^ b for a, b in zip(encrypt_block(j0), _ghash(h, aad, ciphertext)))
  return ciphertext + tag


def _gcm_decrypt(encrypt_block, nonce: bytes, encrypted: bytes, aad: bytes) -> bytes:
  ciphertext, expected_tag = encrypted[:-_TAG_LEN], encrypted[-_TAG_LEN:]
  h = encrypt_block(bytes(16))
  j0 = nonce + b"\x00\x00\x00\x01"
  actual_tag = bytes(a ^ b for a, b in zip(encrypt_block(j0), _ghash(h, aad, ciphertext)))
  if not hmac.compare_digest(actual_tag, expected_tag):
    raise ValueError("security decrypt failed")
  return _gctr(encrypt_block, _inc32(j0), ciphertext)


def _gctr(encrypt_block, initial_counter: bytes, data: bytes) -> bytes:
  if not data:
    return b""
  out = bytearray()
  counter = initial_counter
  for offset in range(0, len(data), 16):
    block = data[offset : offset + 16]
    stream = encrypt_block(counter)
    out.extend(a ^ b for a, b in zip(block, stream))
    counter = _inc32(counter)
  return bytes(out)


def _inc32(block: bytes) -> bytes:
  prefix = block[:12]
  value = (int.from_bytes(block[12:], "big") + 1) & 0xFFFFFFFF
  return prefix + value.to_bytes(4, "big")


def _ghash(h: bytes, aad: bytes, ciphertext: bytes) -> bytes:
  y = 0
  h_int = int.from_bytes(h, "big")
  for block in _gcm_blocks(aad) + _gcm_blocks(ciphertext):
    y = _gf_mul(y ^ int.from_bytes(block, "big"), h_int)
  length_block = ((len(aad) * 8) << 64) | (len(ciphertext) * 8)
  y = _gf_mul(y ^ length_block, h_int)
  return y.to_bytes(16, "big")


def _gcm_blocks(data: bytes) -> list[bytes]:
  blocks: list[bytes] = []
  for offset in range(0, len(data), 16):
    block = data[offset : offset + 16]
    blocks.append(block + bytes(16 - len(block)))
  return blocks


def _gf_mul(x: int, y: int) -> int:
  z = 0
  v = y
  r = 0xE1000000000000000000000000000000
  for index in range(128):
    if (x >> (127 - index)) & 1:
      z ^= v
    if v & 1:
      v = (v >> 1) ^ r
    else:
      v >>= 1
  return z


class _AESCipher:
  def __init__(self, key: bytes, algorithm: int):
    expected = 16 if algorithm == _ALG_AES_128_GCM else 32
    if len(key) != expected:
      raise ValueError(f"AES key must be {expected} bytes")
    self._round_keys = _expand_aes_key(key)
    self._rounds = len(self._round_keys) - 1

  def encrypt_block(self, block: bytes) -> bytes:
    if len(block) != 16:
      raise ValueError("AES block must be 16 bytes")
    state = bytearray(block)
    _add_round_key(state, self._round_keys[0])
    for round_index in range(1, self._rounds):
      _sub_bytes(state)
      _shift_rows(state)
      _mix_columns(state)
      _add_round_key(state, self._round_keys[round_index])
    _sub_bytes(state)
    _shift_rows(state)
    _add_round_key(state, self._round_keys[self._rounds])
    return bytes(state)


def _expand_aes_key(key: bytes) -> list[list[int]]:
  nk = len(key) // 4
  nr = nk + 6
  words = [int.from_bytes(key[index : index + 4], "big") for index in range(0, len(key), 4)]
  rcon_index = 1
  while len(words) < 4 * (nr + 1):
    temp = words[-1]
    if len(words) % nk == 0:
      temp = _sub_word(_rot_word(temp)) ^ (_RCON[rcon_index] << 24)
      rcon_index += 1
    elif nk > 6 and len(words) % nk == 4:
      temp = _sub_word(temp)
    words.append(words[-nk] ^ temp)
  return [words[index : index + 4] for index in range(0, len(words), 4)]


def _rot_word(word: int) -> int:
  return ((word << 8) & 0xFFFFFFFF) | (word >> 24)


def _sub_word(word: int) -> int:
  return (
    (_SBOX[(word >> 24) & 0xFF] << 24)
    | (_SBOX[(word >> 16) & 0xFF] << 16)
    | (_SBOX[(word >> 8) & 0xFF] << 8)
    | _SBOX[word & 0xFF]
  )


def _add_round_key(state: bytearray, round_key: list[int]) -> None:
  for column, word in enumerate(round_key):
    state[4 * column] ^= (word >> 24) & 0xFF
    state[4 * column + 1] ^= (word >> 16) & 0xFF
    state[4 * column + 2] ^= (word >> 8) & 0xFF
    state[4 * column + 3] ^= word & 0xFF


def _sub_bytes(state: bytearray) -> None:
  for index, value in enumerate(state):
    state[index] = _SBOX[value]


def _shift_rows(state: bytearray) -> None:
  original = bytes(state)
  for row in range(4):
    for column in range(4):
      state[4 * column + row] = original[4 * ((column + row) % 4) + row]


def _mix_columns(state: bytearray) -> None:
  for column in range(4):
    offset = 4 * column
    a0, a1, a2, a3 = state[offset : offset + 4]
    t = a0 ^ a1 ^ a2 ^ a3
    u = a0
    state[offset] ^= t ^ _xtime(a0 ^ a1)
    state[offset + 1] ^= t ^ _xtime(a1 ^ a2)
    state[offset + 2] ^= t ^ _xtime(a2 ^ a3)
    state[offset + 3] ^= t ^ _xtime(a3 ^ u)


def _xtime(value: int) -> int:
  return (((value << 1) & 0xFF) ^ 0x1B) if value & 0x80 else (value << 1)


_RCON = [
  0x00,
  0x01,
  0x02,
  0x04,
  0x08,
  0x10,
  0x20,
  0x40,
  0x80,
  0x1B,
  0x36,
]


_SBOX = [
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
  0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]
