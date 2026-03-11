import { pgTable, serial, timestamp, varchar, integer, text, jsonb, boolean, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// 游戏记录表
export const games = pgTable(
  "games",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 100 }).notNull().unique(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    smallBlind: integer("small_blind").notNull(),
    bigBlind: integer("big_blind").notNull(),
    playerCount: integer("player_count").notNull(),
    winnerId: varchar("winner_id", { length: 50 }),
    totalPot: integer("total_pot").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
    gameData: jsonb("game_data"),
  },
  (table) => [
    index("games_game_id_idx").on(table.gameId),
    index("games_status_idx").on(table.status),
    index("games_created_at_idx").on(table.createdAt),
  ]
)

// 游戏参与者表
export const gamePlayers = pgTable(
  "game_players",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 100 }).notNull(),
    playerId: varchar("player_id", { length: 50 }).notNull(),
    playerName: varchar("player_name", { length: 100 }).notNull(),
    initialChips: integer("initial_chips").notNull(),
    finalChips: integer("final_chips"),
    isWinner: boolean("is_winner").notNull().default(false),
    rank: integer("rank"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index("game_players_game_id_idx").on(table.gameId),
    index("game_players_player_id_idx").on(table.playerId),
  ]
)

// 操作日志表
export const gameActions = pgTable(
  "game_actions",
  {
    id: serial("id").primaryKey(),
    gameId: varchar("game_id", { length: 100 }).notNull(),
    playerId: varchar("player_id", { length: 50 }).notNull(),
    actionType: varchar("action_type", { length: 20 }).notNull(),
    amount: integer("amount"),
    phase: varchar("phase", { length: 20 }).notNull(),
    potBefore: integer("pot_before").notNull().default(0),
    potAfter: integer("pot_after").notNull().default(0),
    chipsBefore: integer("chips_before").notNull().default(0),
    chipsAfter: integer("chips_after").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index("game_actions_game_id_idx").on(table.gameId),
    index("game_actions_player_id_idx").on(table.playerId),
    index("game_actions_created_at_idx").on(table.createdAt),
  ]
)

// 玩家统计表
export const playerStats = pgTable(
  "player_stats",
  {
    id: serial("id").primaryKey(),
    playerId: varchar("player_id", { length: 50 }).notNull().unique(),
    playerName: varchar("player_name", { length: 100 }).notNull(),
    totalGames: integer("total_games").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    totalProfit: integer("total_profit").notNull().default(0),
    bestHand: varchar("best_hand", { length: 50 }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index("player_stats_player_id_idx").on(table.playerId),
    index("player_stats_total_games_idx").on(table.totalGames),
  ]
)

// 系统健康检查表（保留原有定义）
export const healthCheck = pgTable("health_check", {
	id: serial("id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});
