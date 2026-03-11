import { getSupabaseClient } from './supabase-client';
import { GameState, Player, GameConfig } from '../../types';

/**
 * 游戏数据库服务
 * 处理所有游戏相关的数据库持久化操作
 */
export class GameDatabaseService {
  private client: ReturnType<typeof getSupabaseClient> | null;

  constructor() {
    try {
      this.client = getSupabaseClient();
    } catch (error) {
      this.client = null;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Supabase is disabled: ${message}`);
    }
  }

  /**
   * 创建游戏记录
   */
  async createGame(gameId: string, config: GameConfig, initialState: GameState): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client
        .from('games')
        .insert({
          game_id: gameId,
          status: 'active',
          small_blind: config.smallBlind,
          big_blind: config.bigBlind,
          player_count: config.players.length,
          total_pot: 0,
          game_data: initialState,
        });

      if (error) {
        console.error('Failed to create game record:', error);
        throw error;
      }

      // 记录游戏参与者
      for (const player of initialState.players) {
        await this.createGamePlayer(gameId, player);
      }

      console.log(`Game record created: ${gameId}`);
    } catch (error) {
      console.error('Error creating game record:', error);
      throw error;
    }
  }

  /**
   * 创建游戏参与者记录
   */
  private async createGamePlayer(gameId: string, player: Player): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client
        .from('game_players')
        .insert({
          game_id: gameId,
          player_id: player.id,
          player_name: player.name,
          initial_chips: player.chips,
          final_chips: player.chips,
        });

      if (error) {
        console.error(`Failed to create game player record for ${player.id}:`, error);
        throw error;
      }
    } catch (error) {
      console.error('Error creating game player record:', error);
      throw error;
    }
  }

  /**
   * 记录玩家操作
   */
  async recordAction(
    gameId: string,
    playerId: string,
    actionType: string,
    amount: number | undefined,
    phase: string,
    potBefore: number,
    potAfter: number,
    chipsBefore: number,
    chipsAfter: number
  ): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client
        .from('game_actions')
        .insert({
          game_id: gameId,
          player_id: playerId,
          action_type: actionType,
          amount: amount || null,
          phase: phase,
          pot_before: potBefore,
          pot_after: potAfter,
          chips_before: chipsBefore,
          chips_after: chipsAfter,
        });

      if (error) {
        console.error('Failed to record action:', error);
        throw error;
      }

      console.log(`Action recorded: ${playerId} - ${actionType} in ${gameId}`);
    } catch (error) {
      console.error('Error recording action:', error);
      throw error;
    }
  }

  /**
   * 更新游戏状态
   */
  async updateGameState(gameId: string, gameState: GameState): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client
        .from('games')
        .update({
          total_pot: gameState.pot,
          game_data: gameState,
        })
        .eq('game_id', gameId);

      if (error) {
        console.error('Failed to update game state:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error updating game state:', error);
      throw error;
    }
  }

  /**
   * 结束游戏并记录结果
   */
  async endGame(gameId: string, gameState: GameState, winners: Player[]): Promise<void> {
    if (!this.client) return;
    try {
      // 更新游戏状态
      const { error: gameError } = await this.client
        .from('games')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          total_pot: gameState.pot,
          winner_id: winners.length > 0 ? winners[0].id : null,
          game_data: gameState,
        })
        .eq('game_id', gameId);

      if (gameError) {
        console.error('Failed to end game:', gameError);
        throw gameError;
      }

      // 更新玩家记录
      for (const player of gameState.players) {
        const isWinner = winners.some(w => w.id === player.id);
        const rank = isWinner ? 1 : gameState.players.indexOf(player) + 1;

        await this.client
          .from('game_players')
          .update({
            final_chips: player.chips,
            is_winner: isWinner,
            rank: rank,
          })
          .eq('game_id', gameId)
          .eq('player_id', player.id);

        // 更新玩家统计
        await this.updatePlayerStats(player.id, player.name, isWinner, player.chips);
      }

      console.log(`Game ended: ${gameId} with ${winners.length} winner(s)`);
    } catch (error) {
      console.error('Error ending game:', error);
      throw error;
    }
  }

  /**
   * 更新玩家统计
   */
  private async updatePlayerStats(
    playerId: string,
    playerName: string,
    isWinner: boolean,
    finalChips: number
  ): Promise<void> {
    if (!this.client) return;
    try {
      // 获取当前统计
      const { data: existingStats, error: fetchError } = await this.client
        .from('player_stats')
        .select('*')
        .eq('player_id', playerId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        console.error('Failed to fetch player stats:', fetchError);
        throw fetchError;
      }

      if (!existingStats) {
        // 创建新的玩家统计
        const profit = 0; // 初始无法计算利润，因为不知道初始筹码
        await this.client
          .from('player_stats')
          .insert({
            player_id: playerId,
            player_name: playerName,
            total_games: 1,
            wins: isWinner ? 1 : 0,
            total_profit: profit,
          });
      } else {
        // 更新现有统计
        const profit = finalChips - existingStats.total_profit; // 简化计算
        await this.client
          .from('player_stats')
          .update({
            total_games: existingStats.total_games + 1,
            wins: existingStats.wins + (isWinner ? 1 : 0),
            total_profit: existingStats.total_profit + profit,
            updated_at: new Date().toISOString(),
          })
          .eq('player_id', playerId);
      }
    } catch (error) {
      console.error('Error updating player stats:', error);
      throw error;
    }
  }

  /**
   * 获取游戏历史
   */
  async getGameHistory(limit: number = 10): Promise<unknown[]> {
    if (!this.client) return [];
    try {
      const { data, error } = await this.client
        .from('games')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Failed to fetch game history:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('Error fetching game history:', error);
      throw error;
    }
  }

  /**
   * 获取玩家统计数据
   */
  async getPlayerStats(playerId: string): Promise<unknown | null> {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client
        .from('player_stats')
        .select('*')
        .eq('player_id', playerId)
        .single();

      if (error) {
        console.error('Failed to fetch player stats:', error);
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error fetching player stats:', error);
      throw error;
    }
  }

  /**
   * 获取游戏操作日志
   */
  async getGameActions(gameId: string): Promise<unknown[]> {
    if (!this.client) return [];
    try {
      const { data, error } = await this.client
        .from('game_actions')
        .select('*')
        .eq('game_id', gameId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to fetch game actions:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('Error fetching game actions:', error);
      throw error;
    }
  }
}

// 导出单例
export const gameDatabaseService = new GameDatabaseService();
