# Pacific-Rim 通信加密方案

这份文档说明如何参考 VLink 的消息级加密能力，在 Pacific-Rim 现有通信体系里落地。

目标读者：

- 需要判断方案是否合理的架构/后端同学。
- 后续要实现 `infra/communication` 加密能力的工程同学。
- 需要知道配置怎么写、哪些链路会被加密的模块负责人。

## 1. 先看结论

我们要做的不是给每个业务模块手写加密，也不是只给 NATS 或 DDS 开 TLS。

推荐方案是：在 `infra/communication` 的 byte payload 层增加一个 `SecureMessageBus`，它包住现有 `MessageBus`。

```text
业务对象
  -> 序列化成 bytes
  -> SecureMessageBus 加密
  -> NATS / DDS / bridge 等真实传输
  -> SecureMessageBus 解密
  -> 反序列化成业务对象
```

这样做的好处：

1. 业务模块不用知道密钥，也不用写加解密代码。
2. Go、Python、C++ 都走同一套 wire format。
3. 可以按 route 或 middleware 开启加密。
4. `infra/communication` 的 Go、Python、C++ 三套 MessageBus 都要具备同等加密能力。

硬约束：

- 不改 `module/` 下的业务代码。
- `module/` 下只允许改配置文件，例如 `config.yaml`、bridge YAML、launch 参数。
- 加密实现代码全部放在 `infra/communication`。
- 测试向量放在 `infra/communication/testdata`。
- 如果发现某条链路绕过了 `infra/communication`，优先在 `infra/communication` 的 bootstrap、fabric、bridge runtime 里补统一入口，而不是去改业务逻辑。

infra 能力范围：

| 范围 | 是否做 | 说明 |
| --- | --- | --- |
| Go MessageBus 加密 | 做 | infra 基础能力 |
| Python MessageBus 加密 | 做 | infra 基础能力 |
| C++ MessageBus 加密 | 做 | infra 基础能力 |
| NATS topic / RPC payload 加密 | 做 | 第一批 transport |
| NATS/ROS2 bridge 的 NATS 侧加密 | 做 | bridge runtime 属于 infra |
| 跨语言 wire format 测试 | 做 | 三语言必须互通 |
| DDS byte payload 加密 | 支持 | 只要经过 `MessageBus` bytes 管道 |
| ROS2 原生 DDS/CDR 加密 | 暂不做 | 使用 DDS Security 或后续单独设计 |
| Dashboard/WebSocket 端到端加密 | 暂不做 | 先用 HTTPS/WSS、鉴权、权限控制 |

## 2. 参考 VLink 的哪些点

VLink 的核心设计是：加密发生在“序列化之后、传输之前”，解密发生在“接收之后、反序列化之前”。

参考资料：

- VLink 安全文档：<https://github.com/thun-res/vlink/blob/master/doc/09-security.md>
- VLink `Security` 接口：<https://github.com/thun-res/vlink/blob/master/include/vlink/extension/security.h>
- VLink `NodeImpl::enable_security`：<https://github.com/thun-res/vlink/blob/master/src/impl/node_impl.cc>
- VLink `SecurityPublisher`：<https://github.com/thun-res/vlink/blob/master/include/vlink/publisher.h>

需要注意：VLink 官网部分文案提到 AES-128-CBC，但 GitHub 文档和源码当前是 AES-GCM AEAD，并支持 RSA-OAEP/PSS、自定义回调、AAD 和 replay window。我们应以 GitHub 文档和源码为准。

Pacific-Rim 不直接照搬 VLink 的 C++ 模板 API。我们已有跨语言通信抽象，所以把能力落在 `MessageBus` 更合适。

## 3. 放在系统哪里

当前仓库已有统一 byte 通信接口：

| 语言 | 当前接口 |
| --- | --- |
| Go | `infra/communication/go/core.MessageBus` |
| Python | `infra/communication/python/.../core.MessageBus` |
| C++ | `infra/communication/cpp/core.MessageBus` |

新增一层：

```text
SecureMessageBus
  inner: MessageBus
  profile: SecurityProfile
  codec: SecurityCodec
```

它仍然实现同一个 `MessageBus` 接口。

调用行为：

| 通信方式 | 发送侧 | 接收侧 |
| --- | --- | --- |
| Pub/Sub publish | 加密 payload | 无 |
| Pub/Sub subscribe | 无 | 解密 payload，再调用 handler |
| RPC client | 加密 request，解密 response | 无 |
| RPC server | 无 | 解密 request，handler 返回后加密 response |

