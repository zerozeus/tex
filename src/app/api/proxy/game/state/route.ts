import { NextRequest, NextResponse } from 'next/server';

/**
 * /api/proxy/game/state
 *
 * 代理到游戏服务器的获取游戏状态接口
 */
async function proxyState(body: {
  gameId?: unknown;
  playerId?: unknown;
  playerToken?: unknown;
}) {
  const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : '';
  if (!gameId) {
    return NextResponse.json(
      { success: false, error: '缺少游戏ID' },
      { status: 400 }
    );
  }

  const gameServerUrl = process.env.GAME_SERVER_URL || 'http://localhost:5001';
  const response = await fetch(`${gameServerUrl}/api/game/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId,
      playerId: body.playerId,
      playerToken: body.playerToken,
    }),
  });

  const result = await response.json();
  return NextResponse.json(result, { status: response.status });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return await proxyState(body as { gameId?: unknown; playerId?: unknown; playerToken?: unknown });
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    return await proxyState({
      gameId: searchParams.get('gameId') ?? undefined,
      playerId: searchParams.get('playerId') ?? undefined,
      playerToken: searchParams.get('playerToken') ?? undefined,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}
