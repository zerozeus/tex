import express from 'express';
import cors from 'cors';
import { WebSocketHandler } from './websocket-handler';
import { GameConfig } from './types';
import { gameDatabaseService } from './storage/database/game-database.service';
import { installConsoleFileLogging } from './utils/logger';
import next from 'next';
import path from 'path';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

import { GameLock } from './infra/GameLock';
import { BotService } from './bot/BotService';
import { AVAILABLE_BOTS } from './bot/bots-config';
import { GameOrchestrator } from './orchestrator/GameOrchestrator';
import { PlayerAuthManager } from './utils/player-auth';
import { projectGameStateForViewer } from './utils/state-visibility';

installConsoleFileLogging();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== 'production';
const projectRoot = path.resolve(__dirname, '..', '..');
let nextApp: ReturnType<typeof next>;
let nextHandler: (req: IncomingMessage, res: ServerResponse) => void;

try {
  nextApp = next({ dev, dir: projectRoot });
  nextHandler = nextApp.getRequestHandler();
} catch (e) {
  console.warn('Next.js not available, running in API-only mode');
  nextHandler = (_req, res) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

const httpServer = createServer(app);

// 中间件
app.use(cors());
app.use(express.json());

const DEBUG_LOG = process.env.POKER_DEBUG === '1';

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

function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const sensitiveKeys = ['playerToken', 'token', 'authorization'];
    for (const key of sensitiveKeys) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return rawUrl
      .replace(/(playerToken=)[^&]*/gi, '$1[REDACTED]')
      .replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]')
      .replace(/([?&]authorization=)[^&]*/gi, '$1[REDACTED]');
  }
}

app.use((req, res, next) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  const rawUrl = req.originalUrl || req.url;
  const logUrl = sanitizeUrlForLog(rawUrl);

  console.log(`[${new Date().toISOString()}] [${requestId}] ${req.method} ${logUrl}`);
  if (DEBUG_LOG && req.body && Object.keys(req.body).length > 0) {
    console.log(`[${requestId}] body=${safeStringify(req.body)}`);
  }

  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] [${requestId}] ${req.method} ${logUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });

  next();
});

// 内存存储游戏信息
type StoredGameInfo = {
  id: string;
  createdAt: number;
  playerCount: number;
  config: GameConfig;
};

const games: Map<string, StoredGameInfo> = new Map();
const playerAuthManager = new PlayerAuthManager();

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractViewerFromBody(body: unknown): { playerId?: string; playerToken?: string } {
  if (typeof body !== 'object' || body === null) {
    return {};
  }
  const payload = body as Record<string, unknown>;
  return {
    playerId: normalizeString(payload.playerId),
    playerToken: normalizeString(payload.playerToken),
  };
}

function resolveViewer(
  gameId: string,
  playerId?: string,
  playerToken?: string,
): { ok: true; viewerPlayerId?: string } | { ok: false; status: number; error: string } {
  if (!playerId && !playerToken) {
    return { ok: true };
  }
  if (!playerId || !playerToken) {
    return { ok: false, status: 401, error: '玩家身份信息不完整' };
  }
  if (!playerAuthManager.validate(gameId, playerId, playerToken)) {
    return { ok: false, status: 403, error: '玩家身份校验失败' };
  }
  return { ok: true, viewerPlayerId: playerId };
}

function resolveRequiredViewer(
  gameId: string,
  playerId?: string,
  playerToken?: string,
): { ok: true; viewerPlayerId: string } | { ok: false; status: number; error: string } {
  if (!playerId || !playerToken) {
    return { ok: false, status: 401, error: '玩家身份信息不完整' };
  }
  if (!playerAuthManager.validate(gameId, playerId, playerToken)) {
    return { ok: false, status: 403, error: '玩家身份校验失败' };
  }
  return { ok: true, viewerPlayerId: playerId };
}

