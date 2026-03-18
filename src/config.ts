import path from 'path';
import { fileURLToPath } from 'url';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Bioclaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
// Use import.meta.url so paths are correct regardless of process.cwd()
// dist/config.js -> ../../ -> project root
const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'bioclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'bioclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === "true";

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// MiniMax (optional)
export const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
export const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1';
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.5';

// Qwen (optional — set via env or .env file)
export const QWEN_API_BASE = process.env.QWEN_API_BASE || '';
export const QWEN_AUTH_TOKEN = process.env.QWEN_AUTH_TOKEN || '';
export const QWEN_MODEL = process.env.QWEN_MODEL || '';

// WeCom (optional — set via env or .env file)
export const WECOM_BOT_ID = process.env.WECOM_BOT_ID || "";
export const WECOM_SECRET = process.env.WECOM_SECRET || "";
export const WECOM2_BOT_ID = process.env.WECOM2_BOT_ID || "";
export const WECOM2_SECRET = process.env.WECOM2_SECRET || "";
export const WECOM3_BOT_ID = process.env.WECOM3_BOT_ID || "";
export const WECOM3_SECRET = process.env.WECOM3_SECRET || "";
export const WECOM_CORP_ID = process.env.WECOM_CORP_ID || "";
export const WECOM_CORP_SECRET = process.env.WECOM_CORP_SECRET || "";
export const WECOM_AGENT_ID = parseInt(process.env.WECOM_AGENT_ID || "0", 10);

// Feishu / Lark (optional — set via env or .env file)
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
export const FEISHU_DEFAULT_FOLDER = process.env.FEISHU_DEFAULT_FOLDER || 'main';
export const FEISHU2_APP_ID = process.env.FEISHU2_APP_ID || '';
export const FEISHU2_APP_SECRET = process.env.FEISHU2_APP_SECRET || '';
export const FEISHU2_DEFAULT_FOLDER = process.env.FEISHU2_DEFAULT_FOLDER || '';
export const FEISHU3_APP_ID = process.env.FEISHU3_APP_ID || '';
export const FEISHU3_APP_SECRET = process.env.FEISHU3_APP_SECRET || '';
export const FEISHU3_DEFAULT_FOLDER = process.env.FEISHU3_DEFAULT_FOLDER || '';
