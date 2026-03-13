import { GameEngine } from '../game-engine';
import { BotService } from '../bot/BotService';
import { GameLock } from '../infra/GameLock';
import { gameDatabaseService } from '../storage/database/game-database.service';
import { GameState, Player } from '../types';

const DEBUG_LOG = process.env.POKER_DEBUG === '1';

function summarizeState(state: GameState): Record<string, unknown> {
  return {
    gameId: state.gameId,
    phase: state.phase,
    endType: state.endType,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    currentPlayerIndex: state.currentPlayerIndex,
    resultReady: state.resultReady,
    winners: state.winners?.map(w => w.id),
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      isFolded: p.isFolded,
      isAllIn: p.isAllIn,
      isBot: p.isBot,
    })),
  };
}

function debugLog(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_LOG) return;
  console.log(`[orchestrator] ${event}`, payload);
}

type Broadcaster = {
  broadcastGameState: (gameId: string, state: GameState) => Promise<void> | void;
  broadcastBotThinking: (gameId: string, payload: unknown) => Promise<void> | void;
  broadcastBotDecision: (gameId: string, payload: unknown) => Promise<void> | void;
};

export class GameOrchestrator {
  private handResultNotified = new Map<string, number>();

  constructor(
    private engineMap: Map<string, GameEngine>,
    private botService: BotService,
    private broadcaster: Broadcaster,
    private gameLock: GameLock,
  ) {}

  async settleShowdown(gameId: string) {
    return this.gameLock.withLock(gameId, async () => {
      const engine = this.mustGetEngine(gameId);
      debugLog('settleShowdown:start', { gameId, before: summarizeState(engine.getGameState()) });

      const result = engine.settleShowdown();
      if (!result.success) {
        debugLog('settleShowdown:fail', { gameId, error: result.error ?? 'unknown' });
        return result;
      }

      const stateAfter = engine.getGameState();
      debugLog('settleShowdown:done', { gameId, after: summarizeState(stateAfter) });

      try {
        await gameDatabaseService.updateGameState(gameId, stateAfter);
      } catch (e) {
        console.error('Failed to record showdown settle to database:', e);
      }

      await this.broadcaster.broadcastGameState(gameId, stateAfter);
      await this.notifyBotsHandResultIfNeeded(gameId, stateAfter);
      return { success: true };
    });
  }

  async submitPlayerAction(gameId: string, playerId: string, action: string, amount?: number) {
    return this.gameLock.withLock(gameId, async () => {
      const engine = this.mustGetEngine(gameId);

      // Capture state before action for DB logging
      const stateBefore = engine.getGameState();
      debugLog('playerAction:start', { gameId, playerId, action, amount: amount ?? null, before: summarizeState(stateBefore) });
      const playerBefore = stateBefore.players.find(p => p.id === playerId);
      const chipsBefore = playerBefore ? playerBefore.chips : 0;
      const potBefore = stateBefore.pot;

      const result = engine.handleAction(playerId, action, amount);
      if (!result.success) {
        debugLog('playerAction:fail', { gameId, playerId, action, amount: amount ?? null, error: result.error ?? 'unknown' });
        return result;
      }

      // Record to DB
      const stateAfter = engine.getGameState();
      debugLog('playerAction:done', { gameId, playerId, action, amount: amount ?? null, after: summarizeState(stateAfter) });
      const playerAfter = stateAfter.players.find(p => p.id === playerId);
      const chipsAfter = playerAfter ? playerAfter.chips : 0;

      try {
        await gameDatabaseService.recordAction(
          gameId,
          playerId,
          action,
          amount,
          stateAfter.phase,
          potBefore,
          stateAfter.pot,
          chipsBefore,
          chipsAfter
        );
        await gameDatabaseService.updateGameState(gameId, stateAfter);
      } catch (e) {
        console.error('Failed to record player action to database:', e);
      }

      await this.broadcaster.broadcastGameState(gameId, stateAfter);
      await this.notifyBotsHandResultIfNeeded(gameId, stateAfter);
      
      if (stateAfter.phase === 'showdown' && stateAfter.players.every(p => p.isBot)) {
        const settleResult = engine.settleShowdown();
        if (settleResult.success) {
          const finalState = engine.getGameState();
          try {
            await gameDatabaseService.updateGameState(gameId, finalState);
          } catch (e) {
            console.error('Failed to record bot-only showdown settle to database:', e);
          }
          await this.broadcaster.broadcastGameState(gameId, finalState);
          await this.notifyBotsHandResultIfNeeded(gameId, finalState);
          return { success: true };
        }
      }

      try {
        await this.driveBots(gameId, engine);
      } catch (e) {
        console.error(`Error driving bots for game ${gameId}:`, e);
      }

      return { success: true };
    });
  }

