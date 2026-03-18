import fs from 'fs';
import os from 'os';
import path from 'path';

import type { GameConfig } from '../types';
import type { GameEngineSnapshot } from '../game-engine';
import type { PlayerTokenSnapshot } from './player-auth';

export type RuntimeGameSnapshot = {
  gameId: string;
  createdAt: number;
  playerCount: number;
  config: GameConfig;
  engine: GameEngineSnapshot;
};

export type RuntimeSnapshot = {
  version: 1;
  savedAt: number;
  games: RuntimeGameSnapshot[];
  playerTokens: PlayerTokenSnapshot;
};

const RUNTIME_SNAPSHOT_FILE = path.join(os.tmpdir(), 'tex-runtime-snapshot.json');

export function getRuntimeSnapshotPath(): string {
  return RUNTIME_SNAPSHOT_FILE;
}

export function loadRuntimeSnapshot(): RuntimeSnapshot | null {
  if (!fs.existsSync(RUNTIME_SNAPSHOT_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(RUNTIME_SNAPSHOT_FILE, 'utf8');
    if (!raw.trim()) return null;

    const parsed = JSON.parse(raw) as Partial<RuntimeSnapshot>;
    if (
      parsed.version !== 1 ||
      typeof parsed.savedAt !== 'number' ||
      !Array.isArray(parsed.games) ||
      typeof parsed.playerTokens !== 'object' ||
      parsed.playerTokens === null
    ) {
      return null;
    }

    return parsed as RuntimeSnapshot;
  } catch (error) {
    console.warn('Failed to load runtime snapshot:', error);
    return null;
  }
}

export function saveRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  try {
    const tempFile = `${RUNTIME_SNAPSHOT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tempFile, RUNTIME_SNAPSHOT_FILE);
  } catch (error) {
    console.warn('Failed to save runtime snapshot:', error);
  }
}

