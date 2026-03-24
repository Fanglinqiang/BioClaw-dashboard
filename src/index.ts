/**
 * BioClaw Orchestrator
 * Top-level startup, shutdown, and wiring. All logic is delegated to sub-modules.
 */
import 'dotenv/config';
import { execSync } from 'child_process';

import {
  ASSISTANT_NAME,
  ENABLE_LOCAL_WEB,
  ENABLE_WECHAT,
  ENABLE_WHATSAPP,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_CONNECTION_MODE,
  FEISHU_ENCRYPT_KEY,
  FEISHU_HOST,
  FEISHU_PATH,
  FEISHU_PORT,
  FEISHU_VERIFICATION_TOKEN,
  QQ_APP_ID,
  QQ_CLIENT_SECRET,
  QQ_SANDBOX,
  IDLE_TIMEOUT,
  LOCAL_WEB_GROUP_FOLDER,
  LOCAL_WEB_GROUP_JID,
  LOCAL_WEB_GROUP_NAME,
  LOCAL_WEB_HOST,
  LOCAL_WEB_PORT,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from './config.js';
import { recordAgentTraceEvent } from './agent-trace.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './group-folder.js';
import {
  getAllTasks,
  getMessagesSince,
  initDatabase,
  storeMessage,
  storeChatMetadata,
} from './db/index.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { startMessageLoop, getAvailableGroups, recoverPendingMessages } from './message-loop.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  loadState,
  saveState,
  registerGroup,
  getRegisteredGroupsMap,
  getSessions,
  updateSession,
  getLastAgentTimestamp,
  setLastAgentTimestampFor,
} from './session-manager.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { LocalWebChannel } from './channels/local-web/channel.js';
import { QQChannel } from './channels/qq.js';
import { FeishuChannel } from './channels/feishu.js';
import { WhatsAppChannel } from './channels/whatsapp/channel.js';
import { WeComChannel } from './channels/wecom.js';
import { DiscordChannel } from './channels/discord.js';
import { SlackChannel } from './channels/slack.js';
import { WeChatChannel } from './channels/wechat.js';
import { Channel, NewMessage } from './types.js';
import { logger } from './logger.js';


const channels: Channel[] = [];
const queue = new GroupQueue();

function channelForJid(jid: string): Channel | undefined {
  return channels.find(ch => ch.ownsJid(jid));
}

async function sendToChannel(jid: string, text: string): Promise<void> {
  const ch = channelForJid(jid);
  if (!ch) { logger.warn({ jid }, 'No channel owns this JID'); return; }
  const formatted = ch.prefixAssistantName ? `${ASSISTANT_NAME}: ${text}` : text;
  await ch.sendMessage(jid, formatted);
}

async function sendImageToChannel(jid: string, imagePath: string, caption?: string): Promise<void> {
  const ch = channelForJid(jid);
  if (!ch?.sendImage) { logger.warn({ jid }, 'No channel with image support'); return; }
  await ch.sendImage(jid, imagePath, caption);
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const registeredGroups = getRegisteredGroupsMap();
  const group = registeredGroups[chatJid];
  if (!group) return true;
  const channel = findChannel(channels, chatJid);
  if (!channel) { logger.warn({ chatJid }, 'No channel found for group'); return true; }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const lastAgentTimestamp = getLastAgentTimestamp();
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    if (!missedMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()))) return true;
  }

  const prompt = formatMessages(missedMessages);
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  setLastAgentTimestampFor(chatJid, missedMessages[missedMessages.length - 1].timestamp);
  saveState();

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  const sessions = getSessions();
  recordAgentTraceEvent({
    group_folder: group.folder, chat_jid: chatJid,
    session_id: sessions[group.folder] ?? null, type: 'run_start',
    payload: { messageCount: missedMessages.length, promptLength: prompt.length, preview: prompt.slice(0, 500) },
  });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { queue.closeStdin(chatJid); }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) { await sendToChannel(chatJid, text); outputSentToUser = true; }
      resetIdleTimer();
    }
    if (result.status === 'error') hadError = true;
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) return true;
    setLastAgentTimestampFor(chatJid, previousCursor);
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back cursor for retry');
    return false;
  }
  return true;
}

