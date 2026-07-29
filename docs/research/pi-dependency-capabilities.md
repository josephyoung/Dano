# Pi 依赖能力核验（Dano #58）

核验日期：2026-07-29

本文只回答 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` **已经提供什么、哪些入口属于稳定公开 API、哪些实现只能在包内部看到**。本文不判断 Dano 的具体实现应删除、替换还是保留；一旦复用需要依赖非公开 API，必须先与用户讨论。

## 结论摘要

1. Dano 当前直接固定 `@earendil-works/pi-coding-agent@0.80.2`，由它传递引入 `@earendil-works/pi-ai@0.80.2`。截至核验时，npm `latest` 中两者均为 `0.82.1`，来自同一上游提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`。
2. `pi-ai` 是 provider/model/auth/LLM stream 层；`pi-coding-agent` 在其上提供 AgentSession、会话树、工具与扩展、自动重试/压缩，以及 CLI/RPC 运行模式。两层不是互相替代关系。
3. Dano 可稳定复用的核心入口包括：
   - `pi-ai` 的 `Models`/`Provider`、凭据存储契约、provider-owned auth、模型发现、stream/complete、公开重试与超时选项；
   - `pi-coding-agent` 的 `createAgentSession`、`AgentSession`、`AgentSessionRuntime`、`SessionManager`、`ModelRuntime`、`SettingsManager`、工具/扩展 API，以及 `RpcClient`、`runRpcMode` 和 RPC 协议类型。
4. RPC 边界必须特别区分：`RpcClient` 是**启动子进程**的客户端；`runRpcMode` 是**接管当前进程 stdin/stdout** 的 JSONL 循环。真正执行 `RpcCommand` 的 `handleCommand` 是 `runRpcMode` 内部闭包，没有公开的进程内 dispatcher/handler。
5. 因而最新稳定 API 只明确支持两种集成方式：
   - 通过 `RpcClient`/CLI 以子进程使用现成 RPC；
   - 在同一进程直接调用 `AgentSession`/`AgentSessionRuntime`，由宿主自行投影 HTTP/SSE。

   若目标是“在 Dano 进程内直接复用 Pi 的完整 RPC command dispatcher”，当前没有稳定公开 API。是否依赖内部文件、请求上游开放 API，或保留 Dano 的协议适配层，都必须另行讨论，本文不作决定。
6. `0.80.2` 与 `0.82.1` 都没有公开“按 ID/索引删除一条 pending queue message”的 API 或 RPC command。公开 API 只有读取 steering/follow-up 文本队列、整队清空和 queue mode；这项缺口必须讨论，不能擅自用内部数组或“清空后重排”冒充等价能力。

## 版本与依赖关系

