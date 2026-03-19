import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/proxy/game/next-round
 * 
 * 代理到游戏服务器的下一局接口
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const gameServerUrl = process.env.GAME_SERVER_URL || 'http://localhost:5001';
    const debug = process.env.POKER_DEBUG !== '0';
    
    // 调用游戏服务器
    const start = Date.now();
    const response = await fetch(`${gameServerUrl}/api/game/next-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (debug) {
      console.log('[proxy][next-round]', {
        status: response.status,
        statusText: response.statusText,
        bytes: text.length,
        ms: Date.now() - start,
        gameId: (body as { gameId?: unknown } | null)?.gameId,
      });
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof parsed === 'string'
          ? parsed
          : (parsed as { error?: string; message?: string } | null)?.error ||
            (parsed as { error?: string; message?: string } | null)?.message ||
            response.statusText ||
            `HTTP ${response.status}`;
      return NextResponse.json({ success: false, error: message }, { status: response.status });
    }

    if (!text) {
      return NextResponse.json({ success: true }, { status: 200 });
    }

    if (typeof parsed === 'string') {
      return NextResponse.json({ success: true, message: parsed }, { status: response.status });
    }

    return NextResponse.json(parsed, { status: response.status });
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}
