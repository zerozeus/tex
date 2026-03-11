/**
 * API 客户端配置
 */

// 服务器配置
export const API_CONFIG = {
  // 游戏服务器地址（服务器端使用）
  GAME_SERVER_URL: process.env.NEXT_PUBLIC_GAME_SERVER_URL || process.env.GAME_SERVER_URL || '',
  
  // WebSocket服务器地址
  WS_SERVER_URL: process.env.NEXT_PUBLIC_WS_SERVER_URL || '',
  
  // 是否使用代理（客户端使用）
  USE_PROXY: false,
};

export type ApiResult<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

const API_DEBUG = process.env.NEXT_PUBLIC_POKER_DEBUG === '1';

function safeStringify(value: unknown, maxLength = 2000): string {
  try {
    const text = JSON.stringify(
      value,
      (key, v) => {
        if (/token|authorization|cookie/i.test(key)) return '[REDACTED]';
        return v;
      },
      2
    );
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…(${text.length})`;
  } catch {
    return '[Unserializable]';
  }
}

function summarizeApiPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return { type: typeof payload };
  const p = payload as Record<string, unknown>;
  const success = typeof p.success === 'boolean' ? p.success : undefined;
  const hasData = 'data' in p;
  const data = hasData ? (p.data as unknown) : undefined;
  const summary: Record<string, unknown> = { type: 'object' };
  if (success !== undefined) summary.success = success;
  if (typeof p.error === 'string') summary.error = p.error;
  if (typeof p.message === 'string') summary.message = p.message;
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.gameId === 'string') summary.gameId = d.gameId;
    if (typeof d.phase === 'string') summary.phase = d.phase;
    if (typeof d.endType === 'string') summary.endType = d.endType;
  }
  return summary;
}

/**
 * API请求封装
 */
export class GameApiClient {
  private baseUrl: string;
  private useProxy: boolean;

  constructor(baseUrl?: string, useProxy?: boolean) {
    this.baseUrl = baseUrl || API_CONFIG.GAME_SERVER_URL;
    this.useProxy = useProxy !== undefined ? useProxy : API_CONFIG.USE_PROXY;
  }

  private async fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    try {
      const start = Date.now();
      const method = init?.method ?? 'GET';
      if (API_DEBUG) {
        const headers =
          init?.headers && typeof init.headers === 'object' ? init.headers : undefined;
        const body = 'body' in (init ?? {}) ? (init as RequestInit).body : undefined;
        console.debug('[api]', method, url, {
          headers: headers ? safeStringify(headers) : undefined,
          body: body ? safeStringify(body) : undefined,
        });
      }

      const response = await fetch(url, init);
      if (response.status === 204) {
        if (API_DEBUG) {
          console.debug('[api]', method, url, { status: 204, ms: Date.now() - start, noContent: true });
        }
        return ({ success: true } as unknown) as T;
      }
      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      let payload: unknown = null;
      if (isJson) {
        const text = await response.text();
        payload = text ? JSON.parse(text) : response.ok ? { success: true } : null;
      } else {
        payload = await response.text();
      }

      if (!response.ok) {
        const message =
          typeof payload === 'string'
            ? payload
            : (payload as { error?: string; message?: string })?.error ||
              (payload as { message?: string })?.message ||
              `HTTP ${response.status}`;
        if (API_DEBUG) {
          console.debug('[api]', method, url, {
            status: response.status,
            statusText: response.statusText,
            contentType,
            ms: Date.now() - start,
            payload: summarizeApiPayload(payload),
          });
        }
        throw new Error(`${response.status} ${response.statusText}: ${message}`);
      }

      if (API_DEBUG) {
        console.debug('[api]', method, url, {
          status: response.status,
          contentType,
          ms: Date.now() - start,
          payload: summarizeApiPayload(payload),
        });
      }
      return payload as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch ${url}: ${message}`);
    }
  }

  /**
   * 获取实际的请求URL
   */
  private getUrl(path: string): string {
    if (this.useProxy) {
      return `/api/proxy${path}`;
    }
    if (this.baseUrl) {
      return `${this.baseUrl}/api${path}`;
    }
    return `/api${path}`;
  }

  /**
   * 初始化游戏
   */
  async initGame(config: unknown): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/game/init');
    const result = await this.fetchJson<ApiResult<unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return result;
  }

  /**
   * 获取游戏状态
   */
  async getGameState(gameId: string): Promise<ApiResult<unknown>> {
    const url = this.getUrl(`/game/state?gameId=${gameId}`);
    const result = await this.fetchJson<ApiResult<unknown>>(url);
    return result;
  }

  /**
   * 玩家操作
   */
  async playerAction(gameId: string, playerId: string, action: string, amount?: number): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/game/action');
    const result = await this.fetchJson<ApiResult<unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, playerId, action, amount }),
    });
    return result;
  }

  /**
   * 进入下一阶段
   */
  async nextPhase(gameId: string): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/game/next-phase');
    const result = await this.fetchJson<ApiResult<unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    });
    return result;
  }

  /**
   * 获取游戏列表
   */
  async getGameList(): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/games');
    const result = await this.fetchJson<ApiResult<unknown>>(url);
    return result;
  }



  /**
   * 进入下一局 (结算后)
   */
  async nextRound(gameId: string): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/game/next-round');
    const result = await this.fetchJson<ApiResult<unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    });
    return result;
  }

  async settleShowdown(gameId: string): Promise<ApiResult<unknown>> {
    const url = this.getUrl('/game/settle-showdown');
    const result = await this.fetchJson<ApiResult<unknown>>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    });
    return result;
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<unknown> {
    const result = await this.fetchJson<unknown>('/health');
    return result;
  }
}

// 创建默认API客户端实例
export const gameApiClient = new GameApiClient();