### 为什么放在这里

如果放在业务层，会出现这些问题：

- 每个业务模块都要自己处理密钥。
- mapper、IDL、协议转换会被加密逻辑污染。
- Go/Python/C++ 容易实现不一致。

如果放在 NATS backend 里，也有问题：

- DDS、bridge 以后还要重写一套。
- 同一个 NATS bus 上不同 route 可能需要不同 security profile。

所以最合适的位置是：endpoint/route 绑定时，给对应 `BoundEndpoint` 包一个带 route 上下文的 `SecureMessageBus`。

### 不动 module 代码的边界

本方案要求 `module/` 下业务代码不 import 新的 security 包，也不调用 `Encrypt/Decrypt`。

允许修改：

```text
module/service/*/config.yaml
module/service/*/bridge/**/*.yaml
module/service/*/launch/*.py
```

不允许为了加密而修改：

```text
module/service/*/cmd/**
module/service/*/internal/**
module/service/*/src/**/*.go
module/service/*/src/**/*.py
module/service/*/src/**/*.cpp
module/service/*/src/**/*.hpp
```

如果某个 module 当前通过 `commbootstrap.NewFabric`、`commbootstrap.NewNATSBus` 或 Python bridge 间接创建 NATS 连接，那么加密应在这些 infra 入口里统一接管。

需要重点覆盖的 infra 入口：

| 入口 | 原因 |
| --- | --- |
| `infra/communication/go/core.NewFabric` | Go 服务的 route 绑定主入口 |
| `infra/communication/go/bootstrap.NewFabric` | module 里常用的封装入口 |
| `infra/communication/go/bootstrap.NewNATSBus` | 兼容/兜底 NATS bus 入口 |
| `infra/communication/python/.../core.CommunicationFabric` | Python route 绑定入口 |
| `infra/communication/python/.../ros2/nats_bridge_node.py` | NATS/ROS2 bridge 当前直接使用 nats-py |
| `infra/communication/cpp/core.BootstrapCommunication` | C++ 服务 bootstrap 入口 |

## 4. Infra 要支持哪些链路

这里不按当前 `module/` 服务拆优先级，只讨论 `infra/communication` 必须提供的通用能力。

必须支持：

1. Go `MessageBus` 上的 NATS topic / RPC payload 加密。
2. Python `MessageBus` 上的 NATS topic / RPC payload 加密。
3. C++ `MessageBus` 上的 NATS topic / RPC payload 加密。
4. Go、Python、C++ 三语言共用同一套 envelope wire format。
5. Go、Python、C++ 三语言共用同一份 `security_vectors.json` 测试向量。
6. `communication.security` 配置语义在三语言中一致。
7. NATS/ROS2 bridge 的 NATS 侧加密，因为 bridge runtime 位于 `infra/communication`。
8. DDS byte payload 加密，只要该 DDS 链路经过 `MessageBus` bytes 管道。

暂不支持：

1. ROS2 原生 DDS/CDR 链路的消息级加密。该场景应使用 DDS Security 或后续单独设计。
2. Dashboard/WebSocket 端到端加密。该场景先使用 HTTPS/WSS、鉴权和权限控制。

NATS/ROS2 bridge 的边界如下：

```text
ROS2 可信域                    NATS 跨服务域

ROS2 topic/service  <->  bridge  <->  encrypted NATS subject
   明文                         解密/加密              密文
```

这意味着：

- ROS2 侧仍然是明文。
- bridge 进程能看到明文。
- NATS broker、NATS 订阅者、网络抓包看不到 payload 明文。

如果未来 ROS2 侧也必须保护，应单独接 DDS Security 或设计 ROS2 原生加密方案。

## 5. 配置怎么写

新增 `communication.security.profiles`。

### 5.1 最小配置例子

```yaml
communication:
  security:
    require_explicit_profile: false
    profiles:
      robot_control:
        enabled: true
        algorithm: aes-256-gcm
        key_id: robot-control-v1
        key_env: PR_COMM_SECURITY_ROBOT_CONTROL_KEY
        salt_env: PR_COMM_SECURITY_ROBOT_CONTROL_SALT
        aad_context: pacific-rim.robot-control
        replay_window: 4096
        fail_open: false

  middleware:
    action_ros2:
      transport: ros2
      name: action-service-ros2

    action_nats:
      transport: nats
      name: action-service-nats
      server_url: nats://127.0.0.1:4222
      security_profile: robot_control

  services:
    play_action:
      service_type: action_service/srv/PlayAction
      bindings:
        - transport: ros2_service
          middleware: action_ros2
          service: /action_service_node/play_action
          security_profile: none

        - transport: nats_rpc
          middleware: action_nats
          subject: robot.rpc.play_action
          queue_group: action_service
          queue_size: 20
          security_profile: robot_control
```

