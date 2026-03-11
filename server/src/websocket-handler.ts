import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { GameEngine } from './game-engine';
import { WSMessage, WSClient, GameConfig, PlayerAction } from './types';

const DEBUG_LOG = process.env.POKER_DEBUG === '1';

function debugLog(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_LOG) return;
  console.log(`[ws] ${event}`, payload);
}

type WebSocketHandlerOptions =
  | { port: number }
  | { server: HttpServer; path?: string };

interface WSClientWithTimers extends WSClient {
  heartbeatTimer?: NodeJS.Timeout;
  pingTimeout?: NodeJS.Timeout;
  lastActivity?: number;
}

export class WebSocketHandler {
  private wss: WebSocketServer;
  private clients: Map<string, WSClientWithTimers> = new Map();
  private games: Map<string, GameEngine> = new Map();
  private readonly HEARTBEAT_INTERVAL = 25000; // 25秒
  private readonly PING_TIMEOUT = 10000; // 10秒超时

  constructor(options: WebSocketHandlerOptions) {
    if ('port' in options) {
      this.wss = new WebSocketServer({ port: options.port });
      this.setupServer();
      console.log(`WebSocket server running on port ${options.port}`);
      return;
    }

    const path = options.path ?? '/ws';
    this.wss = new WebSocketServer({ noServer: true });
    this.setupServer();

    options.server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = request.url ?? '';
      if (!url.startsWith(path)) {
        if (url.startsWith('/_next/webpack-hmr')) {
          debugLog('upgrade:pass', { url });
          return;
        }
        debugLog('upgrade:reject', { url, path });
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = this.generateClientId();
      const client: WSClientWithTimers = {
        id: clientId,
        ws,
        lastActivity: Date.now(),
      };

      this.clients.set(clientId, client);
      console.log(`Client connected: ${clientId}`);
      debugLog('client:connected', { clientId, totalClients: this.clients.size });

      // 发送欢迎消息
      this.sendToClient(clientId, {
        type: 'connected',
        data: { message: 'Connected to Texas Hold\'em server', clientId },
        timestamp: Date.now(),
      });

      // 启动心跳
      this.startHeartbeat(clientId);

      ws.on('message', (data: string) => {
        try {
          client.lastActivity = Date.now();
          
          // 处理 pong 响应
          if (data === 'pong') {
            debugLog('client:pong', { clientId });
            if (client.pingTimeout) {
              clearTimeout(client.pingTimeout);
              client.pingTimeout = undefined;
            }
            return;
          }

          debugLog('client:message', { clientId, bytes: data.length });
          const message = JSON.parse(data) as WSMessage;
          this.handleMessage(clientId, message);
        } catch (error) {
          console.error('Error parsing message:', error);
          this.sendToClient(clientId, {
            type: 'error',
            data: { message: 'Invalid message format' },
            timestamp: Date.now(),
          });
        }
      });

      ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        this.handleClientDisconnect(clientId);
        debugLog('client:disconnected', { clientId, totalClients: this.clients.size });
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
      });
    });
  }

  private startHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // 清除之前的定时器
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
    }
    if (client.pingTimeout) {
      clearTimeout(client.pingTimeout);
    }

    // 定期发送 ping
    client.heartbeatTimer = setInterval(() => {
      const c = this.clients.get(clientId);
      if (!c || c.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat(clientId);
        return;
      }

      try {
        debugLog('server:ping', { clientId });
        c.ws.send('ping');

        // 设置超时
        c.pingTimeout = setTimeout(() => {
          console.warn(`Client ${clientId} heartbeat timeout, closing connection`);
          this.handleClientDisconnect(clientId);
        }, this.PING_TIMEOUT);
      } catch (error) {
        console.error(`Failed to send ping to client ${clientId}:`, error);
        this.handleClientDisconnect(clientId);
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = undefined;
    }
    if (client.pingTimeout) {
      clearTimeout(client.pingTimeout);
      client.pingTimeout = undefined;
    }
  }

  private handleClientDisconnect(clientId: string): void {
    this.stopHeartbeat(clientId);
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.close();
    }
    this.clients.delete(clientId);
  }

  private handleMessage(clientId: string, message: WSMessage): void {
    debugLog('message:dispatch', { clientId, type: message.type });
    switch (message.type) {
      case 'player_action':
        this.handlePlayerAction(clientId, message.data as PlayerAction);
        break;
      case 'game_state':
        this.handleGameStateRequest(clientId, message.data);
        break;
      case 'join_game':
        this.handleJoinGame(clientId, message.data);
        break;
      default:
        console.log(`Unknown message type: ${message.type}`);
    }
  }

  private handleJoinGame(clientId: string, data: unknown): void {
    const payload = data as { gameId: string; playerId: string };
    
    if (!payload.gameId || !payload.playerId) {
      debugLog('join:invalid', { clientId, payload });
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Missing gameId or playerId' },
        timestamp: Date.now(),
      });
      return;
    }

    const success = this.joinGame(clientId, payload.gameId, payload.playerId);
    
    if (!success) {
      debugLog('join:fail', { clientId, gameId: payload.gameId, playerId: payload.playerId });
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Failed to join game (game not found)' },
        timestamp: Date.now(),
      });
    } else {
      console.log(`Client ${clientId} joined game ${payload.gameId} as player ${payload.playerId}`);
      debugLog('join:ok', { clientId, gameId: payload.gameId, playerId: payload.playerId });
    }
  }

  private handlePlayerAction(clientId: string, action: PlayerAction): void {
    debugLog('action:recv', { clientId, gameId: action.gameId, playerId: action.playerId, action: action.action, amount: action.amount ?? null });
    const game = this.games.get(action.gameId);

    if (!game) {
      debugLog('action:game_not_found', { clientId, gameId: action.gameId });
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Game not found' },
        timestamp: Date.now(),
      });
      return;
    }

    const result = game.handleAction(action.playerId, action.action, action.amount);

    if (result.success) {
      // 广播更新给所有玩家
      debugLog('action:ok', { clientId, gameId: action.gameId });
      this.broadcastGameState(action.gameId);
    } else {
      debugLog('action:fail', { clientId, gameId: action.gameId, error: result.error ?? 'Action failed' });
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: result.error || 'Action failed' },
        timestamp: Date.now(),
      });
    }
  }

  private handleGameStateRequest(clientId: string, data: unknown): void {
    const gameId =
      typeof data === 'object' && data !== null && 'gameId' in data
        ? (data as { gameId?: unknown }).gameId
        : undefined;

    if (typeof gameId !== 'string' || !gameId) {
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Invalid game state request' },
        timestamp: Date.now(),
      });
      return;
    }
    const game = this.games.get(gameId);

    if (!game) {
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Game not found' },
        timestamp: Date.now(),
      });
      return;
    }

    this.sendToClient(clientId, {
      type: 'game_state',
      data: game.getGameState(),
      timestamp: Date.now(),
    });
  }

  public createGame(config: GameConfig): string {
    const game = new GameEngine(config);
    this.games.set(game.getGameState().gameId, game);
    console.log(`Game created: ${game.getGameState().gameId}`);
    return game.getGameState().gameId;
  }

  public joinGame(clientId: string, gameId: string, playerId: string): boolean {
    const client = this.clients.get(clientId);
    const game = this.games.get(gameId);

    if (!client || !game) {
      return false;
    }

    client.playerId = playerId;
    client.gameId = gameId;

    this.sendToClient(clientId, {
      type: 'game_state',
      data: game.getGameState(),
      timestamp: Date.now(),
    });

    return true;
  }

  public broadcastGameState(gameId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    const gameState = game.getGameState();
    const message: WSMessage = {
      type: 'game_update',
      data: gameState,
      timestamp: Date.now(),
    };

    let recipients = 0;
    // 发送给所有在游戏中的客户端
    this.clients.forEach((client) => {
      if (client.gameId === gameId) {
        recipients += 1;
        this.sendToClient(client.id, message);
      }
    });
    debugLog('broadcast:game_state', { gameId, recipients });
  }

  private sendToClient(clientId: string, message: WSMessage): void {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private handleClientDisconnect(clientId: string): void {
    this.clients.delete(clientId);
  }

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public getGame(gameId: string): GameEngine | undefined {
    return this.games.get(gameId);
  }

  public getGamesMap(): Map<string, GameEngine> {
    return this.games;
  }

  public broadcast(gameId: string, type: WSMessage['type'], data: unknown): void {
    const chat = (data as { chat?: string })?.chat;
    const message: WSMessage = {
      type,
      data,
      timestamp: Date.now(),
      chat,
    };

    let recipients = 0;
    this.clients.forEach((client) => {
      if (client.gameId === gameId) {
        recipients += 1;
        this.sendToClient(client.id, message);
      }
    });
    debugLog('broadcast:custom', { gameId, type, recipients });
  }
}
