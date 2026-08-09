/**
 * Environment variable accessor with pi-hub/pi-web fallback.
 *
 * pi-hub is a fork of pi-web. To preserve backward compatibility for users
 * migrating from upstream (or sharing shell configs between the two), every
 * public `PI_HUB_*` variable falls back to its legacy `PI_WEB_*` equivalent.
 * `PI_HUB_*` always wins when both are set.
 *
 * Centralised here so the fallback rule is applied consistently across the
 * Next.js middleware, auth, and request-security modules.
 */
export function piEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`PI_HUB_${name}`] ?? env[`PI_WEB_${name}`];
}
