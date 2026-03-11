import { Player, GameState } from '../types';

// Node.js 18+ has built-in fetch

export class BotService {
  async getDecision(
    state: GameState,
    botPlayer: Player,
  ): Promise<{ action: string; amount?: number; reason?: string; chat?: string }> {
    const raw = await this.callCoze(state, botPlayer);
    return this.normalizeDecision(raw);
  }

  private async callCoze(state: GameState, botPlayer: Player): Promise<unknown> {
    const botToken = botPlayer.botToken;
    if (!botToken) {
      console.warn('⚠️ 未提供API Token，使用默认策略');
      return this.getDefaultDecision(state, botPlayer);
    }

    if (!botPlayer.sessionId) {
      botPlayer.sessionId = `session_${botPlayer.id}_${Date.now()}`;
    }

    const prompt = this.buildDecisionPrompt(state, botPlayer);
    
    console.log(`\n=== 🤖 Bot Prompt (${botPlayer.name}) ===`);
    console.log(prompt);
    console.log('=====================================\n');

    const projectId = botPlayer.botId || '7615209749759426602';
    const apiUrl = 'https://rz2qynsv9r.coze.site/stream_run';

    const payload = {
      content: {
        query: {
          prompt: [
            {
              type: 'text',
              content: {
                text: prompt,
              },
            },
          ],
        },
      },
      type: 'query',
      session_id: botPlayer.sessionId,
      project_id: projectId,
    };

    console.log(`📡 Bot ${botPlayer.name} calling Coze API...`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`API Error ${response.status}: ${await response.text()}`);
      }

      const responseText = await response.text();
      const parsed = this.parseCozeResponse(responseText);
      
      console.log(`\n=== 🤖 Bot Response (${botPlayer.name}) ===`);
      console.log(JSON.stringify(parsed, null, 2));
      console.log('======================================\n');
      
      return parsed;
    } catch (error) {
      console.error(`❌ Bot ${botPlayer.name} decision failed:`, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseCozeResponse(responseText: string): unknown {
    let fullContent = '';
    const lines = responseText.split('\n');

    for (const line of lines) {
      if (line.startsWith('data:')) {
        const dataStr = line.substring(5).trim();
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>;
          const content = data.content;
          if (
            data.type === 'answer' &&
            typeof content === 'object' &&
            content !== null &&
            'answer' in content &&
            typeof (content as Record<string, unknown>).answer === 'string'
          ) {
            fullContent += (content as Record<string, unknown>).answer as string;
          } else if (data.type === 'message' && data.role === 'assistant') {
            if (typeof data.content === 'string') fullContent += data.content;
          }
        } catch {
        }
      }
    }

    if (!fullContent) {
      try {
        const data = JSON.parse(responseText) as Record<string, unknown>;
        if (typeof data.data === 'string') fullContent = data.data;
        else if (typeof data.content === 'string') fullContent = data.content;
      } catch {
      }
    }

    if (!fullContent && responseText.trim()) {
       fullContent = responseText.replace(/^data: /gm, '').replace(/\n/g, '');
    }
    
    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      fullContent = jsonMatch[0];
    } else {
       fullContent = fullContent.replace(/```json/g, '').replace(/```/g, '').trim();
    }

    try {
      return JSON.parse(fullContent);
    } catch {
      console.error('Failed to parse JSON from content:', fullContent);
      throw new Error('Invalid JSON response from bot');
    }
  }

  private normalizeDecision(raw: unknown): { action: string; amount?: number; reason?: string; chat?: string } {
    const data = (raw ?? {}) as Record<string, unknown>;
    const action = String(data.action || '').toLowerCase();
    const amount = data.amount != null ? Number(data.amount) : undefined;
    const reasonValue = data.reason ?? data.reasoning;
    const reason = typeof reasonValue === 'string' ? reasonValue : undefined;
    const chat = typeof data.chat === 'string' ? data.chat : undefined;

    if (['fold', 'check', 'call', 'allin'].includes(action)) {
      return { action, reason, chat };
    }

    if (action === 'bet' || action === 'raise') {
      return { action, amount, reason, chat };
    }

    throw new Error(`invalid bot action: ${JSON.stringify(raw)}`);
  }

  private getDefaultDecision(state: GameState, botPlayer: Player) {
    const toCall = state.currentBet - botPlayer.bet;
    if (toCall <= 0) return { action: 'check', reason: 'Default fallback' };
    return { action: 'call', reason: 'Default fallback' };
  }

  private buildDecisionPrompt(gameState: GameState, botPlayer: Player): string {
    const toCall = gameState.currentBet - botPlayer.bet;
    const handDesc = botPlayer.cards.map(card => `${card.rank}${card.suit}`).join(', ');
    const communityDesc = gameState.communityCards.length > 0 
      ? gameState.communityCards.map(card => `${card.rank}${card.suit}`).join(', ') 
      : '暂无';
    
    const playersDesc = gameState.players
      .filter(p => p.id !== botPlayer.id && !p.isFolded)
      .map(p => `${p.name}: 筹码${p.chips}, 下注${p.bet}`)
      .join('\n');

    return `
你是玩家 ${botPlayer.name}。

当前游戏状态：
- 游戏阶段: ${gameState.phase}
- 你的手牌: ${handDesc}
- 公共牌: ${communityDesc}
- 底池: ${gameState.pot}
- 当前最高下注: ${gameState.currentBet}
- 你当前下注: ${botPlayer.bet}
- 需要跟注: ${toCall}
- 你的筹码: ${botPlayer.chips}

其他活跃玩家：
${playersDesc}

请务必只返回一个 JSON 对象，不要包含任何 markdown 格式或其他文本。格式如下：
{
  "action": "fold|check|call|bet|raise|allin",
  "amount": <number> (仅在 bet/raise 时需要),
  "reason": "简短决策理由",
  "chat": "你可以在这里说一句话来迷惑对手或表达情绪（可选）"
}`;
  }
}