解释：

- `action_nats.security_profile: robot_control` 表示这个 NATS middleware 默认启用该加密 profile。
- ROS2 binding 显式写 `security_profile: none`，表示 ROS2 侧不加密。
- NATS RPC binding 使用 `robot_control`。
- `fail_open: false` 表示配置错误时失败，不允许自动降级成明文。

环境变量示例：

```bash
export PR_COMM_SECURITY_ROBOT_CONTROL_KEY="base64-encoded-32-byte-key"
export PR_COMM_SECURITY_ROBOT_CONTROL_SALT="base64-encoded-32-byte-salt"
```

生成开发密钥：

```bash
openssl rand -base64 32
openssl rand -base64 32
```

### 配置继承规则

`security_profile` 的解析规则：

| 写法 | 含义 |
| --- | --- |
| 不写 | 继承 middleware 的 profile |
| `none` 或 `disabled` | 明确关闭 |
| profile 名称 | 使用指定 profile |

同一个 NATS subject 不能同时存在明文端和密文端。否则密文端会拒绝明文，明文端也读不懂密文。

### 5.2 加密开关

需要有一个明确配置控制“启动不启动加密”。建议分两级：

1. profile 级开关：`communication.security.profiles.<name>.enabled`
2. route/middleware 级选择：`security_profile`

profile 开关：

```yaml
communication:
  security:
    profiles:
      robot_control:
        enabled: true
        algorithm: aes-256-gcm
        key_id: robot-control-v1
        key_env: PR_COMM_SECURITY_ROBOT_CONTROL_KEY
        salt_env: PR_COMM_SECURITY_ROBOT_CONTROL_SALT
```

关闭整个 profile：

```yaml
communication:
  security:
    profiles:
      robot_control:
        enabled: false
```

只关闭某条 route：

```yaml
communication:
  services:
    play_action:
      bindings:
        - transport: nats_rpc
          middleware: action_nats
          subject: robot.rpc.play_action
          security_profile: none
```

推荐语义：

| 配置 | 含义 |
| --- | --- |
| `enabled: true` | 该 profile 可用，引用它的 route 会加密 |
| `enabled: false` | 该 profile 不生效 |
| `security_profile: robot_control` | 该 middleware/route 使用 `robot_control` 加密 |
| `security_profile: none` | 明确不加密 |
| 不写 `security_profile` | 继承 middleware 配置 |

启动时行为：

| 场景 | 建议行为 |
| --- | --- |
| route 引用 `enabled: true` 的 profile | 启动，加密生效 |
| route 引用不存在的 profile | 启动失败 |
| route 引用 `enabled: false` 的 profile | 开发环境可按明文处理；生产环境建议启动失败 |
| route 写 `security_profile: none` | 明确明文，允许启动 |
| route 未写 profile，middleware 也未写 | 默认明文；生产环境可通过 `require_explicit_profile` 禁止 |

生产环境建议打开显式声明要求：

```yaml
communication:
  security:
    require_explicit_profile: true
```

含义：

- 所有 NATS route 必须显式写 `security_profile`。
- 要么写具体 profile，例如 `robot_control`。
- 要么写 `none`，表示明确明文。
- 不允许因为漏写配置而意外明文运行。

## 6. 加密包长什么样

我们定义自己的 envelope。业务 payload 不直接发送，发送的是：

```text
header + key_id + ciphertext + tag
```

建议 v1 格式：

```text
magic              4 bytes   "PRSC"
version            1 byte    0x01
algorithm          1 byte    0x01 aes-256-gcm, 0x02 aes-128-gcm
flags              2 bytes
key_id_len         1 byte
sender_id          8 bytes
sequence           8 bytes
nonce              12 bytes
aad_hash           16 bytes
ciphertext_len     4 bytes
key_id             N bytes
ciphertext         M bytes
tag                16 bytes
```

重点字段解释：

