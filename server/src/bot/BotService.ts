import { Player, GameState, GameHistoryEvent } from '../types';

// Node.js 18+ has built-in fetch

const DEFAULT_COZE_TIMEOUT_MS = 120000;

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
    const contextSummary = this.buildContextSummary(state, botPlayer);
    
    console.log(`\n=== 🤖 Bot Context Summary (${botPlayer.name}) ===`);
    console.log(JSON.stringify(contextSummary, null, 2));
    console.log('==============================================\n');

    console.log(`\n=== 🤖 Bot Prompt (${botPlayer.name}) ===`);
    console.log(prompt);
    console.log('=====================================\n');

    const projectId = botPlayer.botId || '7615209749759426602';
    const apiUrl = botPlayer.apiUrl || 'https://rz2qynsv9r.coze.site/stream_run';

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

    console.log(`📡 Bot ${botPlayer.name}: ${projectId} calling Coze API...`);

    const timeoutMs = this.getCozeTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Coze request timeout after ${timeoutMs}ms`);
      }
      console.error(`❌ Bot ${botPlayer.name} decision failed:`, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private getCozeTimeoutMs(): number {
    const value = Number(process.env.COZE_REQUEST_TIMEOUT_MS ?? '');
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_COZE_TIMEOUT_MS;
    }
    return Math.floor(value);
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
    const historyDesc = this.formatActionHistory(gameState.actionHistory ?? []);
    
    const playersDesc = gameState.players
      .filter(p => p.id !== botPlayer.id && !p.isFolded)
      .map(p => `- ${p.name}: 筹码 ${p.chips}, 当前下注 ${p.bet}, ${p.isAllIn ? '已全押' : '仍可行动'}`)
      .join('\n');

    return `
你是德州扑克玩家 ${botPlayer.name}。你只能基于可见信息做决定，不能假设知道他人手牌。

【你的视角】
- 当前手数: 第 ${gameState.handNumber} 手
- 当前阶段: ${gameState.phase}
- 你的手牌: ${handDesc}
- 公共牌: ${communityDesc}
- 你的筹码: ${botPlayer.chips}
- 你本轮已下注: ${botPlayer.bet}
- 当前最高下注: ${gameState.currentBet}
- 你还需跟注: ${toCall}
- 当前底池: ${gameState.pot}
- 最小加注增量: ${gameState.minRaise}

【其他仍在局玩家】
${playersDesc || '- 无'}

【本手历史上下文】
${historyDesc}

【决策要求】
- 结合当前阶段、本手下注历史、对手压力、你的筹码深度做决策。
- 优先判断当前是否合法行动，以及是否有足够理由激进下注。
- 如果选择 bet 或 raise，amount 必须是一个具体数字。
- reason 要简短但要点明确。
- chat 可选，可以是简短桌上发言。

【输出格式】
只返回一个 JSON 对象，不要返回 markdown，不要返回解释性前后缀：
{
  "action": "fold|check|call|bet|raise|allin",
  "amount": <number>,
  "reason": "简短决策理由",
  "chat": "可选"
}`;
  }

  private formatActionHistory(history: GameHistoryEvent[]): string {
    if (history.length === 0) {
      return '- 暂无历史记录';
    }

    const recentHistory = history.slice(-24);
    return recentHistory.map((event) => this.formatHistoryEvent(event)).join('\n');
  }

  private formatHistoryEvent(event: GameHistoryEvent): string {
    switch (event.kind) {
      case 'hand_start':
        return `- #${event.sequence} [开始] ${event.note}`;
      case 'blind':
        return `- #${event.sequence} [${event.phase}] ${event.playerName} 支付${event.blindType === 'small' ? '小盲' : '大盲'} ${event.amount ?? 0}，底池 ${event.pot ?? 0}`;
      case 'phase_change':
        return `- #${event.sequence} [转阶段] ${event.note}${event.communityCards?.length ? `，公共牌: ${event.communityCards.join(', ')}` : ''}`;
      case 'hand_end':
        return `- #${event.sequence} [结束] ${event.note}`;
      case 'action': {
        const amountDesc = event.amount != null ? `，投入 ${event.amount}` : '';
        const betDesc = event.playerBet != null ? `，本轮下注 ${event.playerBet}` : '';
        const potDesc = event.pot != null ? `，底池 ${event.pot}` : '';
        return `- #${event.sequence} [${event.phase}] ${event.playerName} ${event.action}${amountDesc}${betDesc}${potDesc}`;
      }
      default:
        return `- #${event.sequence} ${event.note ?? '未知事件'}`;
    }
  }

  private buildContextSummary(gameState: GameState, botPlayer: Player) {
    const toCall = gameState.currentBet - botPlayer.bet;
    const visibleOpponents = gameState.players
      .filter((player) => player.id !== botPlayer.id && !player.isFolded)
      .map((player) => ({
        id: player.id,
        name: player.name,
        chips: player.chips,
        bet: player.bet,
        isAllIn: player.isAllIn,
        isBot: player.isBot,
      }));

    return {
      gameId: gameState.gameId,
      handNumber: gameState.handNumber,
      phase: gameState.phase,
      bot: {
        id: botPlayer.id,
        name: botPlayer.name,
        chips: botPlayer.chips,
        bet: botPlayer.bet,
        toCall,
        cards: botPlayer.cards.map((card) => `${card.rank}${card.suit}`),
      },
      board: gameState.communityCards.map((card) => `${card.rank}${card.suit}`),
      pot: gameState.pot,
      currentBet: gameState.currentBet,
      minRaise: gameState.minRaise,
      visibleOpponents,
      historyCount: gameState.actionHistory?.length ?? 0,
      recentHistory: (gameState.actionHistory ?? []).slice(-12).map((event) => this.formatHistoryEvent(event)),
    };
  }
}
