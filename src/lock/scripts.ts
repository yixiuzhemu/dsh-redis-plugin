/**
 * Atomic Lua scripts for the distributed lock.
 * UNLOCK mirrors `RedisConstants.UNLOCK_SCRIPT`; RENEW mirrors the `renewal`
 * script in `RedisLockUtils`. Both verify the token before mutating so a holder
 * can never delete or extend a lock that has already been re-acquired by
 * someone else.
 */

/** KEYS[1] = lock key, ARGV[1] = token. Returns 1 on success, 0 otherwise. */
export const UNLOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1]
then
  return redis.call("del", KEYS[1])
else
  return 0
end`

/** KEYS[1] = lock key, ARGV[1] = token, ARGV[2] = ttl in ms. Returns 1/0. */
export const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1]
then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`