| 字段 | 作用 |
| --- | --- |
| `magic` | 判断这是不是 Pacific-Rim 加密包 |
| `version` | 以后升级格式用 |
| `algorithm` | 表示 AES-256-GCM 或 AES-128-GCM |
| `key_id` | 告诉接收方用哪把 key 解密，不是密钥本身 |
| `sender_id` | 标识发送方实例 |
| `sequence` | 防重放 |
| `nonce` | AEAD nonce，同 key 下不能重复 |
| `aad_hash` | 方便排查 AAD 不一致 |
| `tag` | GCM 完整性认证标签 |

第一阶段使用：

```text
AEAD: AES-256-GCM
KDF: HKDF-SHA256
Nonce: 12 bytes
Tag: 16 bytes
Replay window: 4096
```

如果希望和 VLink 默认更接近，也可以支持 AES-128-GCM。建议两个都支持，默认用 AES-256-GCM。

## 7. AAD 是什么

AAD 是“参与认证但不加密”的上下文。它能防止密文被搬到另一个 route 使用。

建议 AAD 由这些字段按固定顺序组成：

```text
pacific-rim|comm-security|v1
profile=<profile>
route=<logical_route>
binding=<binding_name>
transport=<transport>
address=<subject_or_topic>
message_type=<message_type>
direction=<publish|subscribe|rpc_request|rpc_response>
```

例子：

```text
profile=robot_control
route=play_action
binding=action_nats
transport=nats
address=robot.rpc.play_action
message_type=action_service/srv/PlayAction
direction=rpc_request
```

如果发送端和接收端 AAD 不一致，解密必须失败。

RPC 要特别区分：

- client -> server: `direction=rpc_request`
- server -> client: `direction=rpc_response`

这样 request 密文不能被拿来冒充 response。

## 8. 密钥怎么管理

### 8.1 不允许的做法

禁止：

- 密钥写进 Go/Python/C++ 源码。
- 密钥明文写进 YAML。
- 把密钥打印到日志。
- 配置错了自动降级明文。

### 8.2 推荐来源

优先级：

1. KMS/HSM provider。
2. Kubernetes Secret、systemd credential、部署平台 secret。
3. 本地开发用环境变量。

### 8.3 route key 派生

不要直接用 master key 加密所有 route。

每个 route 派生独立 key：

```text
route_key = HKDF-SHA256(
  master_key,
  salt,
  info = "pacific-rim:comm-security:v1:" + profile + ":" + route + ":" + message_type
)
```

好处：

- 不同 route 相互隔离。
- 一个 route 的密文不能直接搬到另一个 route。
- 后续做权限拆分更容易。

### 8.4 key 轮换

轮换时支持“新 key 加密，旧 key 仍可解密”。

配置例子：

```yaml
communication:
  security:
    profiles:
      robot_control:
        enabled: true
        algorithm: aes-256-gcm
        encrypt_key_id: robot-control-v2
        keys:
          - key_id: robot-control-v2
            key_env: PR_COMM_SECURITY_ROBOT_CONTROL_KEY_V2
            salt_env: PR_COMM_SECURITY_ROBOT_CONTROL_SALT_V2
          - key_id: robot-control-v1
            key_env: PR_COMM_SECURITY_ROBOT_CONTROL_KEY_V1
            salt_env: PR_COMM_SECURITY_ROBOT_CONTROL_SALT_V1
            decrypt_only: true
```

轮换流程：

1. 所有服务先部署 v1+v2，仍用 v1 加密。
2. 确认所有服务都能解 v2。
3. 切换 `encrypt_key_id` 到 v2。
4. 观察没有 v1 流量后，移除 v1。

## 9. 代码怎么改

总原则：只改 `infra/communication` 代码，不改 `module/` 业务代码。`module/` 只通过配置打开或关闭 security profile。

### 9.1 Go

建议新增：

```text
infra/communication/go/core/security_config.go
infra/communication/go/core/security_codec.go
infra/communication/go/core/secure_bus.go
infra/communication/go/core/secure_bus_test.go
infra/communication/go/core/security_vectors_test.go
```

职责：

- `security_config.go`: 解析 `communication.security.profiles`。
- `security_codec.go`: envelope 编解码、AES-GCM、HKDF、replay check。
- `secure_bus.go`: 包装 `MessageBus`。
- `security_vectors_test.go`: 读取公共测试向量，保证跨语言一致。

关键点：