  async startNextRound(gameId: string) {
    return this.gameLock.withLock(gameId, async () => {
      const engine = this.mustGetEngine(gameId);
      const state = engine.getGameState();
      debugLog('nextRound:start', { gameId, before: summarizeState(state) });
      
      if (state.phase === 'completed') {
        engine.nextRound();
        const newState = engine.getGameState();
        debugLog('nextRound:done', { gameId, after: summarizeState(newState) });
        
        // Broadcast new state
        await this.broadcaster.broadcastGameState(gameId, newState);
        
        // Drive bots if it's bot's turn
        try {
          await this.driveBots(gameId, engine);
        } catch (e) {
          console.error(`Error driving bots for game ${gameId}:`, e);
        }
      } else {
        debugLog('nextRound:skip', { gameId, phase: state.phase });
      }
      
      return { success: true };
    });
  }

  async startGame(gameId: string) {
    return this.gameLock.withLock(gameId, async () => {
      const engine = this.mustGetEngine(gameId);
      
      try {
        await this.driveBots(gameId, engine);
      } catch (e) {
        console.error(`Error driving bots for game ${gameId}:`, e);
      }

      return { success: true };
    });
  }

  private async driveBots(gameId: string, engine: GameEngine) {
    const MAX_CHAIN_STEPS = 20;

    for (let i = 0; i < MAX_CHAIN_STEPS; i++) {
      const state = engine.getGameState();

      if (state.phase === 'completed' || state.phase === 'showdown') return;
      if (!engine.isCurrentPlayerBot()) return;

      const bot = engine.getCurrentBotPlayer();
      if (!bot) return;

      console.log(`🤖 Bot ${bot.name} (ID: ${bot.id}) turn in game ${gameId}`);
      debugLog('bot:turn', { gameId, step: i, botId: bot.id, botName: bot.name, state: summarizeState(state) });

      await this.broadcaster.broadcastBotThinking(gameId, {
        type: 'bot_thinking',
        gameId,
        playerId: bot.id,
        playerName: bot.name,
      });

      let decision: { action: string; amount?: number; reason?: string; chat?: string };

      try {
        decision = await this.botService.getDecision(state, bot);
      } catch (e) {
        console.error(`Bot decision failed for ${bot.name}:`, e);
        decision = this.makeFallbackDecision(engine, bot.id);
      }
      debugLog('bot:decision', { gameId, step: i, botId: bot.id, action: decision.action, amount: decision.amount ?? null });

      await this.broadcaster.broadcastBotDecision(gameId, {
        type: 'bot_decision',
        gameId,
        playerId: bot.id,
        playerName: bot.name,
        action: decision.action,
        amount: decision.amount,
        chat: decision.chat,
      });

      // Capture state before bot action
      const botStateBefore = engine.getGameState();
      const botChipsBefore = bot.chips;
      const botPotBefore = botStateBefore.pot;

      let result = engine.handleAction(bot.id, decision.action, decision.amount);

      if (!result.success) {
        console.warn(`Bot action failed: ${decision.action}, trying fallback`);
        const fallback = this.makeFallbackDecision(engine, bot.id);
        
        // Update decision for DB logging
        decision = { action: fallback.action, amount: fallback.amount, reason: 'Fallback after failure' };
        
        result = engine.handleAction(bot.id, fallback.action, fallback.amount);

        if (!result.success) {
          throw new Error(`bot action failed twice: game=${gameId}, bot=${bot.name}`);
        }
      }

      // Record bot action to DB
      const botStateAfter = engine.getGameState();
      debugLog('bot:applied', { gameId, step: i, botId: bot.id, after: summarizeState(botStateAfter) });
      const botAfter = botStateAfter.players.find(p => p.id === bot.id);
      const botChipsAfter = botAfter ? botAfter.chips : 0;

      try {
        await gameDatabaseService.recordAction(
          gameId,
          bot.id,
          decision.action,
          decision.amount,
          botStateAfter.phase,
          botPotBefore,
          botStateAfter.pot,
          botChipsBefore,
          botChipsAfter
        );
        await gameDatabaseService.updateGameState(gameId, botStateAfter);
      } catch (e) {
        console.error('Failed to record bot action to database:', e);
      }

      await this.broadcaster.broadcastGameState(gameId, botStateAfter);
      await this.notifyBotsHandResultIfNeeded(gameId, botStateAfter);
    }

    throw new Error(`bot chain overflow: game=${gameId}`);
  }

  private async notifyBotsHandResultIfNeeded(gameId: string, state: GameState) {
    if (state.phase !== 'completed') return;
    if (this.handResultNotified.get(gameId) === state.handNumber) return;

    this.handResultNotified.set(gameId, state.handNumber);
    try {
      await this.botService.notifyHandResult(state);
    } catch (e) {
      console.error(`Failed to notify bots hand result: game=${gameId}`, e);
    }
  }



  private makeFallbackDecision(engine: GameEngine, playerId: string): { action: string; amount?: number } {
    const state = engine.getGameState();
    const p = state.players.find((x: Player) => x.id === playerId);

    if (!p) return { action: 'fold' };

    const toCall = state.currentBet - p.bet;
    if (toCall <= 0) return { action: 'check' };
    return { action: 'call' };
  }

  private mustGetEngine(gameId: string) {
    const engine = this.engineMap.get(gameId);
    if (!engine) throw new Error(`game not found: ${gameId}`);
    return engine;
  }
}
