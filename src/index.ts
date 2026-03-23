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
  IDLE_TIMEOUT,
  LOCAL_WEB_GROUP_FOLDER,
  LOCAL_WEB_GROUP_JID,
  LOCAL_WEB_GROUP_NAME,
  LOCAL_WEB_HOST,
  LOCAL_WEB_PORT,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
  WECOM_BOT_ID,
  WECOM_SECRET,
  WECOM2_BOT_ID,
  WECOM2_SECRET,
  WECOM3_BOT_ID,
  WECOM3_SECRET,
  WECOM_CORP_ID,
  WECOM_CORP_SECRET,
  WECOM_AGENT_ID,
  FEISHU_DEFAULT_FOLDER,
  FEISHU2_APP_ID,
  FEISHU2_APP_SECRET,
  FEISHU2_DEFAULT_FOLDER,
  FEISHU3_APP_ID,
  FEISHU3_APP_SECRET,
  FEISHU3_DEFAULT_FOLDER,
} from './config.js';
import { recordAgentTraceEvent } from './agent-trace.js';
import {
  ContainerEvent,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './group-folder.js';
import {
  getAllTasks,
  getMessagesSince,
  initDatabase,
  logTokenUsage,
  setSession,
  storeChatMetadata,
  storeMessage,
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
import { startDashboard } from './dashboard.js';
import { LocalWebChannel } from './channels/local-web/channel.js';
import { FeishuChannel } from './channels/feishu.js';
import { WhatsAppChannel } from './channels/whatsapp/channel.js';
import { WeComChannel } from './channels/wecom.js';
import { DiscordChannel } from './channels/discord.js';
import { SlackChannel } from './channels/slack.js';
import { WeChatChannel } from './channels/wechat.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
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

async function sendFileToChannel(jid: string, filePath: string): Promise<void> {
  const ch = channelForJid(jid);
  if (!ch?.sendFile) {
    logger.warn({ jid }, 'No channel with file support for this JID');
    return;
  }
  await ch.sendFile(jid, filePath);
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

  // Streaming card state (for channels that support CardKit, e.g. Feishu)
  let streamCardId: string | null = null;
  let streamSequence = 0;
  let accumulatedText = '';
  let cardCreatePending = false;

  const supportsStreaming = !!(channel?.createStreamingCard);

  // onEvent callback: create/update streaming card as text events arrive
  const onStreamEvent = supportsStreaming ? (event: ContainerEvent) => {
    if (event.type === 'text' && event.text) {
      accumulatedText += (accumulatedText ? '\n\n' : '') + event.text;
      streamSequence++;
      const seq = streamSequence;

      if (!streamCardId && !cardCreatePending) {
        // First text event — create the streaming card
        cardCreatePending = true;
        channel!.createStreamingCard!(chatJid).then(cardId => {
          cardCreatePending = false;
          if (cardId) {
            streamCardId = cardId;
            channel!.updateStreamingCard!(cardId, accumulatedText, seq);
            outputSentToUser = true;
          }
        }).catch(err => {
          cardCreatePending = false;
          logger.error({ err }, 'Failed to create streaming card');
        });
      } else if (streamCardId) {
        channel!.updateStreamingCard!(streamCardId, accumulatedText, seq).catch(() => {});
      }
    }
  } : undefined;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

      if (text && channel) {
        if (streamCardId) {
          // Finalize the streaming card with the final text
          streamSequence++;
          const formatted = formatOutbound(channel, text);
          await channel.finalizeStreamingCard!(streamCardId, formatted || text, streamSequence);
          outputSentToUser = true;
        } else {
          // No streaming card — send as normal message
          const formatted = formatOutbound(channel, text);
          if (formatted) {
            await channel.sendMessage(chatJid, formatted);
            outputSentToUser = true;
          }
        }
      }
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, onStreamEvent);

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
  onEvent?: (event: ContainerEvent) => void,
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

  // Wrap onOutput to track session ID, log token usage, and emit trace events
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          updateSession(group.folder, output.newSessionId);
          setSession(group.folder, output.newSessionId);
        }
        // Log token usage as soon as we receive it (don't wait for container exit)
        if (output.usage && (output.usage.input_tokens > 0 || output.usage.output_tokens > 0)) {
          logTokenUsage({
            group_folder: group.folder,
            agent_type: 'claude',
            input_tokens: output.usage.input_tokens,
            output_tokens: output.usage.output_tokens,
            cache_read_tokens: output.usage.cache_read_tokens,
            cache_creation_tokens: output.usage.cache_creation_tokens,
            cost_usd: output.usage.cost_usd,
            duration_ms: output.usage.duration_ms,
            num_turns: output.usage.num_turns,
            source: 'message',
          });
        }
        const r = output.result == null ? '' : typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
        recordAgentTraceEvent({
          group_folder: group.folder, chat_jid: chatJid,
          session_id: getSessions()[group.folder] ?? null, type: 'stream_output',
          payload: { status: output.status, resultLength: r.length, preview: r.replace(/<internal>[\s\S]*?<\/internal>/g, '').slice(0, 800), newSessionId: output.newSessionId ?? null },
        });
        await onOutput(output);
      }
    : undefined;

  try {
    const out = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        agentType: group.agentType,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onEvent,
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

  if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
    const feishu = new FeishuChannel(FEISHU_APP_ID, FEISHU_APP_SECRET, {
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

  if (WECOM_BOT_ID && WECOM_SECRET) {
    const wecom = new WeComChannel(WECOM_BOT_ID, WECOM_SECRET, {
      corpId: WECOM_CORP_ID || undefined,
      corpSecret: WECOM_CORP_SECRET || undefined,
      agentId: WECOM_AGENT_ID || undefined,
      ...channelCallbacks,
    });
    channels.push(wecom);
    try { await wecom.connect(); } catch (err) { logger.error({ err }, 'WeCom connection failed'); }
  }

  if (WECOM2_BOT_ID && WECOM2_SECRET) {
    const wecom2 = new WeComChannel(WECOM2_BOT_ID, WECOM2_SECRET, {
      jidPrefix: 'wc2:',
      corpId: WECOM_CORP_ID || undefined,
      corpSecret: WECOM_CORP_SECRET || undefined,
      agentId: WECOM_AGENT_ID || undefined,
      ...channelCallbacks,
    });
    channels.push(wecom2);
    try { await wecom2.connect(); } catch (err) { logger.error({ err }, 'WeCom2 connection failed'); }
  }

  if (WECOM3_BOT_ID && WECOM3_SECRET) {
    const wecom3 = new WeComChannel(WECOM3_BOT_ID, WECOM3_SECRET, {
      jidPrefix: 'wc3:',
      corpId: WECOM_CORP_ID || undefined,
      corpSecret: WECOM_CORP_SECRET || undefined,
      agentId: WECOM_AGENT_ID || undefined,
      ...channelCallbacks,
    });
    channels.push(wecom3);
    try { await wecom3.connect(); } catch (err) { logger.error({ err }, 'WeCom3 connection failed'); }
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
      const ch = findChannel(channels, jid);
      if (!ch) return;
      const text = formatOutbound(ch, rawText);
      if (text) await ch.sendMessage(jid, text);
    },
  });

  startIpcWatcher({
    registeredGroups: () => getRegisteredGroupsMap(),
    registerGroup,
    sendMessage: (jid, text) => sendToChannel(jid, text),
    sendImage: (jid, imagePath, caption) => sendImageToChannel(jid, imagePath, caption),
    sendFile: (jid, filePath) => sendFileToChannel(jid, filePath),
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages(queue);
  startMessageLoop(queue);
  startDashboard();
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) { main().catch((err) => { logger.error({ err }, 'Failed to start BioClaw'); process.exit(1); }); }
