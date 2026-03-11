import type WebSocket from 'ws';

export interface Card {
  suit: '♠' | '♥' | '♦' | '♣';
  rank: string;
  value: number;
}

export interface Player {
  id: string;
  name: string;
  chips: number;
  cards: Card[];
  bet: number;
  isFolded: boolean;
  isDealer: boolean;
  isCurrent: boolean;
  isAllIn: boolean;
  isBot: boolean; // 是否是机器人
  botToken?: string; // 机器人的API token
  botId?: string; // Coze Bot ID
  botModel?: string; // 机器人使用的模型ID
  sessionId?: string; // Coze 会话ID
  hasActed?: boolean; // 在当前阶段是否已经行动过
  roundBet: number; // 当前轮下注额
  totalHandBet: number; // 本手牌总下注额
}

export interface GameState {
  gameId: string;
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'completed';
  endType?: 'hand' | 'game';
  pot: number;
  pots: { amount: number; eligiblePlayers: string[] }[]; // 奖池列表（主池+边池）
  currentBet: number;
  minRaise: number; // 最小加注额
  communityCards: Card[];
  players: Player[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  timeRemaining: number;
  showdownRevealed?: boolean;
  resultReady?: boolean;
  winners?: Player[]; // 结算阶段的获胜者
  winAmount?: number; // 结算阶段的赢取金额
  settlementReason?: 'fold' | 'showdown';
  handSummary?: Record<string, { description: string; bestCards: Card[] }>;
  settings: {
    smallBlind: number;
    bigBlind: number;
    timeLimit: number;
    autoSettleShowdown?: boolean;
  };
}

export interface GameConfig {
  players: Array<{
    id: string;
    name: string;
    chips: number;
    isBot: boolean;
    botToken?: string;
    botId?: string;
    botModel?: string;
  }>;
  smallBlind: number;
  bigBlind: number;
  timeLimit: number;
  autoSettleShowdown?: boolean;
}

export interface PlayerAction {
  gameId: string;
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  amount?: number;
}

export interface WSMessage {
  type: 'connected' | 'game_update' | 'player_action' | 'error' | 'game_state' | 'join_game' | 'bot_thinking' | 'bot_decision';
  data: unknown;
  timestamp: number;
  chat?: string;
}

export interface WSClient {
  id: string;
  playerId?: string;
  gameId?: string;
  ws: WebSocket;
}