// WebSocket处理器
const wsHandler = new WebSocketHandler({ server: httpServer, path: '/ws' });
wsHandler.configureAccessControl({
  validatePlayerAuth: (gameId, playerId, token) =>
    playerAuthManager.validate(gameId, playerId, token),
  projectStateForViewer: projectGameStateForViewer,
});

// Orchestrator Setup
const botService = new BotService();
const gameLock = new GameLock();
const broadcaster = {
  broadcastGameState: (gameId: string, _state: unknown) => wsHandler.broadcastGameState(gameId),
  broadcastBotThinking: (gameId: string, payload: unknown) => wsHandler.broadcast(gameId, 'bot_thinking', payload),
  broadcastBotDecision: (gameId: string, payload: unknown) => wsHandler.broadcast(gameId, 'bot_decision', payload),
};

const orchestrator = new GameOrchestrator(
  wsHandler.getGamesMap(),
  botService,
  broadcaster,
  gameLock
);

// REST API路由

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 获取可用机器人列表
app.get('/api/bots', (req, res) => {
  res.json({
    success: true,
    data: AVAILABLE_BOTS.map(bot => ({
      id: bot.id,
      name: bot.name,
      token: bot.token,
      botId: bot.botId,
      url: bot.url
    }))
  });
});


// 初始化游戏
app.post('/api/game/init', async (req, res) => {
  try {
    const config: GameConfig = req.body;

    // 验证输入
    if (!config.players || config.players.length < 2 || config.players.length > 9) {
      return res.status(400).json({
        success: false,
        error: '玩家数量必须在2-9人之间',
      });
    }

    if (!config.smallBlind || !config.bigBlind || config.smallBlind <= 0 || config.bigBlind <= 0) {
      return res.status(400).json({
        success: false,
        error: '盲注必须大于0',
      });
    }

    if (config.bigBlind < config.smallBlind) {
      return res.status(400).json({
        success: false,
        error: '大盲注不能小于小盲注',
      });
    }

    // 创建游戏
    const gameId = wsHandler.createGame(config);
    const game = wsHandler.getGame(gameId);

    if (!game) {
      return res.status(500).json({
        success: false,
        error: '游戏创建失败',
      });
    }

    const gameState = game.getGameState();
    const humanPlayers = config.players.filter((player) => !player.isBot);
    const playerAccess = playerAuthManager.issueTokens(
      gameId,
      humanPlayers.map((player) => player.id),
    );
    const playerAccessPayload = playerAccess.map((item) => ({
      playerId: item.playerId,
      playerName:
        gameState.players.find((player) => player.id === item.playerId)?.name ?? item.playerId,
      token: item.token,
    }));

    // 存储游戏信息
    games.set(gameId, {
      id: gameId,
      createdAt: Date.now(),
      playerCount: config.players.length,
      config,
    });

    // 记录到数据库
    try {
      await gameDatabaseService.createGame(gameId, config, gameState);
    } catch (dbError) {
      console.error('Failed to record game to database:', dbError);
      // 数据库失败不影响游戏创建
    }

    console.log(`Game initialized: ${gameId} with ${config.players.length} players`);

    void orchestrator.startGame(gameId);

    res.json({
      success: true,
      data: {
        ...projectGameStateForViewer(gameState),
        playerAccess: playerAccessPayload,
      },
    });
  } catch (error) {
    console.error('Error initializing game:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误',
    });
  }
});

// 获取游戏状态
app.get('/api/game/state', (req, res) => {
  try {
    const { gameId, playerId, playerToken } = req.query;
    const normalizedGameId = normalizeString(gameId);
    const normalizedPlayerId = normalizeString(playerId);
    const normalizedPlayerToken = normalizeString(playerToken);

    if (!normalizedGameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(normalizedGameId);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    const viewerCheck = resolveViewer(
      normalizedGameId,
      normalizedPlayerId,
      normalizedPlayerToken,
    );
    if (!viewerCheck.ok) {
      return res.status(viewerCheck.status).json({
        success: false,
        error: viewerCheck.error,
      });
    }

    res.json({
      success: true,
      data: projectGameStateForViewer(
        game.getGameState(),
        viewerCheck.viewerPlayerId,
      ),
    });
  } catch (error) {
    console.error('Error getting game state:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误',
    });
  }
});

