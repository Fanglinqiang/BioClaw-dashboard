import { getDb } from './connection.js';
import { ContainerConfig, RegisteredGroup } from '../types.js';

type GroupRow = {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
};

/**
 * Parse the container_config JSON blob which stores containerConfig, agentType, and notifyUser.
 * Old format: containerConfig object directly.
 * New format: { containerConfig, agentType, notifyUser }.
 */
function parseConfigBlob(raw: string | null): { containerConfig?: ContainerConfig; agentType?: string; notifyUser?: string } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if ('containerConfig' in parsed || 'agentType' in parsed) {
      return parsed;
    }
    // Old format: containerConfig directly
    return { containerConfig: parsed };
  } catch {
    return {};
  }
}

function rowToGroup(row: GroupRow): RegisteredGroup & { jid: string } {
  const { containerConfig, agentType, notifyUser } = parseConfigBlob(row.container_config);
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    agentType: agentType as RegisteredGroup['agentType'],
    notifyUser,
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        workspace_folder: string | null;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        archived: number | null;
      }
    | undefined;
  if (!row) return undefined;
  const { containerConfig, agentType, notifyUser } = parseConfigBlob(row.container_config);
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    workspaceFolder: row.workspace_folder || row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    archived: row.archived === 1,
    agentType: agentType as RegisteredGroup['agentType'],
    notifyUser,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  const db = getDb();
  const configBlob = (group.containerConfig || group.agentType || group.notifyUser)
    ? JSON.stringify({ containerConfig: group.containerConfig, agentType: group.agentType, notifyUser: group.notifyUser })
    : null;
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, workspace_folder, trigger_pattern, added_at, container_config, requires_trigger, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.workspaceFolder || group.folder,
    group.trigger,
    group.added_at,
    configBlob,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.archived ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    workspace_folder: string | null;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    archived: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const { containerConfig, agentType, notifyUser } = parseConfigBlob(row.container_config);
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      workspaceFolder: row.workspace_folder || row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      archived: row.archived === 1,
      agentType: agentType as RegisteredGroup['agentType'],
      notifyUser,
    };
  }
  return result;
}
