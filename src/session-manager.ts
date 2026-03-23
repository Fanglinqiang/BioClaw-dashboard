/**
 * Session Manager — manages Claude Agent SDK session IDs and router state.
 */
import { logger } from './logger.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from './db/index.js';
import { RegisteredGroup } from './types.js';
import { ensureGroupDir } from './group-folder.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

export function getLastTimestamp(): string {
  return lastTimestamp;
}

export function setLastTimestamp(ts: string): void {
  lastTimestamp = ts;
}

export function getSessions(): Record<string, string> {
  return sessions;
}

export function updateSession(groupFolder: string, sessionId: string): void {
  sessions[groupFolder] = sessionId;
  setSession(groupFolder, sessionId);
}

export function getRegisteredGroupsMap(): Record<string, RegisteredGroup> {
  return registeredGroups;
}

export function getLastAgentTimestamp(): Record<string, string> {
  return lastAgentTimestamp;
}

export function setLastAgentTimestampFor(chatJid: string, ts: string): void {
  lastAgentTimestamp[chatJid] = ts;
}

export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  ensureGroupDir(group.folder);
  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}