app.post('/api/game/state', (req, res) => {
  try {
    const { gameId, playerId, playerToken } = req.body as {
      gameId?: unknown;
      playerId?: unknown;
      playerToken?: unknown;
    };
    const normalizedGameId = normalizeString(gameId);
    const normalizedPlayerId = normalizeString(playerId);
    const normalizedPlayerToken = normalizeString(playerToken);

    if (!normalizedGameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(normalizedGameId);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    const viewerCheck = resolveViewer(
      normalizedGameId,
      normalizedPlayerId,
      normalizedPlayerToken,
    );
    if (!viewerCheck.ok) {
      return res.status(viewerCheck.status).json({
        success: false,
        error: viewerCheck.error,
      });
    }

    res.json({
      success: true,
      data: projectGameStateForViewer(
        game.getGameState(),
        viewerCheck.viewerPlayerId,
      ),
    });
  } catch (error) {
    console.error('Error getting game state:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误',
    });
  }
});

// 玩家操作
app.post('/api/game/action', async (req, res) => {
  let reservedAction:
    | {
        gameId: string;
        playerId: string;
        actionId: string;
      }
    | undefined;

  try {
    const { gameId, playerId, playerToken, action, amount, actionId } = req.body as {
      gameId?: unknown;
      playerId?: unknown;
      playerToken?: unknown;
      action?: unknown;
      amount?: unknown;
      actionId?: unknown;
    };

    const normalizedGameId = normalizeString(gameId);
    const normalizedPlayerId = normalizeString(playerId);
    const normalizedPlayerToken = normalizeString(playerToken);
    const normalizedAction = normalizeString(action);
    const normalizedActionId = normalizeString(actionId);
    const normalizedAmount =
      typeof amount === 'number'
        ? amount
        : typeof amount === 'string' && amount.trim()
          ? Number(amount)
          : undefined;

    if (!normalizedGameId || !normalizedPlayerId || !normalizedPlayerToken || !normalizedAction) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数',
      });
    }

    if (!playerAuthManager.validate(normalizedGameId, normalizedPlayerId, normalizedPlayerToken)) {
      return res.status(403).json({
        success: false,
        error: '玩家身份校验失败',
      });
    }

    if (normalizedActionId) {
      const accepted = playerAuthManager.reserveAction(
        normalizedGameId,
        normalizedPlayerId,
        normalizedActionId,
      );
      if (!accepted) {
        const currentGame = wsHandler.getGame(normalizedGameId);
        return res.json({
          success: true,
          data: currentGame
            ? projectGameStateForViewer(currentGame.getGameState(), normalizedPlayerId)
            : undefined,
          message: '重复请求已忽略',
        });
      }
      reservedAction = {
        gameId: normalizedGameId,
        playerId: normalizedPlayerId,
        actionId: normalizedActionId,
      };
    }

    // 使用 orchestrator 处理动作
    const result = await orchestrator.submitPlayerAction(
      normalizedGameId,
      normalizedPlayerId,
      normalizedAction,
      Number.isFinite(normalizedAmount) ? normalizedAmount : undefined,
    );

    if (result.success) {
      // 获取最新状态返回给前端
      const game = wsHandler.getGame(normalizedGameId);
      res.json({
        success: true,
        data: game
          ? projectGameStateForViewer(game.getGameState(), normalizedPlayerId)
          : undefined,
      });
    } else {
      if (reservedAction) {
        playerAuthManager.forgetAction(
          reservedAction.gameId,
          reservedAction.playerId,
          reservedAction.actionId,
        );
      }
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    if (reservedAction) {
      playerAuthManager.forgetAction(
        reservedAction.gameId,
        reservedAction.playerId,
        reservedAction.actionId,
      );
    }
    const message = error instanceof Error ? error.message : '服务器内部错误';
    console.error('Error handling player action:', error);
    
    if (message.includes('game not found')) {
       return res.status(404).json({ success: false, error: message });
    }
    
    res.status(500).json({
      success: false,
      error: message,
    });
  }
});

