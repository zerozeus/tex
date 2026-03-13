import { NextRequest, NextResponse } from 'next/server';
import { getGameState } from '@/lib/game-utils';

/**
 * /api/game/state
 *
 * 获取当前游戏状态
 *
 * TODO: 请在此实现以下功能：
 * 1. 从数据库或内存中获取游戏状态
 * 2. 返回完整的游戏信息
 * 
 * 请求参数:
 * - gameId: 游戏ID
 * - playerId/playerToken: 可选，当前 mock 实现不会使用
 * 
 * 响应示例:
 * {
 *   "success": true,
 *   "data": {
 *     "gameId": "game-001",
 *     "phase": "flop",
 *     "pot": 150,
 *     "currentBet": 0,
 *     "communityCards": [
 *       { "suit": "♠", "rank": "A", "value": 14 },
 *       { "suit": "♥", "rank": "K", "value": 13 },
 *       { "suit": "♦", "rank": "Q", "value": 12 }
 *     ],
 *     "players": [
 *       {
 *         "id": 1,
 *         "name": "玩家 1",
 *         "chips": 980,
 *         "cards": [
 *           { "suit": "♠", "rank": "A", "value": 14 },
 *           { "suit": "♦", "rank": "K", "value": 13 }
 *         ],
 *         "bet": 0,
 *         "isFolded": false,
 *         "isDealer": true,
 *         "isCurrent": false
 *       },
 *       {
 *         "id": 2,
 *         "name": "玩家 2",
 *         "chips": 950,
 *         "cards": [
 *           { "suit": "♥", "rank": "Q", "value": 12 },
 *           { "suit": "♣", "rank": "J", "value": 11 }
 *         ],
 *         "bet": 0,
 *         "isFolded": false,
 *         "isDealer": false,
 *         "isCurrent": true
 *       }
 *     ],
 *     "currentPlayerIndex": 1,
 *     "timeRemaining": 30
 *   }
 * }
 */
function buildStateResponse(gameId: string) {
  const normalizedGameId = gameId.trim();
  if (!normalizedGameId) {
    return NextResponse.json(
      { success: false, error: '缺少游戏ID' },
      { status: 400 }
    );
  }

  const gameState = getGameState(normalizedGameId);
  if (!gameState) {
    return NextResponse.json(
      { success: false, error: '游戏不存在或已过期' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: gameState,
  });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const gameId = searchParams.get('gameId') || '';
    return buildStateResponse(gameId);
  } catch (error) {
    console.error('Get game state error:', error);
    return NextResponse.json(
      { success: false, error: '获取游戏状态失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { gameId?: unknown };
    const gameId = typeof body.gameId === 'string' ? body.gameId : '';
    return buildStateResponse(gameId);
  } catch (error) {
    console.error('Get game state error:', error);
    return NextResponse.json(
      { success: false, error: '获取游戏状态失败' },
      { status: 500 }
    );
  }
}
