import { getSupabaseClient } from './src/storage/database/supabase-client';

async function testDatabase() {
  const client = getSupabaseClient();

  console.log('Testing database functionality...\n');

  // 测试1: 查询游戏记录
  console.log('1. Fetching games...');
  const { data: games, error: gamesError } = await client
    .from('games')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  if (gamesError) {
    console.error('Error fetching games:', gamesError);
  } else {
    console.log(`Found ${games.length} games:`);
    games.forEach((game, index) => {
      console.log(`  ${index + 1}. Game ID: ${game.game_id}`);
      console.log(`     Status: ${game.status}`);
      console.log(`     Players: ${game.player_count}`);
      console.log(`     Pot: ${game.total_pot}`);
      console.log(`     Created: ${game.created_at}`);
      console.log('');
    });
  }

  // 测试2: 查询游戏参与者
  console.log('\n2. Fetching game players...');
  if (games && games.length > 0) {
    const { data: players, error: playersError } = await client
      .from('game_players')
      .select('*')
      .eq('game_id', games[0].game_id);

    if (playersError) {
      console.error('Error fetching players:', playersError);
    } else {
      console.log(`Found ${players.length} players in game ${games[0].game_id}:`);
      players.forEach((player, index) => {
        console.log(`  ${index + 1}. ${player.player_name} (${player.player_id})`);
        console.log(`     Initial Chips: ${player.initial_chips}`);
        console.log(`     Final Chips: ${player.final_chips}`);
        console.log(`     Winner: ${player.is_winner}`);
        console.log('');
      });
    }
  }

  // 测试3: 查询操作日志
  console.log('\n3. Fetching game actions...');
  if (games && games.length > 0) {
    const { data: actions, error: actionsError } = await client
      .from('game_actions')
      .select('*')
      .eq('game_id', games[0].game_id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (actionsError) {
      console.error('Error fetching actions:', actionsError);
    } else {
      console.log(`Found ${actions.length} actions in game ${games[0].game_id}:`);
      actions.forEach((action, index) => {
        console.log(`  ${index + 1}. ${action.player_id} - ${action.action_type}`);
        if (action.amount) {
          console.log(`     Amount: ${action.amount}`);
        }
        console.log(`     Phase: ${action.phase}`);
        console.log(`     Pot: ${action.pot_before} → ${action.pot_after}`);
        console.log(`     Chips: ${action.chips_before} → ${action.chips_after}`);
        console.log(`     Time: ${action.created_at}`);
        console.log('');
      });
    }
  }

  // 测试4: 查询玩家统计
  console.log('\n4. Fetching player stats...');
  if (games && games.length > 0) {
    const { data: players, error: playersError } = await client
      .from('game_players')
      .select('*')
      .eq('game_id', games[0].game_id);

    if (playersError) {
      console.error('Error fetching players for stats:', playersError);
    } else {
      for (const player of players) {
        const { data: stats, error: statsError } = await client
          .from('player_stats')
          .select('*')
          .eq('player_id', player.player_id)
          .single();

        if (statsError) {
          console.error(`Error fetching stats for ${player.player_id}:`, statsError);
        } else {
          console.log(`  ${player.player_name} (${player.player_id}):`);
          console.log(`     Total Games: ${stats.total_games}`);
          console.log(`     Wins: ${stats.wins}`);
          console.log(`     Total Profit: ${stats.total_profit}`);
          console.log(`     Last Updated: ${stats.updated_at}`);
          console.log('');
        }
      }
    }
  }

  console.log('Database test completed!');
}

testDatabase().catch(console.error);
