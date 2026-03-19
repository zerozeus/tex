import { randomBytes, timingSafeEqual } from 'crypto';

const ACTION_ID_WINDOW = 200;

type ActionWindow = {
  order: string[];
  set: Set<string>;
};

export type PlayerAccess = {
  playerId: string;
  token: string;
};

export type PlayerTokenSnapshot = Record<string, PlayerAccess[]>;

export class PlayerAuthManager {
  private readonly gameTokens = new Map<string, Map<string, string>>();
  private readonly actionWindows = new Map<string, Map<string, ActionWindow>>();

  issueTokens(gameId: string, playerIds: string[]): PlayerAccess[] {
    const tokenMap = new Map<string, string>();
    const accessList: PlayerAccess[] = [];

    for (const playerId of playerIds) {
      const token = this.generateToken();
      tokenMap.set(playerId, token);
      accessList.push({ playerId, token });
    }

    this.gameTokens.set(gameId, tokenMap);
    return accessList;
  }

  validate(gameId: string, playerId: string, token: string): boolean {
    const tokenMap = this.gameTokens.get(gameId);
    if (!tokenMap) return false;

    const expectedToken = tokenMap.get(playerId);
    if (!expectedToken) return false;

    return this.safeEquals(expectedToken, token);
  }

  revokeGame(gameId: string): void {
    this.gameTokens.delete(gameId);
    this.actionWindows.delete(gameId);
  }

  exportTokenSnapshot(): PlayerTokenSnapshot {
    const snapshot: PlayerTokenSnapshot = {};

    for (const [gameId, tokenMap] of this.gameTokens.entries()) {
      snapshot[gameId] = Array.from(tokenMap.entries()).map(([playerId, token]) => ({
        playerId,
        token,
      }));
    }

    return snapshot;
  }

  importTokenSnapshot(snapshot: PlayerTokenSnapshot | undefined): number {
    this.gameTokens.clear();
    this.actionWindows.clear();

    if (!snapshot || typeof snapshot !== 'object') {
      return 0;
    }

    let restored = 0;

    for (const [gameId, accessList] of Object.entries(snapshot)) {
      if (!Array.isArray(accessList)) continue;

      const tokenMap = new Map<string, string>();
      for (const entry of accessList) {
        if (!entry || typeof entry !== 'object') continue;
        const playerId = typeof entry.playerId === 'string' ? entry.playerId.trim() : '';
        const token = typeof entry.token === 'string' ? entry.token.trim() : '';
        if (!playerId || !token) continue;
        tokenMap.set(playerId, token);
      }

      if (tokenMap.size === 0) continue;
      this.gameTokens.set(gameId, tokenMap);
      restored += 1;
    }

    return restored;
  }

  isDuplicateAction(gameId: string, playerId: string, actionId: string): boolean {
    const actionMap = this.actionWindows.get(gameId);
    const window = actionMap?.get(playerId);
    if (!window) return false;
    return window.set.has(actionId);
  }

  reserveAction(gameId: string, playerId: string, actionId: string): boolean {
    const window = this.getOrCreateActionWindow(gameId, playerId);
    if (window.set.has(actionId)) return false;

    window.order.push(actionId);
    window.set.add(actionId);
    this.trimActionWindow(window);
    return true;
  }

  rememberAction(gameId: string, playerId: string, actionId: string): void {
    this.reserveAction(gameId, playerId, actionId);
  }

  forgetAction(gameId: string, playerId: string, actionId: string): void {
    const actionMap = this.actionWindows.get(gameId);
    const window = actionMap?.get(playerId);
    if (!actionMap || !window) return;
    if (!window.set.delete(actionId)) return;

    window.order = window.order.filter((id) => id !== actionId);
    if (window.order.length > 0) return;

    actionMap.delete(playerId);
    if (actionMap.size === 0) {
      this.actionWindows.delete(gameId);
    }
  }

  private getOrCreateActionWindow(gameId: string, playerId: string): ActionWindow {
    let actionMap = this.actionWindows.get(gameId);
    if (!actionMap) {
      actionMap = new Map<string, ActionWindow>();
      this.actionWindows.set(gameId, actionMap);
    }

    let window = actionMap.get(playerId);
    if (!window) {
      window = { order: [], set: new Set<string>() };
      actionMap.set(playerId, window);
    }

    return window;
  }

  private trimActionWindow(window: ActionWindow): void {
    while (window.order.length > ACTION_ID_WINDOW) {
      const oldest = window.order.shift();
      if (oldest) {
        window.set.delete(oldest);
      }
    }
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }

  private safeEquals(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);

    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  }
}
