/**
 * Credential Proxy — reads allowed secrets from .env and provides them
 * to containers via stdin, ensuring secrets never touch disk or volume mounts.
 *
 * Future enhancement: run an HTTP proxy that intercepts API calls from containers
 * and injects credentials on the fly, so containers never see raw API keys at all.
 */
import fs from 'fs';
import path from 'path';

const ALLOWED_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'MODEL_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
] as const;

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
export function readSecrets(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return {};

  const secrets: Record<string, string> = {};
  const content = fs.readFileSync(envFile, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!ALLOWED_VARS.includes(key as typeof ALLOWED_VARS[number])) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) secrets[key] = value;
  }

  return secrets;
}