| 项目 | Dano 当前状态 | npm `latest`（核验时） | 证据 |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 直接依赖，精确固定 `0.80.2` | `0.82.1`，发布时间 2026-07-25 | [Dano package.json](../../apps/dano/package.json#L18-L25)、[npm 0.80.2 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/0.80.2)、[npm dist-tags](https://registry.npmjs.org/-/package/@earendil-works%2Fpi-coding-agent/dist-tags)、[npm 0.82.1 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/0.82.1) |
| `@earendil-works/pi-ai` | 由 coding-agent 传递引入并锁定 `0.80.2` | `0.82.1`，发布时间 2026-07-25 | [Dano lockfile](../../pnpm-lock.yaml#L2219-L2223)、[npm 0.80.2 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-ai/0.80.2)、[npm dist-tags](https://registry.npmjs.org/-/package/@earendil-works%2Fpi-ai/dist-tags)、[npm 0.82.1 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-ai/0.82.1) |

`pi-coding-agent@0.82.1` 声明依赖 `pi-ai@^0.82.1`、`pi-agent-core@^0.82.1` 和 `pi-tui@^0.82.1`；Dano 当前锁文件中的 `0.80.2` 也保持四个 Pi 包同版本。[0.82.1 package.json](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/package.json#L1-L101)

本报告以 npm 实际发布物的 `exports` 与 `.d.ts` 为公开边界，并用发布物 `gitHead` 对应的不可变 GitHub 提交作源码引用。不能因为某个文件存在于 `dist/` 中，就把它当成可导入的公开 API。

## 两个包各自负责什么

### `pi-ai`：统一 LLM/provider 层

`pi-ai` 的 `Provider` 是运行时单元，拥有模型目录、认证和 stream 行为；`Models` 负责在 providers 之间查询模型、认证并路由 stream/complete 请求。[Provider 与 Models 接口](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/src/models.ts#L66-L200)

它提供：

- provider 工厂、内建与动态模型目录；
- `CredentialStore`/认证交互协议及 API key、OAuth 等 provider-owned auth；
- `stream`、`complete`、`streamSimple`、`completeSimple` 与统一的事件/消息类型；
- tool schema、参数验证和 tool-call/result 消息类型；
- AbortSignal、请求超时、WebSocket 连接超时、请求重试等模型调用选项。

`pi-ai` 不负责执行完整 agent/tool loop。官方 quick start 在收到 tool call 后由调用者执行工具、把 tool result 放回 context，再次调用 model stream；这说明工具循环归宿主或上层 agent 所有。[Tool call quick start](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/README.md#L98-L226)

### `pi-coding-agent`：coding agent/session/tool/run-mode 层

`pi-coding-agent` 构建在 `pi-ai` 和 `pi-agent-core` 之上，负责 coding agent 的完整生命周期：session、上下文压缩、模型切换、工具执行、扩展、设置、自动重试，以及交互/print/RPC 等运行模式。官方 SDK 文档明确把 `createAgentSession`、`AgentSession`、`SessionManager` 和 `ModelRuntime` 作为同进程嵌入入口。[SDK quick start](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/sdk.md#L1-L30)

## 最新稳定版公开 API

### `@earendil-works/pi-ai@0.82.1`

包的公开 subpath 是 `.`、`./api/*`、`./providers/*`、`./oauth`、`./compat`、`./bun-oauth` 和 `./bedrock-provider`。[package exports](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/package.json#L1-L93)

| 能力 | 稳定公开入口 | 能力边界 |
| --- | --- | --- |
| Provider 与模型目录 | `Provider`、`Models`、`MutableModels`、`createModels`、provider subpaths | 查询 provider/model，刷新动态目录，检查可用性；provider 负责 auth 和 stream 行为。 |
| 模型目录持久化 | `ModelsStore`、`InMemoryModelsStore` 等 root export | 可由宿主提供模型目录存储；具体 provider/model 组合仍经公开 facade 操作。 |
| 凭据与认证 | `CredentialStore`、`InMemoryCredentialStore`、`AuthInteraction`、`ProviderAuth`、auth helpers/context | 宿主可以提供凭据存储，并通过 provider 的 `getAuth`/login/logout 流程认证；API key 不必泄露给浏览器。 |
| LLM 调用 | `Models.stream/complete/streamSimple/completeSimple`、`AssistantMessageEventStream` | 提供统一流式和非流式调用，不包含完整 agent/tool loop。 |
| 工具协议 | `Tool`、TypeBox schema、validation helpers、tool-call/result 类型 | 定义和校验工具参数；实际工具执行及继续模型调用由上层负责。 |
| 取消、超时、请求重试 | stream options 中的 `signal`、`timeoutMs`、`websocketConnectTimeoutMs`、`maxRetries`、`maxRetryDelayMs`；root export 的 `retryAssistantCall`、`isRetryableAssistantError`、`RetryPolicy`、`RetryCallbacks` | provider 请求级控制和一个公开的 assistant-call 重试 helper；不等于 coding-agent 的整轮 agent 自动重试。 |

根入口的实际导出可由 [pi-ai `src/index.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/src/index.ts#L1-L47) 核对；stream 配置定义见 [`types.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/src/types.ts#L115-L190)，公开重试 helper 见 [`utils/retry.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/src/utils/retry.ts)。

### `@earendil-works/pi-coding-agent@0.82.1`

包只公开 `.` 与 `./rpc-entry`。后者是可执行 RPC 启动入口，类型声明不导出符号；其他 `dist/core/*` 或 `dist/modes/*` 文件即使被打包，也不是 package exports 允许的稳定 deep import。[package exports](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/package.json#L1-L24)

| 能力 | 稳定公开入口 | 与 Dano 服务端相关的边界 |
| --- | --- | --- |
| Agent 创建与生命周期 | `createAgentSession`、`createAgentSessionServices`、`createAgentSessionRuntime`、`AgentSession` | 提交 prompt，订阅流式事件，steer/follow-up，abort/wait idle，切换模型和 thinking，压缩、统计、工具状态及自动重试控制。队列只公开整队 `clearQueue()` 和只读文本 getters，没有单项删除。 |
| 同进程 session 替换 | `AgentSessionRuntime` | `newSession`、`switchSession`、`fork`、`importFromJsonl`；切换时负责销毁和重建 cwd-bound services。 |
| 会话存储与树 | `SessionManager` 及公开 session entry/tree/context 类型 | 创建、打开、继续、内存会话，读写 JSONL entry，分支/树/context 构建。 |
| 模型/provider/auth facade | `ModelRuntime`（最新规范入口）、`ModelRegistry`（兼容 facade） | `ModelRuntime` 实现 `pi-ai Models`，公开模型/provider 查询、auth 状态、login/logout、runtime API key、stream/complete、provider 注册和 catalog refresh。 |
| 设置与重试 | `SettingsManager`、`RetrySettings`、`CompactionSettings` 等 root export | 对外提供设置读取/更新、agent 自动重试、provider 请求重试、HTTP idle/WebSocket connect timeout 以及默认 provider/model 等方法。 |
| 工具 | `createCodingTools`、`createReadOnlyTools`、`createReadTool`/`createBashTool`/`createEditTool` 等工厂；tool definitions/operations/types | 可以复用现成 read/bash/edit/write/find/grep/ls 工具，也能注入宿主 operations。 |
| 扩展 | `defineTool`、`ExtensionRunner`、`createExtensionRuntime`、`discoverAndLoadExtensions`、resource/package loaders 及 extension 类型 | 提供工具注册、hooks、命令/资源发现与运行时扩展机制。 |
| RPC | `RpcClient`、`runRpcMode`、`RpcCommand`、`RpcResponse`、`RpcSessionState` | 完整 JSONL 子进程协议和类型是公开 API；进程内 dispatcher 不是。 |

根导出的权威清单见 [`src/index.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/index.ts#L15-L344)，SDK 导出说明见 [`docs/sdk.md`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/sdk.md#L1134-L1184)。

## RPC / run-mode 专项核验

### 协议类型与命令确实公开

`RpcCommand` 和 `RpcResponse` 从包根导出。最新 `RpcCommand` 包含：

- prompt、steer、follow-up、abort；
- `new_session`、`switch_session`、fork/clone；
- `get_state`、`get_messages`、`get_entries`、`get_tree`、`get_session_stats`；
- model/thinking/queue mode 控制；
- compact/retry/bash/export/command discovery。

`get_state` 的响应是 `RpcSessionState`；`get_messages` 返回 `AgentMessage[]`；`switch_session` 返回是否被扩展取消。命令与响应联合类型的权威定义见 [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L231)。这三个本次点名核验的命令在 Dano 当前固定的 `0.80.2` 发布物中已经存在；`get_entries`/`get_tree` 和 thinking-level discovery 是后续版本新增，不能反推为 `0.80.2` 能力。

### `RpcClient` 是子进程客户端

`RpcClient` 的公开方法覆盖 `getState()`、`getMessages()`、`switchSession()` 及其他 RPC 命令。但 `start()` 的实现会 spawn Node CLI，并附加 `--mode rpc`；它不是把命令直接分发给当前进程中的 `AgentSession`。[`RpcClient` 实现](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/rpc/rpc-client.ts#L55-L139)

### `runRpcMode` 是 stdio JSONL 运行循环

公开的 `runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>` 会：

1. 监听 `AgentSession` 事件并序列化到 stdout；
2. 从当前进程 stdin 按行解析 `RpcCommand`；
3. 调用其内部命令 switch；
4. 一直运行到 stdin 关闭或进程终止。

它不是一个可传入单条命令并取得 `RpcResponse` 的无传输 dispatcher，也不适合在不接管 stdio 的同进程 HTTP handler 中直接调用。[`runRpcMode` 与内部命令 switch](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L384-L700)、[stdio 循环](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L702-L800)

### 没有公开的进程内 RPC dispatcher

负责 `get_state`、`get_messages`、`switch_session` 等命令的 `handleCommand` 是 `runRpcMode` 函数内部的 `const` 闭包，没有 export。JSONL helper 也没有从包根导出。因为 coding-agent 的 package exports 只允许 `.` 和 `./rpc-entry`，宿主不能把 `dist/modes/rpc/rpc-mode.js` 或 `jsonl.js` 当成受支持的 deep import。

`./rpc-entry` 只用于启动 RPC 进程：其声明文件是空模块，不能获得 dispatcher。它从 `0.80.3` 起才作为 package subpath 提供。[0.80.3 changelog](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L332-L348)

**必须讨论的边界：**如果 Dano 要复用的不是 RPC 协议类型，而是 Pi 内部那段完整命令分发实现，则当前没有稳定公开 API。不能擅自选择 deep import、复制源码、patch 依赖或改成子进程架构。

## 队列单项删除专项核验

结论是 **没有公开 API**，且 Dano 当前的 `0.80.2` 与最新稳定 `0.82.1` 结论相同：

- `AgentSession` 公开 `steer()`、`followUp()`、`clearQueue()`、`pendingMessageCount`、`getSteeringMessages()` 和 `getFollowUpMessages()`；其中 `clearQueue()` 会同时清空所有 steering/follow-up，并且 getters/返回值只有 `string[]`，不提供可稳定寻址的 message ID。[0.82.1 `AgentSession` queue API](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L1335-L1533)、[0.80.2 对应源码](https://github.com/earendil-works/pi/blob/ec6311beb5b24fc918e5031173608447582d7262/packages/coding-agent/src/core/agent-session.ts#L1218-L1415)
- `RpcCommand` 没有 `remove_queue_item`、`delete_queued_message`、`clear_queue` 等命令；`get_state` 只返回 `pendingMessageCount`，`queue_update` 事件只给出两个只读文本数组。[RPC command types](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L108)
- 更底层的公开 `pi-agent-core Agent` 也只有 `clearSteeringQueue()`、`clearFollowUpQueue()` 和 `clearAllQueues()`，没有删除单条消息的方法。[Agent queue API](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent.ts#L276-L299)

不能把“先 `clearQueue()`，再把未删除项逐一重新 enqueue”认定为等价的稳定能力：公开读接口只有文本，会丢失图片等消息内容，并且清空与重排会改变并发时序和队列语义。若 Dano 需要单项删除，必须与用户讨论要请求上游 API、调整产品能力，还是保留一层宿主自有队列。

## 存在于源码/发布物但不属于稳定公开 API

| 能力/符号 | 为什么不能视为稳定 API | 处理要求 |
| --- | --- | --- |
| RPC `handleCommand` | `runRpcMode` 内部闭包，无 export | 必须与用户讨论 |
| RPC `attachJsonlLineReader`、`serializeJsonLine` 等 helper | 未从包根导出，且 package exports 不允许该 deep import | 必须与用户讨论 |
| pending queue 单项删除/可寻址 queue entry | coding-agent 和 RPC 都没有公开能力；内部队列没有公开稳定 ID | 必须与用户讨论 |
| `pi-ai` 的 `retryProviderRequest` | 位于 `utils/provider-retry.ts`，没有被 root index 导出，package exports 也没有 `./utils/*` | 必须与用户讨论；优先只把公开 stream options/重试 helper 作为已验证能力 |
| coding-agent 内部 provider composer、remote catalog、models.json 解析实现 | 文件在 `dist/core`，但包未开放对应 subpath；应经 `ModelRuntime` 使用 | 必须与用户讨论后才能越过 facade |
| `ModelRuntime.getCompatibilityRequestConfig` | 声明中标记 `@internal`，供 `ModelRegistry` 兼容路径使用 | 不应作为新集成点；若确有需求必须讨论 |
| `AuthStorage`、`FileAuthStorageBackend`、`InMemoryAuthStorageBackend`（最新） | `0.80.2` 时是 root export；`0.80.8` 明确从公共 API 移除。最新根入口只公开 `readStoredCredential`，推荐通过 `ModelRuntime` 或 `pi-ai CredentialStore` | 升级审计时必须处理，不得按旧 API 假设最新仍稳定 |
| raw `Settings`/storage backend 实现 | `SettingsManager` 是 root export，但底层实现类型并未全部从根导出 | 经 `SettingsManager` 使用；需要底层存储接口时必须讨论 |

## 从 Dano 固定版到最新稳定版的相关变化

这部分只说明 API 演进，不构成升级或迁移决定。

- `0.80.3`：增加 `get_entries`/`get_tree`，并开放 `./rpc-entry` 子路径；Dano 固定的 `0.80.2` 没有该 subpath，尽管根入口已经公开 `RpcClient`/`runRpcMode` 和主要 RPC 类型。[changelog](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L332-L348)
- `0.80.8`：`ModelRuntime` 成为 coding-agent 与 SDK 的规范模型/provider/auth facade；`ModelRegistry` 保留为扩展兼容 facade；旧 `AuthStorage` 公共 API 被移除。[changelog](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L168-L197)
- `0.81.0`：完成基于 `pi-ai` provider 的扩展与 thinking-level 查询能力。[changelog](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L89-L105)
- `0.81.1` 至 `0.82.0`：继续完善压缩/分支摘要重试、RPC bash streaming correlation，以及 retry wait 的取消行为。[0.81.1](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L71-L86)、[0.82.0](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L30-L63)
- `0.82.1` 是本次核验的最新稳定发布，包含进一步的 provider/model 与 session 修复。[changelog](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/CHANGELOG.md#L3-L28)

## 可供下一阶段逐项对照的稳定能力边界

后续审查 Dano 是否重复实现时，可以按以下边界逐项比较，但每一项仍需结合 Dano 的浏览器 HTTP/SSE、安全隔离和产品语义判断：

1. provider/model discovery 与配置：优先对照 `pi-ai Models` 和 coding-agent `ModelRuntime`。
2. server-side credentials/auth/API key：优先对照 `pi-ai CredentialStore` 与 `ModelRuntime` 的公开认证方法。
3. model streaming、请求取消、超时与 provider retry：优先对照 `pi-ai` stream options 和公开 retry helper。
4. agent turn、工具循环、自动重试/压缩：优先对照 `AgentSession`。
5. JSONL 会话树、switch/fork/context：优先对照 `SessionManager` 与 `AgentSessionRuntime`。
6. read/bash/edit/write/find/grep/ls 和扩展工具：优先对照公开 tool factories、`defineTool` 和 `ExtensionRunner`。
7. RPC wire contract：可以直接依赖公开的 `RpcCommand`/`RpcResponse` 类型；但 Dano 的 HTTP/SSE transport adapter 不等于 Pi 已公开一个可嵌入 dispatcher。

任何对照项一旦只能通过本报告“非公开 API”表中的能力实现，应停止并与用户讨论，不能自行选方案。
