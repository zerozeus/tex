import { NextRequest, NextResponse } from 'next/server';
import {
  createInitialGameState,
  saveGameState,
  GameState,
} from '@/lib/game-utils';

/**
 * POST /api/game/init
 * 
 * 初始化新的一局德州扑克游戏
 * 
 * 请求体:
 * {
 *   "players": [
 *     { "id": 1, "name": "玩家 1", "chips": 2000 },
 *     { "id": 2, "name": "玩家 2", "chips": 2000 },
 *     { "id": 3, "name": "玩家 3", "chips": 2000 }
 *   ],
 *   "smallBlind": 100,
 *   "bigBlind": 200,
 *   "timeLimit": 30
 * }
 * 
 * 响应:
 * {
 *   "success": true,
 *   "data": {
 *     "gameId": "game-001",
 *     "phase": "preflop",
 *     "pot": 30,
 *     "currentBet": 20,
 *     "communityCards": [],
 *     "players": [...],
 *     "currentPlayerIndex": 0,
 *     "timeRemaining": 30
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { players, smallBlind = 100, bigBlind = 200, timeLimit = 30 } = body;

    // 验证玩家数量（2-9人）
    if (!players || players.length < 2 || players.length > 9) {
      return NextResponse.json(
        { success: false, error: '玩家数量必须在2-9人之间' },
        { status: 400 }
      );
    }

    // 验证每个玩家的数据
    for (const player of players) {
      if (!player.id || !player.name || typeof player.chips !== 'number') {
        return NextResponse.json(
          { success: false, error: '玩家数据格式错误' },
          { status: 400 }
        );
      }

      if (player.chips < bigBlind) {
        return NextResponse.json(
          {
            success: false,
            error: `玩家 ${player.name} 的筹码不足大盲注 (${bigBlind})`
          },
          { status: 400 }
        );
      }
    }

    // 验证盲注
    if (smallBlind <= 0 || bigBlind <= 0) {
      return NextResponse.json(
        { success: false, error: '盲注必须大于0' },
        { status: 400 }
      );
    }

    if (bigBlind < smallBlind) {
      return NextResponse.json(
        { success: false, error: '大盲注不能小于小盲注' },
        { status: 400 }
      );
    }

    // 验证时间限制
    if (timeLimit < 10 || timeLimit > 300) {
      return NextResponse.json(
        { success: false, error: '时间限制必须在10-300秒之间' },
        { status: 400 }
      );
    }

    // 创建初始游戏状态
    const gameState = createInitialGameState(players, {
      smallBlind,
      bigBlind,
      timeLimit,
    });

    // 保存游戏状态
    saveGameState(gameState);

    return NextResponse.json({
      success: true,
      message: '游戏初始化成功',
      data: gameState,
    });
  } catch (error) {
    console.error('Game init error:', error);
    return NextResponse.json(
      { success: false, error: '游戏初始化失败' },
      { status: 500 }
    );
  }
}
