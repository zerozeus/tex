import express from 'express';
import cors from 'cors';
import { WebSocketHandler } from './websocket-handler';
import { GameConfig } from './types';
import { gameDatabaseService } from './storage/database/game-database.service';
import { installConsoleFileLogging } from './utils/logger';
import next from 'next';
import path from 'path';
import { createServer } from 'http';

import { GameLock } from './infra/GameLock';
import { BotService } from './bot/BotService';
import { GameOrchestrator } from './orchestrator/GameOrchestrator';

installConsoleFileLogging();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const dev = process.env.NODE_ENV !== 'production';
const projectRoot = path.resolve(__dirname, '..', '..');
const nextApp = next({ dev, dir: projectRoot });
const nextHandler = nextApp.getRequestHandler();
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

app.use((req, res, next) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  const url = req.originalUrl || req.url;

  console.log(`[${new Date().toISOString()}] [${requestId}] ${req.method} ${url}`);
  if (DEBUG_LOG && req.body && Object.keys(req.body).length > 0) {
    console.log(`[${requestId}] body=${safeStringify(req.body)}`);
  }

  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] [${requestId}] ${req.method} ${url} -> ${res.statusCode} (${Date.now() - start}ms)`
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

// WebSocket处理器
const wsHandler = new WebSocketHandler({ server: httpServer, path: '/ws' });

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
      data: gameState,
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
    const { gameId } = req.query;

    if (!gameId || typeof gameId !== 'string') {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(gameId);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    res.json({
      success: true,
      data: game.getGameState(),
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
  try {
    const { gameId, playerId, action, amount } = req.body;

    if (!gameId || !playerId || !action) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数',
      });
    }

    // 使用 orchestrator 处理动作
    const result = await orchestrator.submitPlayerAction(gameId, playerId, action, amount);

    if (result.success) {
      // 获取最新状态返回给前端
      const game = wsHandler.getGame(gameId);
      res.json({
        success: true,
        data: game?.getGameState(),
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
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
    const { gameId } = req.body;

    if (!gameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(gameId);
    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    const result = await orchestrator.settleShowdown(gameId);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: game.getGameState(),
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
    const { gameId } = req.body;

    if (!gameId) {
      return res.status(400).json({
        success: false,
        error: '缺少游戏ID',
      });
    }

    const game = wsHandler.getGame(gameId);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: '游戏不存在',
      });
    }

    // 获取当前游戏状态
    const gameState = game.getGameState();

    res.json({
      success: true,
      data: gameState,
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
      const { gameId } = req.body;
      const game = wsHandler.getGame(gameId);
      if (!game) {
        throw new Error('Game not found');
      }
      
      const result = await orchestrator.startNextRound(gameId);
      res.json({ success: result.success, data: game.getGameState() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

app.all('*', (req, res) => nextHandler(req, res));

void nextApp
  .prepare()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`HTTP server running on port ${PORT}`);
      console.log(`WebSocket server running on ws://localhost:${PORT}/ws`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
