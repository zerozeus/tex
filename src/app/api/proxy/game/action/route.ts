import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/proxy/game/action
 * 
 * 代理到游戏服务器的玩家操作接口
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // 调用游戏服务器
    const response = await fetch(`${process.env.GAME_SERVER_URL || 'http://localhost:5001'}/api/game/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
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