async function runAgent(
  group: import('./types.js').RegisteredGroup,
  prompt: string, chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessions = getSessions();
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map((t) => ({
    id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
    schedule_type: t.schedule_type, schedule_value: t.schedule_value,
    status: t.status, next_run: t.next_run,
  })));

  const availableGroups = getAvailableGroups();
  const registeredGroups = getRegisteredGroupsMap();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  const wrappedOnOutput = onOutput
    ? async (out: ContainerOutput) => {
        if (out.newSessionId) updateSession(group.folder, out.newSessionId);
        const r = out.result == null ? '' : typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
        recordAgentTraceEvent({
          group_folder: group.folder, chat_jid: chatJid,
          session_id: getSessions()[group.folder] ?? null, type: 'stream_output',
          payload: { status: out.status, resultLength: r.length, preview: r.replace(/<internal>[\s\S]*?<\/internal>/g, '').slice(0, 800), newSessionId: out.newSessionId ?? null },
        });
        await onOutput(out);
      }
    : undefined;

  try {
    const out = await runContainerAgent(
      group, { prompt, sessionId, groupFolder: group.folder, chatJid, isMain },
      (proc, cn) => queue.registerProcess(chatJid, proc, cn, group.folder),
      wrappedOnOutput,
    );
    if (out.newSessionId) updateSession(group.folder, out.newSessionId);
    recordAgentTraceEvent({
      group_folder: group.folder, chat_jid: chatJid,
      session_id: getSessions()[group.folder] ?? null,
      type: 'run_end', payload: { status: out.status, error: out.error ?? null },
    });
    if (out.status === 'error') { logger.error({ group: group.name, error: out.error }, 'Container agent error'); return 'error'; }
    return 'success';
  } catch (err) {
    recordAgentTraceEvent({
      group_folder: group.folder, chat_jid: chatJid,
      session_id: getSessions()[group.folder] ?? null,
      type: 'run_error', payload: { message: err instanceof Error ? err.message : String(err) },
    });
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// --- Startup ---

function ensureDockerRunning(): void {
  try { execSync('docker info', { stdio: 'pipe', timeout: 10000 }); } catch {
    console.error('\nFATAL: Docker is not running. Start Docker Desktop or run: sudo systemctl start docker\n');
    throw new Error('Docker is required but not running');
  }
  try {
    const output = execSync('docker ps --filter "name=bioclaw-" --format "{{.Names}}"', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) { try { execSync(`docker stop ${name}`, { stdio: 'pipe' }); } catch {} }
    if (orphans.length > 0) logger.info({ count: orphans.length }, 'Stopped orphaned containers');
  } catch {}
}

let whatsapp: WhatsAppChannel | undefined;

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await Promise.all(channels.map((ch) => ch.disconnect()));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelCallbacks = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) => storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => getRegisteredGroupsMap(),
    autoRegister: (jid: string, name: string, channelName: string) => {
      if (getRegisteredGroupsMap()[jid]) return;
      const folder = `${channelName}-${jid.split('@')[0].slice(-8)}`;
      registerGroup(jid, { name, folder, trigger: TRIGGER_PATTERN.source, added_at: new Date().toISOString(), requiresTrigger: false });
    },
  };

  // --- Channels ---

  if (ENABLE_LOCAL_WEB) {
    const rg = getRegisteredGroupsMap();
    if (!rg[LOCAL_WEB_GROUP_JID]) {
      const conflict = Object.entries(rg).find(([jid, g]) => jid !== LOCAL_WEB_GROUP_JID && g.folder === LOCAL_WEB_GROUP_FOLDER);
      if (!conflict) {
        registerGroup(LOCAL_WEB_GROUP_JID, { name: LOCAL_WEB_GROUP_NAME, folder: LOCAL_WEB_GROUP_FOLDER, trigger: `@${ASSISTANT_NAME}`, added_at: new Date().toISOString(), requiresTrigger: false });
      }
    }
    const localWeb = new LocalWebChannel({ onMessage: (_jid, msg) => storeMessage(msg), onChatMetadata: (jid, ts, name) => storeChatMetadata(jid, ts, name) });
    channels.push(localWeb);
    await localWeb.connect();
  }

  if (QQ_APP_ID && QQ_CLIENT_SECRET) {
    const qq = new QQChannel({
      appId: QQ_APP_ID,
      clientSecret: QQ_CLIENT_SECRET,
      sandbox: QQ_SANDBOX,
      ...channelCallbacks,
    });
    channels.push(qq);
    try { await qq.connect(); } catch (err) { logger.error({ err }, 'QQ connection failed'); }
  }

  if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
    const feishu = new FeishuChannel({
      appId: FEISHU_APP_ID,
      appSecret: FEISHU_APP_SECRET,
      connectionMode: FEISHU_CONNECTION_MODE === 'webhook' ? 'webhook' : 'websocket',
      verificationToken: FEISHU_VERIFICATION_TOKEN || undefined,
      encryptKey: FEISHU_ENCRYPT_KEY || undefined,
      host: FEISHU_HOST,
      port: FEISHU_PORT,
      path: FEISHU_PATH,
      ...channelCallbacks,
    });
    channels.push(feishu);
    try { await feishu.connect(); } catch (err) { logger.error({ err }, 'Feishu connection failed'); }
  }

  if (process.env.WECOM_BOT_ID && process.env.WECOM_SECRET) {
    const agentCreds = process.env.WECOM_CORP_ID && process.env.WECOM_CORP_SECRET && process.env.WECOM_AGENT_ID
      ? { corpId: process.env.WECOM_CORP_ID, corpSecret: process.env.WECOM_CORP_SECRET, agentId: process.env.WECOM_AGENT_ID } : undefined;
    const wecom = new WeComChannel({ botId: process.env.WECOM_BOT_ID, secret: process.env.WECOM_SECRET, agent: agentCreds, ...channelCallbacks });
    channels.push(wecom);
    try { await wecom.connect(); } catch (err) { logger.error({ err }, 'WeCom connection failed'); }
  }

  if (ENABLE_WHATSAPP && !process.env.DISABLE_WHATSAPP) {
    whatsapp = new WhatsAppChannel(channelCallbacks);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (ENABLE_WECHAT) {
    const wechat = new WeChatChannel(channelCallbacks);
    channels.push(wechat);
    try { await wechat.connect(); } catch (err) { logger.error({ err }, 'WeChat connection failed'); }
  }

  if (process.env.DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel({ token: process.env.DISCORD_BOT_TOKEN, ...channelCallbacks });
    channels.push(discord);
    try { await discord.connect(); } catch (err) { logger.error({ err }, 'Discord connection failed'); }
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const slack = new SlackChannel({ botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, ...channelCallbacks });
    channels.push(slack);
    try { await slack.connect(); } catch (err) { logger.error({ err }, 'Slack connection failed'); }
  }

  // --- Subsystems ---

  startSchedulerLoop({
    registeredGroups: () => getRegisteredGroupsMap(),
    getSessions: () => getSessions(),
    queue,
    onProcess: (jid, proc, cn, gf) => queue.registerProcess(jid, proc, cn, gf),
    sendMessage: async (jid, rawText) => {
      const ch = channelForJid(jid);
      if (ch) { const text = formatOutbound(ch, rawText); if (text) await ch.sendMessage(jid, text); }
    },
  });

  startIpcWatcher({
    registeredGroups: () => getRegisteredGroupsMap(),
    registerGroup,
    sendMessage: (jid, text) => sendToChannel(jid, text),
    sendImage: (jid, path, caption) => sendImageToChannel(jid, path, caption),
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages(queue);
  startMessageLoop(queue);
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) { main().catch((err) => { logger.error({ err }, 'Failed to start BioClaw'); process.exit(1); }); }
