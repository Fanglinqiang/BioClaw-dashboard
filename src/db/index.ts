// Database barrel — re-exports all sub-modules for a single import point.
// Usage: import { initDatabase, storeMessage, ... } from './db/index.js';

export { initDatabase, _initTestDatabase } from './connection.js';
export { migrateJsonState } from './migration.js';

// Messages & chats
export {
  storeChatMetadata,
  updateChatName,
  storeMessage,
  storeMessageDirect,
  getNewMessages,
  getMessagesSince,
  getRecentMessages,
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  type ChatInfo,
} from './messages.js';

// Registered groups
export {
  getRegisteredGroup,
  setRegisteredGroup,
  getAllRegisteredGroups,
} from './groups.js';

// Tasks
export {
  createTask,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  updateTask,
  deleteTask,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
} from './tasks.js';

// Sessions
export {
  getSession,
  setSession,
  getAllSessions,
} from './sessions.js';

// Router state
export {
  getRouterState,
  setRouterState,
} from './state.js';

// Traces
export {
  insertAgentTraceEvent,
  getAgentTraceEvents,
  type AgentTraceRow,
} from './traces.js';

// Token usage — exported from legacy db.ts (kept for backward compat)
export {
  logTokenUsage,
  getTokenUsageByDay,
  type TokenUsageDaily,
} from '../db.js';
