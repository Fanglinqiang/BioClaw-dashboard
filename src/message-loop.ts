/**
 * Message Loop — polls for new messages and dispatches to groups.
 */
import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { getAllChats, getMessagesSince, getNewMessages } from './db/index.js';
import { AvailableGroup } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import {
  getLastTimestamp,
  setLastTimestamp,
  getRegisteredGroupsMap,
  getLastAgentTimestamp,
  setLastAgentTimestampFor,
  saveState,
} from './session-manager.js';
import { NewMessage } from './types.js';

let messageLoopRunning = false;

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const registeredGroups = getRegisteredGroupsMap();
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') || c.jid.endsWith('@local.web')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 */
export function recoverPendingMessages(queue: GroupQueue): void {
  const registeredGroups = getRegisteredGroupsMap();
  const lastAgentTimestamp = getLastAgentTimestamp();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Main message polling loop.
 */
export async function startMessageLoop(queue: GroupQueue): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`BioClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const registeredGroups = getRegisteredGroupsMap();
      const lastAgentTimestamp = getLastAgentTimestamp();
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        getLastTimestamp(),
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        setLastTimestamp(newTimestamp);
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            setLastAgentTimestampFor(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            saveState();
          } else {
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
