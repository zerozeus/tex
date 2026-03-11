
/**
 * 扑克牌相关工具函数
 */

export interface Card {
  suit: '♠' | '♥' | '♦' | '♣';
  rank: string;
  value: number;
}

export interface Player {
  id: number;
  name: string;
  chips: number;
  cards: Card[];
  bet: number;
  isFolded: boolean;
  isDealer: boolean;
  isCurrent: boolean;
  isAllIn: boolean;
}

export interface GameState {
  gameId: string;
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  pot: number;
  currentBet: number;
  communityCards: Card[];
  players: Player[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  timeRemaining: number;
  settings: {
    smallBlind: number;
    bigBlind: number;
    timeLimit: number;
  };
}

/**
 * 创建一副新牌
 */
export function createDeck(): Card[] {
  const suits: Card['suit'][] = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck: Card[] = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        suit,
        rank,
        value: ranks.indexOf(rank) + 2,
      });
    }
  }

  return deck;
}

/**
 * 洗牌算法（Fisher-Yates）
 */
export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 发牌给玩家
 */
export function dealCards(deck: Card[], playerCount: number): { cards: Card[][]; remainingDeck: Card[] } {
  const playerCards: Card[][] = Array.from({ length: playerCount }, () => []);
  const remainingDeck = [...deck];

  // 每人发2张牌
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < playerCount; i++) {
      if (remainingDeck.length > 0) {
        playerCards[i].push(remainingDeck.pop()!);
      }
    }
  }

  return {
    cards: playerCards,
    remainingDeck,
  };
}

/**
 * 初始化玩家状态
 */
export function initializePlayers(
  playerConfigs: Array<{ id: number; name: string; chips: number }>,
  dealerIndex: number
): Player[] {
  return playerConfigs.map((config, index) => ({
    ...config,
    cards: [],
    bet: 0,
    isFolded: false,
    isDealer: index === dealerIndex,
    isCurrent: false,
    isAllIn: false,
  }));
}

/**
 * 收取盲注
 */
export function collectBlinds(
  gameState: GameState
): GameState {
  const { players, settings, dealerIndex } = gameState;
  const playerCount = players.length;

  // 计算小盲注和大盲注位置
  const smallBlindIndex = (dealerIndex + 1) % playerCount;
  const bigBlindIndex = (dealerIndex + 2) % playerCount;

  const newPlayers = [...players];

  // 收取小盲注
  if (newPlayers[smallBlindIndex].chips >= settings.smallBlind) {
    newPlayers[smallBlindIndex].chips -= settings.smallBlind;
    newPlayers[smallBlindIndex].bet = settings.smallBlind;
    if (newPlayers[smallBlindIndex].chips === 0) {
      newPlayers[smallBlindIndex].isAllIn = true;
    }
  } else {
    // 筹码不足，全押
    const actualBlind = newPlayers[smallBlindIndex].chips;
    newPlayers[smallBlindIndex].bet = actualBlind;
    newPlayers[smallBlindIndex].chips = 0;
    newPlayers[smallBlindIndex].isAllIn = true;
  }

  // 收取大盲注
  if (newPlayers[bigBlindIndex].chips >= settings.bigBlind) {
    newPlayers[bigBlindIndex].chips -= settings.bigBlind;
    newPlayers[bigBlindIndex].bet = settings.bigBlind;
    if (newPlayers[bigBlindIndex].chips === 0) {
      newPlayers[bigBlindIndex].isAllIn = true;
    }
  } else {
    // 筹码不足，全押
    const actualBlind = newPlayers[bigBlindIndex].chips;
    newPlayers[bigBlindIndex].bet = actualBlind;
    newPlayers[bigBlindIndex].chips = 0;
    newPlayers[bigBlindIndex].isAllIn = true;
  }

  // 计算底池
  const pot = newPlayers.reduce((sum, player) => sum + player.bet, 0);

  return {
    ...gameState,
    players: newPlayers,
    pot,
    smallBlindIndex,
    bigBlindIndex,
    currentBet: settings.bigBlind,
  };
}

/**
 * 创建初始游戏状态
 */
export function createInitialGameState(
  playerConfigs: Array<{ id: number; name: string; chips: number }>,
  settings: { smallBlind: number; bigBlind: number; timeLimit: number }
): GameState {
  const gameId = `game-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const playerCount = playerConfigs.length;

  // 随机选择庄家位置（0 到 playerCount-1）
  const dealerIndex = Math.floor(Math.random() * playerCount);

  // 初始化玩家
  const players = initializePlayers(playerConfigs, dealerIndex);

  // 洗牌
  const deck = shuffleDeck(createDeck());

  // 发牌
  const { cards, remainingDeck } = dealCards(deck, playerCount);

  // 将牌分发给玩家
  const playersWithCards = players.map((player, index) => ({
    ...player,
    cards: cards[index] || [],
  }));

  // 创建初始游戏状态
  const initialGameState: GameState = {
    gameId,
    phase: 'preflop',
    pot: 0,
    currentBet: 0,
    communityCards: [],
    players: playersWithCards,
    currentPlayerIndex: (dealerIndex + 3) % playerCount, // 大盲注下家先行动
    dealerIndex,
    smallBlindIndex: (dealerIndex + 1) % playerCount,
    bigBlindIndex: (dealerIndex + 2) % playerCount,
    timeRemaining: settings.timeLimit,
    settings,
  };

  // 收取盲注
  const gameStateWithBlinds = collectBlinds(initialGameState);

  // 设置当前玩家为行动玩家
  const finalPlayers = gameStateWithBlinds.players.map((player, index) => ({
    ...player,
    isCurrent: index === gameStateWithBlinds.currentPlayerIndex,
  }));

  return {
    ...gameStateWithBlinds,
    players: finalPlayers,
  };
}

// 内存存储游戏状态
const globalForGame = globalThis as unknown as { gameStore: Map<string, GameState> };
const gameStore = globalForGame.gameStore || new Map<string, GameState>();
if (process.env.NODE_ENV !== 'production') globalForGame.gameStore = gameStore;

/**
 * 保存游戏状态
 */
export function saveGameState(gameState: GameState): void {
  gameStore.set(gameState.gameId, gameState);
}

/**
 * 获取游戏状态
 */
export function getGameState(gameId: string): GameState | undefined {
  return gameStore.get(gameId);
}

/**
 * 删除游戏状态
 */
export function deleteGameState(gameId: string): void {
  gameStore.delete(gameId);
}

/**
 * 获取所有游戏ID
 */
export function getAllGameIds(): string[] {
  return Array.from(gameStore.keys());
}
