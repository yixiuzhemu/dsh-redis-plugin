# dsh-redis-plugin

**语言：** [English](./README.md) | 简体中文

> DeepSeek Harness（**dsh**）Redis 插件——连接管理、编解码、线程池治理、查询操作、
> 带看门狗续约的分布式锁，以及模型可见工具。

`dsh-redis-plugin` 是一个基础性的 [Cordis](https://cordis.js.org) 风格 dsh 插件，
为其它所有插件（以及模型本身）提供对 Redis 实例的、安全且受治理的访问能力。它基于
**ioredis** 构建，对外暴露一个扁平的、基于 Promise 的 `ctx.redis` 服务，并把所有资源
注册为**可逆 effect**，从而让 HMR / 卸载能够干净地回滚（连接、定时器、工具）。

其设计是把 `spring-boot-starter-data-redis-reactive` 与一个 Java `redis-utils`
辅助库中的「连接 + 编解码 + 查询」模式移植到 Node/TypeScript，并适配 dsh 的
「一切皆插件」运行时。详见 [`DESIGN.md`](./DESIGN.md)。

---

## 快速开始

```bash
dsh plugin --profile <profile-name> add dsh-redis-plugin   # 零配置——直接用 ctx.redis
```

开箱即用——**当未指定 host/port 时，插件默认连接 `127.0.0.1:6379`、db `0`、无密码。**
该默认值在三层都有兜底（`cordis.patch.yml` → `config.ts` → `factory.ts`），并由
`config` / `factory` 单元测试覆盖。

### 修改 host / port

无需改代码——任选一种：

1. **环境变量（推荐）。** 设置 `REDIS_HOST` / `REDIS_PORT`：
   ```bash
   export REDIS_HOST=192.168.4.189   # bash / zsh
   export REDIS_PORT=6380
   ```
   ```powershell
   $env:REDIS_HOST = '192.168.4.189'   # PowerShell
   $env:REDIS_PORT = '6380'
   ```
2. **`.env` 文件。** 把 `.env.example` 复制为 `.env`，设置 `REDIS_HOST` / `REDIS_PORT`。
3. **单个 URL。** 设置 `REDIS_URL=redis://192.168.4.189:6380/0`——它会整体覆盖
   host/port/db/password。
4. **`cordis.patch.yml`。** 把 `!!js` 表达式换成字面量（`host: 192.168.4.189`、
   `port: 6380`）。这会把地址提交进仓库——除了固定的本地默认值，优先用 1–3。

完整变量列表与优先级：[多环境](#多环境dev--test--uat--prod)。

---

## 特性

- **连接层**——带连接池与健康检查的连接工厂。当前已实现 `standalone`；`sentinel`
  与 `cluster` 是预留扩展点，采用「fail loud（明确报错）」而非静默误连。
- **编解码**——可插拔的 key/value 序列化器，对标 Spring 的 `StringRedisSerializer`
  （key）与 `GenericJackson2JsonRedisSerializer`（value，可选 `@type` 类型提示以支持
  `Date` / `Map` / `Set` / `Buffer` 往返）。
- **线程池治理**——一个有界的 `TaskExecutor`（Node 版的 Java `ThreadPoolExecutor`：
  core → queue → max → reject）包裹每条命令，提供准入控制、单任务超时，以及仅针对
  幂等命令的指数退避重试。阻塞 / 发布订阅流量走专用连接。
- **查询操作**——覆盖 key / string / hash / list / set / zset / pipeline 的扁平、
  强类型 API，外加 `scan`（绝不使用 `KEYS`）与 `batchSearch`。
- **分布式锁 + 看门狗**——原子的 `SET NX PX` 加锁、token 守卫的 Lua 解锁/续约，以及
  周期性看门狗为本进程持有的锁续约，使长临界区不会因 TTL 过期而丢锁。
- **模型可见工具**——12 个受权限门保护的工具（`redis_get`、`redis_set`……），让模型
  能直接读写 Redis；破坏性操作通过 `tools/pre-execute` 权限门拦截。

---

## 安装

在 dsh 工作区内，把该 bundle 添加到某个 profile：

```bash
dsh plugin --profile <profile-name> add dsh-redis-plugin
```

或作为你自己插件的普通 npm 依赖安装：

```bash
npm install dsh-redis-plugin
```

`@deepseek-ai/*` SDK 包（`cordis`、`dsh-tools`、`schemastery`）是**可选 peer 依赖**，
由 dsh 宿主在部署时提供。与框架无关的核心（`dsh-redis-plugin/core`）不依赖任何 SDK，
可作为独立库使用。

---

## 配置

配置在插件的 `cordis.patch.yml` 条目中声明（或直接传给 `apply`）。每个字段都是可选的
——仅一行 `- name: dsh-redis-plugin` 也能用下面的默认值工作。随包的 `cordis.patch.yml`
从 `REDIS_*` 环境变量读取连接信息（见[多环境](#多环境dev--test--uat--prod)），
因此不会把任何 host/port/密钥硬编码进仓库。

```yaml
- id: redis
  name: dsh-redis-plugin
  config:
    connection:
      topology: standalone            # standalone | sentinel | cluster（仅实现 standalone）
      # url 一旦存在即优先于 host/port/db/password：
      url: !!js "process.env.REDIS_URL || undefined"
      host: !!js "process.env.REDIS_HOST || '127.0.0.1'"
      port: !!js "Number(process.env.REDIS_PORT || 6379)"
      password: !!js "process.env.REDIS_PASSWORD || undefined"
      db: !!js "Number(process.env.REDIS_DB || 0)"
    pool:
      min: 2
      max: 16
      idleTimeoutMs: 30000
      healthCheckMs: 15000            # 0 表示禁用 PING 健康检查
    executor:
      coreSize: 8
      maxSize: 32
      queueCapacity: 1024
      keepAliveMs: 60000
      timeoutMs: 3000                 # 单命令超时
      rejectPolicy: abort             # abort | discardOldest | callerRuns
      retry:
        maxAttempts: 3                # 仅幂等命令
        backoffMs: 200
    codec:
      keyPrefix: ''                   # 所有 key 的可选命名空间前缀
      value: json                     # json | string | raw
      typeHint: false                 # 内嵌 @type 以支持 Date/Map/Set/Buffer 往返
      offloadThresholdBytes: 1048576
    lock:
      defaultTtlMs: 30000
      watchdogIntervalMs: 1000
      renewAheadMs: 10000             # 剩余 TTL 小于该值时续约
      releaseOnDispose: false         # true = 关闭时主动释放锁
    tools:
      enabled: true                   # 注册模型可见工具
      allowDestructive: false         # 用 pre-execute 权限门保护 redis_del
```

### 多环境（dev / test / uat / prod）

连接是**环境变量驱动**的：`cordis.patch.yml` 通过加载器的 `!!js` 标签从 `REDIS_*`
环境变量解析每个字段，因此切换环境只需注入不同的值——**永远不必改代码**。把
[`.env.example`](.env.example) 复制为 `.env`（已被 git 忽略），或在部署流水线中设置这些变量。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `REDIS_ENV` | 环境标签（`dev`/`test`/`uat`/`prod`）；启动时打印，未知值会告警。它**本身不改变地址**。 | `default` |
| `REDIS_URL` | 完整连接 URL。**一旦设置，优先于 host/port/db/password。** | _(未设)_ |
| `REDIS_HOST` / `REDIS_PORT` | 离散地址。 | `127.0.0.1` / `6379` |
| `REDIS_PASSWORD` / `REDIS_DB` | 认证 + 逻辑库。 | _(无)_ / `0` |
| `REDIS_KEY_PREFIX` | 可选的 key 命名空间——当多个环境**共用**一台 Redis 时推荐设置，避免 key 冲突。 | _(无)_ |

**优先级：** `REDIS_URL` → `REDIS_HOST/PORT/PASSWORD/DB` → 内置默认
（`127.0.0.1:6379/0`）。每个环境只需导出各自的值，例如：

```bash
# test 环境
export REDIS_ENV=test
export REDIS_HOST=redis.test.internal
export REDIS_PORT=6379
export REDIS_PASSWORD=<from-secret-manager>
export REDIS_DB=1
export REDIS_KEY_PREFIX=test:
```

启动时插件会打印解析出的环境与目标地址，例如：
`[dsh-redis-plugin] ready (env=test, topology=standalone, target=redis.test.internal:6379/1, tools=on)`。
原始 URL 绝不会被打印（它可能携带凭据）。

#### 如何设置环境变量

插件只在 dsh 宿主加载时读取 `process.env`，因此任何标准方式都可以。按你的运行环境任选其一：

**1. 本地 `.env` 文件（开发推荐）。** 复制模板并编辑；`.env` 已被 git 忽略，密钥只留在本地：

```bash
cp .env.example .env
```

dsh 宿主会自动加载 `.env`。若你在 dsh 之外使用与框架无关的 `core`，需自行加载——
`node --env-file=.env …`（Node ≥ 20）或 `dotenv`。

**2. PowerShell（Windows）**——仅对当前 shell 生效：

```powershell
$env:REDIS_ENV      = 'test'
$env:REDIS_HOST     = '192.168.4.189'
$env:REDIS_PORT     = '6379'
$env:REDIS_PASSWORD = '<from-secret-manager>'
$env:REDIS_DB       = '1'
```

如需按用户持久化，用 `[Environment]::SetEnvironmentVariable('REDIS_HOST', '…', 'User')`。

**3. bash / zsh（Linux 与 macOS）：**

```bash
export REDIS_ENV=prod
export REDIS_HOST=prod-redis.internal
export REDIS_PASSWORD="$(secret-tool lookup redis prod)"
```

**4. Docker / docker-compose：**

```yaml
services:
  app:
    environment:
      REDIS_ENV: prod
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_PASSWORD: ${REDIS_PASSWORD}   # 由宿主 env / .env 注入，绝不硬编码
```

**5. CI/CD**——设置为流水线 / 密钥变量（GitHub Actions 的 `env:` + `secrets.*`、
GitLab CI/CD 变量等）。切勿提交真实凭据；应引用密钥管理系统。

> 由于 `@deepseek-ai/*` 是部署期 peer 依赖、且 `!!js` 标签由 dsh 加载器求值，
> 这套环境变量解析发生在宿主的加载阶段。若要在本地对真实服务器做端到端验证，
> 见 [`scripts/run-live.ps1`](scripts/run-live.ps1) + `test/live.integration.test.ts`。

---

## 在其它插件中使用

声明 `inject: ['redis']` 并消费强类型的 `ctx.redis` 服务：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['redis']

export function apply(ctx: Context) {
  ctx.effect(() => {
    // 写入
    void ctx.redis.set('user:1', { id: 1, name: 'ada' }, { ex: 60 })

    // 读取（会被 JSON 解码回对象）
    void ctx.redis.get<{ id: number; name: string }>('user:1').then((user) => {
      ctx.logger.info('user=%o', user)
    })

    // 带自动看门狗续约的分布式锁
    void ctx.redis.lock.withLock('order:42', async () => {
      // ... 临界区；锁会被持续续约并始终释放
    })
  })
}
```

由于本插件对 Cordis 的 `Context` 类型做了增强，一旦你加上 `inject: ['redis']`，
`ctx.redis` 就是完整强类型的。

---

## API 参考（`ctx.redis` / `createRedis()`）

该服务是所有操作族 + 治理能力的扁平合并：

### String（字符串）
`get<T>` · `set` · `setEx` · `setIfAbsent` · `getAndSet` · `getRange` ·
`setRange` · `size` · `append` · `incrBy` · `incrByFloat` · `decrBy` ·
`getBit` · `setBit` · `multiGet` · `multiSet` · `multiSetIfAbsent`

### Key（键）
`del` · `exists` · `expire` · `expireAt` · `persist` · `ttl` · `type` ·
`rename` · `renameIfAbsent` · `randomKey` · `scan`（异步迭代器）·
`scanKeys` · `batchSearch<T>`

### Hash（哈希）
`hGet<T>` · `hSet` · `hSetAll` · `hDel` · `hExists` · `hKeys` · `hVals<T>` ·
`hGetAll<T>` · `hLen` · `hMGet<T>` · `hIncrBy` · `hIncrByFloat`

### List（列表）
`lPush` · `rPush` · `lPop<T>` · `rPop<T>` · `lLen` · `lRange<T>` · `lIndex<T>` ·
`lSet` · `lRem` · `lTrim` · `blPop<T>` · `brPop<T>`（专用阻塞连接）

### Set（集合）
`sAdd` · `sRem` · `sMembers<T>` · `sIsMember` · `sCard` · `sPop<T>` ·
`sRandMember<T>` · `sInter<T>` · `sUnion<T>` · `sDiff<T>`

### Sorted set（有序集合）
`zAdd` · `zRem` · `zScore` · `zCard` · `zCount` · `zRank` · `zIncrBy` ·
`zRange<T>` · `zRangeWithScores<T>` · `zRangeByScore<T>` · `zRevRange<T>`

### Pipeline 与治理
`pipeline()` → 可链式的 `.set/.get/.del/.exec()`（原始、仍编码的结果）·
`multi()` → 原子的 MULTI/EXEC 事务，与 `pipeline()` 相同的链式接口 ·
`lock`（见下文）· `start()` · `stats()` → `{ pool, executor }` · `dispose()`

> **关于数值命令的说明。** `incrBy` / `hIncrBy` / `zIncrBy` 操作的是 Redis 原生的
> 整数/score 表示。在默认的 `json` value 编解码下，用 `set('k', '1')` 写入的值会以
> `"1"`（JSON 字符串）存储，**不是**合法的计数器目标。请在由自增命令自身创建的 key 上
> 使用计数器，或为计数器 key 选择 `value: string` / `value: raw`。

### 分布式锁（`ctx.redis.lock`）

```ts
const token = await redis.lock.tryLock('resource', 30, 's')   // LockToken | null
if (token) {
  try { /* ... */ } finally { await redis.lock.unlock('resource', token) }
}

// 或使用更符合人体工学的封装（始终在 finally 释放，看门狗持续续约）
await redis.lock.withLock('resource', async () => { /* 临界区 */ }, {
  ttl: 30_000,
  retryCount: 5,          // 可选：轮询直到获取成功
  retryInterval: 100,
  onLost: (key) => ctx.logger.warn('lock lost: %s', key),
})

await redis.lock.renew('resource', token, 60, 's')  // token 守卫的续约
await redis.lock.isHeldByMe('resource', token)
redis.lock.heldCount
```

解锁与续约都运行 token 守卫的 Lua 脚本，因此持有者绝不可能删除或续期一个已被他人重新
获取的锁。看门狗由插件自动启动（并注册为可逆的 `ctx.effect()`）；卸载时停止续约。
默认情况下 `dispose()` 依赖 TTL 到期，以避免删除临界区可能仍在运行的锁——如需在关闭时
主动释放本地持有的锁，请设置 `lock.releaseOnDispose: true`。

---

## 模型可见工具

当 `tools.enabled` 为 true 时，插件会为模型注册以下工具：

| 工具 | 用途 |
| --- | --- |
| `redis_get` | 读取一个 key（JSON 解码） |
| `redis_set` | 写入一个 key，可选 TTL（秒） |
| `redis_del` | 删除 key——**破坏性**，受 `allowDestructive` 权限门保护 |
| `redis_scan` | 基于游标的按 glob 扫描（绝不使用 `KEYS`） |
| `redis_exists` | key 存在性检查 |
| `redis_ttl` | 剩余 TTL（秒） |
| `redis_type` | key 的数据类型 |
| `redis_hgetall` | 一个哈希的所有字段 |
| `redis_hset` | 设置一个哈希字段 |
| `redis_incrby` | 原子整数自增 |
| `redis_lock` | 获取一个看门狗续约的锁，返回 token |
| `redis_unlock` | 按 token 释放锁 |

每个 `execute()` 都恰好返回一个规范化 JSON 值，并遵循 `exec.signal` 以支持取消。
`redis_del` 会被 `tools/pre-execute` 权限门拦截：当 `allowDestructive` 为 false 时，
权限门对破坏性工具返回 `deny` 决策；否则调用 `next()` 让瀑布流继续。

### 模型体验

- 工具返回紧凑、可预测的 JSON（`{ key, value, exists }`、`{ deleted }`、
  `{ keys, count, truncated }`、`{ acquired, token }`……），让模型能可靠地链式调用。
- `redis_scan` 受 `limit` 限制并报告 `truncated`，避免海量 key 倾倒。
- 破坏性操作默认关闭；启用它是一个明确的部署决策（`tools.allowDestructive: true`）。
- 锁工具对（lock/unlock）用一个不透明 token 教会模型安全的「获取 → 操作 → 释放」闭环，
  与一个行为良好的客户端使用分布式锁的方式一致。

---

## 开发

```bash
npm install        # 依赖（SDK peer 为可选 / 由宿主提供）
npm run typecheck  # 对 src + test 执行 tsc --noEmit
npm test           # vitest run（97 个用例，完全离线）
npm run build      # 产出 lib/（ESM + .d.ts）
```

测试完全离线运行：

- `codec`——JSON/string/raw + 类型提示往返、带前缀的 key、`toMillis`。
- `config`——`resolveConfig` 深合并、跳过 `undefined`、不改动默认值。
- `factory`——standalone 选项构建、`url` 优先级、tls 归一化、sentinel/cluster/未知
  拓扑的 fail-loud。
- `pool`——预热、idle 复用、max 上限 + waiter 交接、专用 blocking/pubsub 连接、
  健康检查剔除、`lease.destroy()` 回收、dispose 语义。
- `executor`——并发上限、超时、拒绝策略、重试语义、批量顺序、dispose 后拒绝。
- `watchdog`——续约、未到期时跳过、丢锁移除 + `onLost`、错误隔离、disposer 生命周期。
- `lock`——互斥、token 守卫的解锁/续约、`withLock` 的 finally 语义、重试获取、看门狗
  续约、dispose 策略（通过一个小的内存 `FakeRedis`，因为 ioredis-mock 的 Lua 支持不可靠）。
- `operations`——每个数据类型族 + pipeline + multi（事务）+ 一个针对 `ioredis-mock`
  的超时连接回收回归测试。
- `service`——`createRedis` 装配、幂等 `start()`、`stats()`、dispose 后拒绝。
- `tools`——`buildToolDefs`（全部 12 个工具 + execute 路径）、破坏性操作的
  `installGuard` deny/next 行为，以及 `registerRedisTools`（通过一个 dsh-tools 桩，
  因为宿主 SDK 离线不可安装）。

`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools` 的 import 在离线测试中被 alias
到空操作桩（`test/stubs/`）；真实类型来自 `src/host/dsh-sdk.d.ts`。

此外还有一个**实时集成测试** `test/live.integration.test.ts`（用 `describe.skipIf`
网关，仅当设置 `REDIS_LIVE=1` 且提供 `REDIS_LIVE_HOST` 时才运行，默认跳过、不影响离线
套件），通过 `scripts/run-live.ps1` 对真实 Redis 验证 string/key/hash/list/set/zset/
pipeline/multi/锁/遥测。

---

## 已知限制

- **拓扑**——仅实现 `standalone`。`sentinel` / `cluster` 会抛出清晰的
  `RedisPluginError`，指向扩展位（`DESIGN.md §5.1`）。
- **编解码 vs. 计数器**——见上文的数值命令说明；JSON 编码的值不是合法的 `INCR` 目标。
- **Pipeline / 事务结果是原始的**——`pipeline().exec()` 与 `multi().exec()` 返回仍编码的
  命令输出（对标 `RedisTemplate.executePipelined`）；如有需要请手动反序列化。
- **锁归属是进程内的**——注册表以唯一 token 为键持有锁（Node 对异步任务没有线程身份）。
  跨进程的公平性完全依赖 Redis 端的 token 守卫。
- **SDK shim**——`src/host/dsh-sdk.d.ts` 是本地 ambient 桩，使本仓库能独立类型检查与
  构建。当插件位于提供真实 `@deepseek-ai/*` 类型的 dsh monorepo 内时，请删除它。
- **worker 卸载**——`executor/worker-pool.ts` 为 CPU 密集的（反）序列化提供了一个可选的
  `worker_threads` 卸载位；它尚未接入默认命令路径。

---

## 许可证

MIT