- 不建议只在 physical bus 创建时包一层，因为同一个 NATS bus 上不同 route 可能有不同 profile。
- 更稳妥的方式是在 `BoundEndpoint` 绑定时，根据 route metadata 生成 route-aware `SecureMessageBus`。
- `RPCClient` 绑定的是 server endpoint，也要保留 route metadata，否则 AAD 不完整。
- `commbootstrap.NewFabric` 直接委托 `core.NewFabric`，因此只要 `core.NewFabric` 和 route binding 支持 security，`robo_brain_service`、`robo_internal_state_service` 这类 module 不需要改代码。
- `commbootstrap.NewNATSBus` 是兜底入口。它没有 route 上下文，默认不应该自动加密；如果确实要保护这类兜底链路，应提供新的 infra 级选项或要求调用方迁回 `communication` route 配置。不要为了它去改 module 业务代码。

### 9.2 Python

建议新增：

```text
infra/communication/python/pacific_rim_communication_infra/core/security.py
infra/communication/python/pacific_rim_communication_infra/core/security_codec.py
infra/communication/python/pacific_rim_communication_infra/core/secure_bus.py
infra/communication/python/pacific_rim_communication_infra/core/test_secure_bus.py
```

职责和 Go 一致。

Python 还要改 NATS/ROS2 bridge：

```text
infra/communication/python/pacific_rim_communication_infra/ros2/communication_config.py
infra/communication/python/pacific_rim_communication_infra/ros2/nats_bridge_node.py
```

bridge 当前直接用 nats-py，所以不能只改 `core.MessageBus`。必须在 bridge 的 NATS publish、subscribe、request/reply 位置接入同一个 `SecurityCodec`。

这仍然不需要改 `module/` 代码，因为 bridge runtime 文件位于 `infra/communication/python/.../ros2`。`module/service/*/bridge/*.yaml` 只负责声明 `security_profile`。

### 9.3 C++

建议新增：

```text
infra/communication/cpp/core/security.hpp
infra/communication/cpp/core/security_codec.hpp
infra/communication/cpp/core/secure_bus.hpp
```

实现建议：

- 使用和 Go/Python 一致的 AES-GCM、HKDF-SHA256、envelope。
- 不依赖业务 module，配置通过 `service_config.hpp` 进入 routing/bootstrap。
- 和 Go/Python 的 envelope 完全一致。

### 9.4 公共测试向量

新增：

```text
infra/communication/testdata/security_vectors.json
```

里面放固定输入和期望输出：

- profile。
- key/salt。
- route metadata。
- plaintext。
- sender_id、sequence、nonce。
- expected envelope hex。
- 篡改用例。

三语言都读这一份，避免实现漂移。

## 10. 测试怎么验收

### 10.1 单元测试

必须覆盖：

1. 正常 encrypt/decrypt。
2. 错 key 解密失败。
3. 错 AAD 解密失败。
4. ciphertext 被篡改后失败。
5. tag 被篡改后失败。
6. replay 被拒绝。
7. unknown key_id 被拒绝。
8. key rotation 可用。
9. 空 payload 行为三语言一致。
10. malformed envelope 不 panic。

### 10.2 跨语言测试

必须覆盖：

- Go 加密，Python 解密。
- Python 加密，Go 解密。
- Go 加密，C++ 解密。
- C++ 加密，Go 解密。
- Python 加密，C++ 解密。
- C++ 加密，Python 解密。

### 10.3 NATS 集成测试

必须覆盖：

- secure publisher + secure subscriber 成功。
- secure RPC client + secure RPC server 成功。
- secure client + plain server 失败，且不调用 handler。
- plain client + secure server 失败，且不调用 handler。
- 两个 route 使用不同 profile，互不解密。

### 10.4 Bridge 集成测试

必须覆盖：

- ROS2 topic -> bridge -> encrypted NATS。
- encrypted NATS -> bridge -> ROS2 topic。
- encrypted NATS RPC -> bridge -> ROS2 service -> encrypted response。
- bridge 解密失败时不写入 ROS2。

## 11. 观测和排错

安全日志必须结构化，但不能记录明文和密钥。

建议日志字段：

```text
event=comm_security_decrypt_failed
route=play_action
binding=action_nats
transport=nats
address=robot.rpc.play_action
profile=robot_control
key_id=robot-control-v1
reason=auth_tag_mismatch | replay | unknown_key_id | aad_mismatch | malformed_envelope
sender_id=...
sequence=...
trace_id=...
```

建议 metrics：

- `comm_security_encrypt_total{profile,route,result}`
- `comm_security_decrypt_total{profile,route,result,reason}`
- `comm_security_replay_rejected_total{profile,route}`
- `comm_security_unknown_key_total{profile,route,key_id}`
- `comm_security_payload_bytes{profile,route,stage=plain|cipher}`

