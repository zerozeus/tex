import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/proxy/game/state
 * 
 * 代理到游戏服务器的获取游戏状态接口
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const gameId = searchParams.get('gameId');

    if (!gameId) {
      return NextResponse.json(
        { success: false, error: '缺少游戏ID' },
        { status: 400 }
      );
    }

    // 调用游戏服务器
    const response = await fetch(`${process.env.GAME_SERVER_URL || 'http://localhost:5001'}/api/game/state?gameId=${gameId}`);
    const result = await response.json();
    
    return NextResponse.json(result);
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}
