# dsh-redis-plugin

**Languages:** English | [简体中文](./README.zh-CN.md)

> DeepSeek Harness (**dsh**) Redis plugin — connection management, codec, thread‑pool
> governance, query operations, a distributed lock with watchdog renewal, and
> model‑visible tools.

`dsh-redis-plugin` is a foundational [Cordis](https://cordis.js.org)-style dsh plugin
that gives every other plugin (and the model itself) safe, governed access to a
Redis instance. It is built on **ioredis**, exposes a flat, promise‑based
`ctx.redis` service, and registers everything as reversible effects so HMR /
unload rolls back cleanly (connections, timers, tools).

The design is a Node/TypeScript port of the connection + codec + query patterns
found in `spring-boot-starter-data-redis-reactive` and a Java `redis-utils`
helper, adapted to dsh's "everything is a plugin" runtime. See [`DESIGN.md`](./DESIGN.md).

---

## Quick start

```bash
dsh plugin --profile <profile-name> add dsh-redis-plugin   # zero config — just use ctx.redis
```

Out of the box — **when no host/port is given — the plugin connects to
`127.0.0.1:6379`, db `0`, no password.** That default is guaranteed at three layers
(`cordis.patch.yml` → `config.ts` → `factory.ts`) and is covered by the `config` /
`factory` unit tests.

### Change the host / port

No code changes needed — pick whichever fits:

1. **Environment variables (recommended).** Set `REDIS_HOST` / `REDIS_PORT`:
   ```bash
   export REDIS_HOST=192.168.4.189   # bash / zsh
   export REDIS_PORT=6380
   ```
   ```powershell
   $env:REDIS_HOST = '192.168.4.189'   # PowerShell
   $env:REDIS_PORT = '6380'
   ```
2. **`.env` file.** Copy `.env.example` to `.env` and set `REDIS_HOST` / `REDIS_PORT`.
3. **Single URL.** Set `REDIS_URL=redis://192.168.4.189:6380/0` — it overrides
   host/port/db/password entirely.
4. **`cordis.patch.yml`.** Replace the `!!js` expressions with literals
   (`host: 192.168.4.189`, `port: 6380`). This commits the address to the repo —
   prefer 1–3 for anything but a fixed local default.

Full variable list and precedence: [Multi-environment](#multi-environment-dev--test--uat--prod).

---

## Features

- **Connection layer** — a pooled, health‑checked connection factory. `standalone`
  is implemented today; `sentinel` and `cluster` are reserved extension points
  that fail loud rather than silently mis‑connect.
- **Codec** — pluggable key/value serializers mirroring Spring's
  `StringRedisSerializer` (keys) and `GenericJackson2JsonRedisSerializer`
  (values, with optional `@type` hints for `Date` / `Map` / `Set` / `Buffer`).
- **Thread‑pool governance** — a bounded `TaskExecutor` (Node analogue of Java's
  `ThreadPoolExecutor`: core → queue → max → reject) wraps every command with
  admission control, per‑task timeout, and idempotent‑only retry with
  exponential backoff. Blocking / pub‑sub traffic runs on dedicated connections.
- **Query operations** — flat, typed API across key / string / hash / list / set
  / zset / pipeline, plus `scan` (never `KEYS`) and `batchSearch`.
- **Distributed lock + watchdog** — atomic `SET NX PX` acquire, token‑guarded Lua
  unlock/renew, and a periodic watchdog that renews locks held by this process so
  long critical sections never lose the lock to TTL expiry.
- **Model‑visible tools** — 12 guarded tools (`redis_get`, `redis_set`, …) so the
  model can read/write Redis directly, with a `tools/pre-execute` permission gate
  for destructive operations.

---

## Install

Inside a dsh workspace, add the bundle to a profile:

```bash
dsh plugin --profile <profile-name> add dsh-redis-plugin
```

Or install it as a plain npm dependency of your own plugin:

```bash
npm install dsh-redis-plugin
```

The `@deepseek-ai/*` SDK packages (`cordis`, `dsh-tools`, `schemastery`) are
**optional peer dependencies** supplied by the dsh host at deploy time. The
framework‑agnostic core (`dsh-redis-plugin/core`) has no SDK dependency and can be
used as a standalone library.

---

## Configuration

Config is declared in the plugin's `cordis.patch.yml` line (or passed to
`apply`). Every field is optional — a bare `- name: dsh-redis-plugin` works with
the defaults below. The shipped `cordis.patch.yml` reads the connection from
`REDIS_*` environment variables (see [Multi-environment](#multi-environment-dev--test--uat--prod))
so no host/port/secret is hardcoded.

```yaml
- id: redis
  name: dsh-redis-plugin
  config:
    connection:
      topology: standalone            # standalone | sentinel | cluster (only standalone implemented)
      # url wins over host/port/db/password when present:
      url: !!js "process.env.REDIS_URL || undefined"
      host: !!js "process.env.REDIS_HOST || '127.0.0.1'"
      port: !!js "Number(process.env.REDIS_PORT || 6379)"
      password: !!js "process.env.REDIS_PASSWORD || undefined"
      db: !!js "Number(process.env.REDIS_DB || 0)"
    pool:
      min: 2
      max: 16
      idleTimeoutMs: 30000
      healthCheckMs: 15000            # 0 disables the PING health check
    executor:
      coreSize: 8
      maxSize: 32
      queueCapacity: 1024
      keepAliveMs: 60000
      timeoutMs: 3000                 # per-command timeout
      rejectPolicy: abort             # abort | discardOldest | callerRuns
      retry:
        maxAttempts: 3                # idempotent commands only
        backoffMs: 200
    codec:
      keyPrefix: ''                   # optional namespace prefix for all keys
      value: json                     # json | string | raw
      typeHint: false                 # embed @type for Date/Map/Set/Buffer round-trips
      offloadThresholdBytes: 1048576
    lock:
      defaultTtlMs: 30000
      watchdogIntervalMs: 1000
      renewAheadMs: 10000             # renew when < this much TTL remains
      releaseOnDispose: false         # true = actively release locks on shutdown
    tools:
      enabled: true                   # register model-visible tools
      allowDestructive: false         # gate redis_del behind pre-execute permission
```

### Multi-environment (dev / test / uat / prod)

The connection is **environment-driven**: `cordis.patch.yml` resolves each field
from a `REDIS_*` env var (via the loader's `!!js` tag), so you switch stages by
injecting different values — never by editing code. Copy [`.env.example`](.env.example)
to `.env` (git-ignored) or set the vars in your deployment pipeline.

| Variable | Purpose | Default |
| --- | --- | --- |
| `REDIS_ENV` | Stage label (`dev`/`test`/`uat`/`prod`); logged at startup, unknown values warn. Does **not** itself change the address. | `default` |
| `REDIS_URL` | Full connection URL. **If set, wins over host/port/db/password.** | _(unset)_ |
| `REDIS_HOST` / `REDIS_PORT` | Discrete address. | `127.0.0.1` / `6379` |
| `REDIS_PASSWORD` / `REDIS_DB` | Auth + logical DB. | _(none)_ / `0` |
| `REDIS_KEY_PREFIX` | Optional key namespace — recommended when stages **share** one Redis so keys never collide. | _(none)_ |

**Precedence:** `REDIS_URL` → `REDIS_HOST/PORT/PASSWORD/DB` → built-in default
(`127.0.0.1:6379/0`). Each stage simply exports its own values, e.g.:

```bash
# test stage
export REDIS_ENV=test
export REDIS_HOST=redis.test.internal
export REDIS_PORT=6379
export REDIS_PASSWORD=<from-secret-manager>
export REDIS_DB=1
export REDIS_KEY_PREFIX=test:
```

At startup the plugin logs the resolved stage and target, e.g.
`[dsh-redis-plugin] ready (env=test, topology=standalone, target=redis.test.internal:6379/1, tools=on)`.
The raw URL is never logged (it may carry credentials).

#### Setting the variables

The plugin only reads `process.env` at dsh host load time, so any standard
mechanism works. Pick whichever fits your runtime:

**1. Local `.env` file (recommended for development).** Copy the template and
edit it; `.env` is git-ignored so secrets stay local:

```bash
cp .env.example .env
```

The dsh host loads `.env` for you. If you use the framework-agnostic `core`
outside dsh, load it yourself — `node --env-file=.env …` (Node ≥ 20) or `dotenv`.

**2. PowerShell (Windows)** — affects the current shell only:

```powershell
$env:REDIS_ENV      = 'test'
$env:REDIS_HOST     = '192.168.4.189'
$env:REDIS_PORT     = '6379'
$env:REDIS_PASSWORD = '<from-secret-manager>'
$env:REDIS_DB       = '1'
```

Persist per-user with `[Environment]::SetEnvironmentVariable('REDIS_HOST', '…', 'User')`.

**3. bash / zsh (Linux & macOS):**

```bash
export REDIS_ENV=prod
export REDIS_HOST=prod-redis.internal
export REDIS_PASSWORD="$(secret-tool lookup redis prod)"
```

**4. Docker / docker-compose:**

```yaml
services:
  app:
    environment:
      REDIS_ENV: prod
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_PASSWORD: ${REDIS_PASSWORD}   # injected from host env / .env, never hardcoded
```

**5. CI/CD** — set them as pipeline / secret variables (GitHub Actions `env:` +
`secrets.*`, GitLab CI/CD variables, etc.). Never commit real credentials;
reference the secret store instead.

> Because `@deepseek-ai/*` are deploy-time peer deps and the `!!js` tag is
> evaluated by the dsh loader, this env resolution happens in the host at load
> time. For local end-to-end verification against a real server see
> [`scripts/run-live.ps1`](scripts/run-live.ps1) + `test/live.integration.test.ts`.

---

## Using it from another plugin

Declare `inject: ['redis']` and consume the typed `ctx.redis` service:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['redis']

export function apply(ctx: Context) {
  ctx.effect(() => {
    // write
    void ctx.redis.set('user:1', { id: 1, name: 'ada' }, { ex: 60 })

    // read (JSON-decoded back to an object)
    void ctx.redis.get<{ id: number; name: string }>('user:1').then((user) => {
      ctx.logger.info('user=%o', user)
    })

    // distributed lock with automatic watchdog renewal
    void ctx.redis.lock.withLock('order:42', async () => {
      // ... critical section; the lock is kept alive and always released
    })
  })
}
```

Because this plugin augments the Cordis `Context` type, `ctx.redis` is fully
typed once you add `inject: ['redis']`.

---

## API reference (`ctx.redis` / `createRedis()`)

The service is a flat merge of every operation family plus governance:

### String
`get<T>` · `set` · `setEx` · `setIfAbsent` · `getAndSet` · `getRange` ·
`setRange` · `size` · `append` · `incrBy` · `incrByFloat` · `decrBy` ·
`getBit` · `setBit` · `multiGet` · `multiSet` · `multiSetIfAbsent`

### Key
`del` · `exists` · `expire` · `expireAt` · `persist` · `ttl` · `type` ·
`rename` · `renameIfAbsent` · `randomKey` · `scan` (async iterator) ·
`scanKeys` · `batchSearch<T>`

### Hash
`hGet<T>` · `hSet` · `hSetAll` · `hDel` · `hExists` · `hKeys` · `hVals<T>` ·
`hGetAll<T>` · `hLen` · `hMGet<T>` · `hIncrBy` · `hIncrByFloat`

### List
`lPush` · `rPush` · `lPop<T>` · `rPop<T>` · `lLen` · `lRange<T>` · `lIndex<T>` ·
`lSet` · `lRem` · `lTrim` · `blPop<T>` · `brPop<T>` (dedicated blocking connection)

### Set
`sAdd` · `sRem` · `sMembers<T>` · `sIsMember` · `sCard` · `sPop<T>` ·
`sRandMember<T>` · `sInter<T>` · `sUnion<T>` · `sDiff<T>`

### Sorted set
`zAdd` · `zRem` · `zScore` · `zCard` · `zCount` · `zRank` · `zIncrBy` ·
`zRange<T>` · `zRangeWithScores<T>` · `zRangeByScore<T>` · `zRevRange<T>`

### Pipeline & governance
`pipeline()` → chainable `.set/.get/.del/.exec()` (raw, still‑encoded results) ·
`multi()` → atomic MULTI/EXEC transaction, same chainable surface as `pipeline()` ·
`lock` (see below) · `start()` · `stats()` → `{ pool, executor }` · `dispose()`

> **Note on numeric commands.** `incrBy` / `hIncrBy` / `zIncrBy` operate on Redis'
> native integer/score representation. Under the default `json` value codec a
> value written with `set('k', '1')` is stored as `"1"` (JSON string) and is not a
> valid counter. Use counters on keys created by the increment commands
> themselves, or select `value: string` / `value: raw` for counter keys.

### Distributed lock (`ctx.redis.lock`)

```ts
const token = await redis.lock.tryLock('resource', 30, 's')   // LockToken | null
if (token) {
  try { /* ... */ } finally { await redis.lock.unlock('resource', token) }
}

// or the ergonomic wrapper (always releases in finally, watchdog keeps it alive)
await redis.lock.withLock('resource', async () => { /* critical section */ }, {
  ttl: 30_000,
  retryCount: 5,          // optional: poll until acquired
  retryInterval: 100,
  onLost: (key) => ctx.logger.warn('lock lost: %s', key),
})

await redis.lock.renew('resource', token, 60, 's')  // token-guarded extension
await redis.lock.isHeldByMe('resource', token)
redis.lock.heldCount
```

Unlock and renew run token‑guarded Lua scripts, so a holder can never delete or
extend a lock that has already been re‑acquired by someone else. The watchdog is
started automatically by the plugin (and registered as a reversible
`ctx.effect()`); on unload it stops renewing. By default `dispose()` relies on TTL
to avoid deleting locks whose critical section may still be running — set
`lock.releaseOnDispose: true` to actively release locally‑held locks instead.

---

## Model‑visible tools

When `tools.enabled` is true, the plugin registers these tools for the model:

| Tool | Purpose |
| --- | --- |
| `redis_get` | Read a key (JSON‑decoded) |
| `redis_set` | Write a key with optional TTL (seconds) |
| `redis_del` | Delete keys — **destructive**, gated by `allowDestructive` |
| `redis_scan` | Cursor‑based key scan by glob (never `KEYS`) |
| `redis_exists` | Key existence check |
| `redis_ttl` | Remaining TTL in seconds |
| `redis_type` | Data type of a key |
| `redis_hgetall` | All fields of a hash |
| `redis_hset` | Set a hash field |
| `redis_incrby` | Atomic integer increment |
| `redis_lock` | Acquire a watchdog‑renewed lock, returns a token |
| `redis_unlock` | Release a lock by token |

Every `execute()` returns exactly one canonical JSON value and honours
`exec.signal` for cancellation. `redis_del` is intercepted by a
`tools/pre-execute` guard: when `allowDestructive` is false the guard returns a
`deny` decision for destructive tools, and otherwise calls `next()` so the
waterfall continues.

### Model Experience

- Tools return compact, predictable JSON (`{ key, value, exists }`, `{ deleted }`,
  `{ keys, count, truncated }`, `{ acquired, token }`, …) so the model can chain
  calls reliably.
- `redis_scan` is bounded by `limit` and reports `truncated`, preventing huge
  key dumps.
- Destructive operations are off by default; enabling them is an explicit
  deployment decision (`tools.allowDestructive: true`).
- The lock tool pair teaches the model a safe acquire → act → release loop with an
  opaque token, matching how a well‑behaved client should use distributed locks.

---

## Development

```bash
npm install        # dependencies (SDK peers are optional / host-provided)
npm run typecheck  # tsc --noEmit over src + test
npm test           # vitest run (97 tests, fully offline)
npm run build      # emit lib/ (ESM + .d.ts)
```

Tests run entirely offline:

- `codec` — JSON/string/raw + type‑hint round‑trips, prefixed keys, `toMillis`.
- `config` — `resolveConfig` deep‑merge, `undefined`‑skipping, no default mutation.
- `factory` — standalone option building, `url` precedence, tls normalization,
  fail‑loud sentinel/cluster/unknown topologies.
- `pool` — warm‑up, idle reuse, max bounding + waiter hand‑off, dedicated
  blocking/pubsub connections, health‑check eviction, `lease.destroy()` reclaim,
  dispose semantics.
- `executor` — concurrency bounds, timeout, reject policy, retry semantics,
  batch ordering, post‑dispose rejection.
- `watchdog` — renewal, skip‑when‑not‑due, lost‑lock removal + `onLost`, error
  isolation, disposer lifecycle.
- `lock` — mutual exclusion, token‑guarded unlock/renew, `withLock` finally
  semantics, retry acquisition, watchdog renewal, dispose policies (via a small
  in‑memory `FakeRedis` because ioredis‑mock's Lua support is unreliable).
- `operations` — every data‑type family + pipeline + multi (transaction) + a
  timeout connection‑reclaim regression against `ioredis-mock`.
- `service` — `createRedis` wiring, idempotent `start()`, `stats()`, post‑dispose
  rejection.
- `tools` — `buildToolDefs` (all 12 tools + execute paths), the destructive‑op
  `installGuard` deny/next behaviour, and `registerRedisTools` (via a dsh-tools
  stub, since the host SDK is not installable offline).

The `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` imports are aliased to
no‑op stubs (`test/stubs/`) for offline tests; real types come from
`src/host/dsh-sdk.d.ts`.

---

## Known limitations

- **Topology** — only `standalone` is implemented. `sentinel` / `cluster` throw a
  clear `RedisPluginError` pointing at the extension seam (`DESIGN.md §5.1`).
- **Codec vs. counters** — see the numeric‑commands note above; JSON‑encoded
  values are not valid `INCR` targets.
- **Pipeline / transaction results are raw** — `pipeline().exec()` and
  `multi().exec()` return still‑encoded command output (mirrors
  `RedisTemplate.executePipelined`); deserialize manually if needed.
- **Lock ownership is process‑local** — the registry keys held locks by their
  unique token (Node has no thread identity for async tasks). Cross‑process
  fairness relies solely on the Redis token guard.
- **SDK shim** — `src/host/dsh-sdk.d.ts` is a local ambient stub so this repo
  type‑checks and builds standalone. Delete it when the plugin lives inside a real
  dsh monorepo that provides the genuine `@deepseek-ai/*` types.
- **worker offload** — `executor/worker-pool.ts` provides an optional
  `worker_threads` offload seam for CPU‑heavy (de)serialization; it is not wired
  into the default command path.

---

## License

MIT
