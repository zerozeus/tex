import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const gameServerUrl = process.env.GAME_SERVER_URL || 'http://localhost:5001';
    
    // 调用游戏服务器
    const response = await fetch(`${gameServerUrl}/api/bots`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
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
