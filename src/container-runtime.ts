/**
 * Container Runtime — low-level container operations (spawn, volume mounts, args).
 * Abstracts Docker (future: Apple Container) so container-runner.ts only handles
 * high-level orchestration (input/output, timeouts, lifecycle).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  GROUPS_DIR,
} from './config.js';
import { ensureGroupDir, ensureGroupIpcDir, ensureGroupSessionDir } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Build volume mounts for a group's container.
 */
export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Ensure group directory exists
  ensureGroupDir(group.folder);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = ensureGroupSessionDir(group.folder);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace
  const groupIpcDir = ensureGroupIpcDir(group.folder);
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Mount agent-runner source from host
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Build Docker CLI arguments for running a container.
 */
export function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);
  return args;
}

/**
 * Spawn a Docker container process.
 */
export function spawnContainer(containerArgs: string[]): ChildProcess {
  return spawn('docker', containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Generate a unique container name for a group.
 */
export function makeContainerName(folder: string): string {
  const safeName = folder.replace(/[^a-zA-Z0-9-]/g, '-');
  return `bioclaw-${safeName}-${Date.now()}`;
}