trace 中只记录：

- `security.enabled`
- `security.profile`
- `security.key_id`
- `security.algorithm`
- `security.decrypt_result`

不要记录：

- plaintext。
- ciphertext。
- key。
- 完整 nonce。

## 12. 迁移策略

不能让同一个 subject 长期同时跑明文和密文。

可选迁移方式：

### 方式一：停机切换

适合机器人控制 RPC。

步骤：

1. 所有服务发布支持加密的新版本，但先不开启。
2. 停服务。
3. 同时打开相关 NATS route 的 `security_profile`。
4. 启动服务。
5. 验证 RPC 和 topic 正常。

### 方式二：新 subject 灰度

适合风险较高的链路。

例子：

```text
robot.rpc.play_action
robot.rpc.play_action.secure
```

灰度完成后移除旧 subject。

### 方式三：临时明密桥

只建议短期使用。

```text
明文 subject -> migration bridge -> 密文 subject
```

桥能看到明文，因此不能作为长期架构。

## 13. 分阶段计划

### Phase 0: 文档和格式冻结

产出：

- 本文档评审通过。
- wire format 确认。
- 配置字段确认。
- 第一批加密 route 清单确认。

### Phase 1: 三语言 SecurityCodec

产出：

- Go `SecurityCodec`。
- Python `SecurityCodec`。
- C++ `SecurityCodec`。
- `security_vectors.json`。
- 三语言读取同一份测试向量。
- 不修改 `module/service/*` 业务代码。

验收：

- Go/Python/C++ 三语言跨语言互通。
- 错 key、错 AAD、replay 全部失败。
- envelope 编解码、AAD、HKDF、nonce、tag 校验语义一致。

### Phase 2: 三语言 SecureMessageBus

产出：

- Go `SecureMessageBus`。
- Python `SecureMessageBus`。
- C++ `SecureMessageBus`。
- Go/Python/C++ 的 service config、routing、bootstrap 都支持 `communication.security`。
- NATS pub/sub 和 RPC 集成测试。

验收：

- 三语言 MessageBus 都可以通过配置启用加密。
- `enabled`、`security_profile`、`none`、`require_explicit_profile` 语义一致。
- 不存在自动明文降级。
- secure client/server 可以互通，secure/plain 混用会失败。

### Phase 3: NATS/ROS2 bridge 接入

产出：

- bridge 的 NATS publish/subscribe/RPC 接入 security codec。
- bridge 配置继承 `communication.security`。
- bridge 集成测试。
- 只改 infra bridge runtime；module bridge YAML 只加配置。

验收：

- ROS2 侧明文，NATS 侧密文。
- NATS 抓包无法读取 payload。
- bridge 解密失败不会写入 ROS2。

### Phase 4: 生产化

产出：

- key rotation。
- metrics 和告警。
- KMS/HSM provider 接口。
- NATS subject ACL 建议配置。
- 性能基准报告。

验收：

- 灰度部署完成。
- 可观测指标稳定。
- 密钥轮换演练通过。

## 14. 风险和处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 三语言 wire format 不一致 | 跨语言通信失败 | 强制使用 `security_vectors.json` |
| 同 subject 明密混用 | 消息丢失 | 启动校验，禁止 fail-open |
| replay window 误伤重发 | 可靠传输下消息被拒 | 按 NATS/DDS 行为压测，必要时调整 replay 策略 |
| 加密增加延迟 | 控制链路抖动 | 高频链路压测，优先 AES-GCM，避免 RSA 热路径 |
| bridge 能看到明文 | bridge 成为安全边界 | 限制 bridge 权限，必要时叠加 ROS2/DDS 安全 |
| 密钥泄露 | 全链路失守 | Secret/KMS、最小权限、轮换、日志脱敏 |

## 15. 最终建议

采用 VLink 的消息级加密思想，但按 Pacific-Rim 的架构落到 `MessageBus` byte 层。

落地顺序：

1. 先冻结 wire format、配置语义和测试向量。
2. Go、Python、C++ 同时实现 `SecurityCodec`。
3. Go、Python、C++ 同时实现 `SecureMessageBus` 和配置接入。
4. bridge 作为明确安全边界处理。
5. 最后做 key rotation、KMS/HSM 和生产观测。

这条路径把加密能力收敛在 `infra/communication`，保证 Go、Python、C++ 三套通信栈能力一致，也不会把加密逻辑扩散到业务模块。