app.post('/api/game/settle-showdown', async (req, res) => {
  try {
    const { gameId } = req.body as { gameId?: unknown };
    const normalizedGameId = normalizeString(gameId);
    const viewer = extractViewerFromBody(req.body);

    if (!normalizedGameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(normalizedGameId);
    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    const viewerCheck = resolveRequiredViewer(
      normalizedGameId,
      viewer.playerId,
      viewer.playerToken,
    );
    if (!viewerCheck.ok) {
      return res.status(viewerCheck.status).json({
        success: false,
        error: viewerCheck.error,
      });
    }

    const result = await orchestrator.settleShowdown(normalizedGameId);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: projectGameStateForViewer(
        game.getGameState(),
        viewerCheck.viewerPlayerId,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务器内部错误';
    console.error('Error settling showdown:', error);
    res.status(500).json({
      success: false,
      error: message,
    });
  }
});



// 进入下一阶段
app.post('/api/game/next-phase', (req, res) => {
  try {
    const { gameId } = req.body as { gameId?: unknown };
    const normalizedGameId = normalizeString(gameId);
    const viewer = extractViewerFromBody(req.body);

    if (!normalizedGameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(normalizedGameId);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    // 获取当前游戏状态
    const gameState = game.getGameState();

    const viewerCheck = resolveViewer(
      normalizedGameId,
      viewer.playerId,
      viewer.playerToken,
    );
    if (!viewerCheck.ok) {
      return res.status(viewerCheck.status).json({
        success: false,
        error: viewerCheck.error,
      });
    }

    res.json({
      success: true,
      data: projectGameStateForViewer(gameState, viewerCheck.viewerPlayerId),
    });
  } catch (error) {
    console.error('Error moving to next phase:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误',
    });
  }
});

// 获取所有游戏列表
app.get('/api/games', (req, res) => {
  try {
    const gameList = Array.from(games.values()).map(game => ({
      id: game.id,
      createdAt: game.createdAt,
      playerCount: game.playerCount,
    }));

    res.json({
      success: true,
      data: gameList,
    });
  } catch (error) {
    console.error('Error getting games list:', error);
    res.status(500).json({
      success: false,
      error: '服务器内部错误',
    });
  }
});

// 开始新一局 (用于前端在结算动画结束后触发)
app.post('/api/game/next-round', async (req, res) => {
  try {
      const { gameId } = req.body as { gameId?: unknown };
      const normalizedGameId = normalizeString(gameId);
      const viewer = extractViewerFromBody(req.body);

      if (!normalizedGameId) {
        return res.status(400).json({ success: false, error: '缺少游戏ID' });
      }

      const game = wsHandler.getGame(normalizedGameId);
      if (!game) {
        throw new Error('Game not found');
      }

      const viewerCheck = resolveRequiredViewer(
        normalizedGameId,
        viewer.playerId,
        viewer.playerToken,
      );
      if (!viewerCheck.ok) {
        return res
          .status(viewerCheck.status)
          .json({ success: false, error: viewerCheck.error });
      }
      
      const result = await orchestrator.startNextRound(normalizedGameId);
      res.json({
        success: result.success,
        data: projectGameStateForViewer(
          result.data,
          viewerCheck.viewerPlayerId,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

app.all('*', (req, res) => nextHandler(req, res));

async function startServer() {
  try {
    if (nextApp && typeof nextApp.prepare === 'function') {
      try {
        await nextApp.prepare();
      } catch (e) {
        console.warn('Next.js prepare failed, running without Next.js:', e);
      }
    }
    
    httpServer.listen(PORT, () => {
      console.log(`HTTP server running on port ${PORT}`);
      console.log(`WebSocket server running on ws://localhost:${PORT}/ws`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

void startServer();

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
