import { Card, Player, GameState, GameConfig, GameHistoryEvent } from "./types";
import { logger } from "./utils/logger";

// #region debug-point
import http from "http";
import https from "https";

const TRAE_DEBUG_API_URL =
  process.env.TRAE_DEBUG_API_URL ?? "http://127.0.0.1:7778/event";
const TRAE_DEBUG_SESSION_ID =
  process.env.TRAE_DEBUG_SESSION_ID ?? "allin-fold-state";

function traeDebugSnapshotState(gameState: GameState) {
  return {
    gameId: gameState.gameId,
    phase: gameState.phase,
    endType: gameState.endType,
    settlementReason: gameState.settlementReason,
    currentBet: gameState.currentBet,
    minRaise: gameState.minRaise,
    pot: gameState.pot,
    pots: gameState.pots,
    communityCardsCount: gameState.communityCards.length,
    currentPlayerIndex: gameState.currentPlayerIndex,
    players: gameState.players.map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      totalHandBet: p.totalHandBet,
      isFolded: p.isFolded,
      isAllIn: p.isAllIn,
      isCurrent: p.isCurrent,
      hasActed: p.hasActed,
    })),
  };
}

function traeDebugReport(event: Record<string, unknown>) {
  try {
    const url = new URL(TRAE_DEBUG_API_URL);
    const body = JSON.stringify({ sessionId: TRAE_DEBUG_SESSION_ID, ...event });
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.end(body);
  } catch {}
}
// #endregion debug-point

// 牌型枚举
enum HandRank {
  HIGH_CARD = 1, // 高牌
  ONE_PAIR = 2, // 一对
  TWO_PAIR = 3, // 两对
  THREE_OF_A_KIND = 4, // 三条
  STRAIGHT = 5, // 顺子
  FLUSH = 6, // 同花
  FULL_HOUSE = 7, // 葫芦
  FOUR_OF_A_KIND = 8, // 四条
  STRAIGHT_FLUSH = 9, // 同花顺
  ROYAL_FLUSH = 10, // 皇家同花顺
}

interface HandEvaluation {
  rank: HandRank;
  cards: Card[]; // 组成牌型的5张牌
  kickers: number[]; // 用于比较的踢脚牌
  description: string;
}

export class GameEngine {
  private gameState: GameState;
  private remainingDeck: Card[];
  // private timers: Map<string, NodeJS.Timeout> = new Map(); // Removed as unused

  constructor(config: GameConfig) {
    this.gameState = this.initializeGame(config);
    this.remainingDeck = this.createDeck();
    this.shuffleDeck();
    this.dealCards();
    this.collectBlinds();
  }

  private createDeck(): Card[] {
    const suits: Card["suit"][] = ["♠", "♥", "♦", "♣"];
    const ranks = [
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "J",
      "Q",
      "K",
      "A",
    ];
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

  private shuffleDeck(): void {
    for (let i = this.remainingDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.remainingDeck[i], this.remainingDeck[j]] = [
        this.remainingDeck[j],
        this.remainingDeck[i],
      ];
    }
  }

  private initializeGame(config: GameConfig): GameState {
    const gameId = `game-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const playerCount = config.players.length;
    if (playerCount < 2) {
      throw new Error("At least 2 players required");
    }
    const dealerIndex = Math.floor(Math.random() * playerCount);

    const players: Player[] = config.players.map((playerConfig, index) => ({
      id: playerConfig.id,
      name: playerConfig.name,
      chips: playerConfig.chips,
      cards: [],
      bet: 0,
      isFolded: false,
      isDealer: index === dealerIndex,
      isCurrent: false,
      isAllIn: false,
      isBot: playerConfig.isBot || false,
      botToken: playerConfig.botToken,
      botId: playerConfig.botId,
      apiUrl: playerConfig.apiUrl,
      hasActed: false,
      roundBet: 0,
      totalHandBet: 0,
    }));

    let smallBlindIndex: number;
    let bigBlindIndex: number;
    let currentPlayerIndex: number;

    if (playerCount === 2) {
      // Heads-up specific rules:
      // Dealer is Small Blind
      // Other player is Big Blind
      // Preflop: Dealer acts first
      smallBlindIndex = dealerIndex;
      bigBlindIndex = (dealerIndex + 1) % playerCount;
      currentPlayerIndex = dealerIndex;
    } else {
      smallBlindIndex = (dealerIndex + 1) % playerCount;
      bigBlindIndex = (dealerIndex + 2) % playerCount;
      currentPlayerIndex = (dealerIndex + 3) % playerCount;
    }

    const gameState: GameState = {
      gameId,
      handNumber: 1,
      phase: "preflop",
      handStartChips: {},
      pot: 0,
      pots: [], // 初始化奖池列表
      currentBet: 0,
      minRaise: config.bigBlind, // 初始最小加注额为大盲注
      communityCards: [],
      players,
      currentPlayerIndex,
      dealerIndex,
      smallBlindIndex,
      bigBlindIndex,
      showdownRevealed: false,
      resultReady: false,
      actionHistory: [],
      settings: {
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        timeLimit: config.timeLimit,
        autoSettleShowdown: config.autoSettleShowdown ?? false,
      },
    };

    return gameState;
  }

  private dealCards(): void {
    const playerCount = this.gameState.players.length;
    // Start dealing from the player after dealer
    const startIndex = (this.gameState.dealerIndex + 1) % playerCount;

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < playerCount; i++) {
        const playerIndex = (startIndex + i) % playerCount;
        if (this.remainingDeck.length > 0) {
          this.gameState.players[playerIndex].cards.push(
            this.remainingDeck.pop()!
          );
        }
      }
    }
  }

  private collectBlinds(): void {
    const { players, settings, smallBlindIndex, bigBlindIndex } =
      this.gameState;
    let smallBlindAmount = 0;
    let bigBlindAmount = 0;

    // 收取小盲注
    if (players[smallBlindIndex].chips >= settings.smallBlind) {
      players[smallBlindIndex].chips -= settings.smallBlind;
      players[smallBlindIndex].bet = settings.smallBlind;
      players[smallBlindIndex].totalHandBet = settings.smallBlind;
      smallBlindAmount = settings.smallBlind;
      // 盲注不视为已主动行动，除非全押
      players[smallBlindIndex].hasActed = false;
      if (players[smallBlindIndex].chips === 0) {
        players[smallBlindIndex].isAllIn = true;
        players[smallBlindIndex].hasActed = true;
      }
    } else {
      const actualBlind = players[smallBlindIndex].chips;
      players[smallBlindIndex].bet = actualBlind;
      players[smallBlindIndex].totalHandBet = actualBlind;
      players[smallBlindIndex].chips = 0;
      smallBlindAmount = actualBlind;
      players[smallBlindIndex].isAllIn = true;
      players[smallBlindIndex].hasActed = true;
    }

    // 收取大盲注
    if (players[bigBlindIndex].chips >= settings.bigBlind) {
      players[bigBlindIndex].chips -= settings.bigBlind;
      players[bigBlindIndex].bet = settings.bigBlind;
      players[bigBlindIndex].totalHandBet = settings.bigBlind;
      bigBlindAmount = settings.bigBlind;
      // 盲注不视为已主动行动，除非全押
      players[bigBlindIndex].hasActed = false;
      if (players[bigBlindIndex].chips === 0) {
        players[bigBlindIndex].isAllIn = true;
        players[bigBlindIndex].hasActed = true;
      }
    } else {
      const actualBlind = players[bigBlindIndex].chips;
      players[bigBlindIndex].bet = actualBlind;
      players[bigBlindIndex].totalHandBet = actualBlind;
      players[bigBlindIndex].chips = 0;
      bigBlindAmount = actualBlind;
      players[bigBlindIndex].isAllIn = true;
      players[bigBlindIndex].hasActed = true;
    }

    // 计算底池
    this.gameState.pot = players.reduce((sum, player) => sum + player.bet, 0);
    this.gameState.currentBet = settings.bigBlind;
    // 记录本手开局筹码（盲注后筹码 + 已投盲注），用于结算阶段恢复净输赢
    this.gameState.handStartChips = Object.fromEntries(
      players.map((player) => [player.id, player.chips + player.totalHandBet])
    );

    // 设置当前玩家
    this.gameState.players.forEach((player, index) => {
      player.isCurrent = index === this.gameState.currentPlayerIndex;
    });

    this.appendHistoryEvent({
      kind: "hand_start",
      phase: "system",
      note: `第 ${this.gameState.handNumber} 手开始，庄家 ${players[this.gameState.dealerIndex].name}`,
    });
    this.recordBlindEvent(players[smallBlindIndex], "small", smallBlindAmount);
    this.recordBlindEvent(players[bigBlindIndex], "big", bigBlindAmount);
  }

  public getGameState(): GameState {
    return JSON.parse(JSON.stringify(this.gameState));
  }

  public settleShowdown(): { success: boolean; error?: string } {
    if (this.gameState.phase !== "showdown") {
      return { success: false, error: "当前不在摊牌阶段" };
    }

    if (this.gameState.resultReady) {
      return { success: false, error: "结果已结算" };
    }

    this.gameState.resultReady = true;
    this.determineWinner();
    return { success: true };
  }

  public progressToTerminalIfNeeded(): { success: boolean; error?: string } {
    if (
      this.gameState.phase === "showdown" &&
      !this.gameState.resultReady &&
      this.gameState.settings.autoSettleShowdown
    ) {
      return this.settleShowdown();
    }
    return { success: true };
  }

  public nextRound(): void {
    if (this.gameState.phase === "completed") {
      this.startNewRound();
    }
  }

  /**
   * 检查当前玩家是否是机器人
   */
  public isCurrentPlayerBot(): boolean {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    return currentPlayer ? currentPlayer.isBot : false;
  }

  /**
   * 获取当前机器人玩家
   */
  public getCurrentBotPlayer(): Player | null {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (currentPlayer && currentPlayer.isBot) {
      return currentPlayer;
    }
    return null;
  }

  public handleAction(
    playerId: string,
    action: string,
    amount?: number
  ): { success: boolean; error?: string } {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    let committedAmount = 0;

    if (currentPlayer.id !== playerId) {
      // #region debug-point
      traeDebugReport({
        event: "action_rejected",
        reason: "not_current_turn",
        action,
        amount,
        requestPlayerId: playerId,
        currentPlayerId: currentPlayer.id,
        snapshot: traeDebugSnapshotState(this.gameState),
      });
      // #endregion debug-point
      console.warn(`[Action Failed] Not current player's turn. Current: ${currentPlayer.id}, Request: ${playerId}`);
      return { success: false, error: "不是当前玩家的回合" };
    }

    if (currentPlayer.isFolded) {
      // #region debug-point
      traeDebugReport({
        event: "action_rejected",
        reason: "player_already_folded",
        action,
        amount,
        playerId,
        snapshot: traeDebugSnapshotState(this.gameState),
      });
      // #endregion debug-point
      console.warn(`[Action Failed] Player ${currentPlayer.name} is folded.`);
      return { success: false, error: "玩家已弃牌" };
    }

    if (currentPlayer.isAllIn) {
      // #region debug-point
      traeDebugReport({
        event: "action_rejected",
        reason: "player_already_allin",
        action,
        amount,
        playerId,
        snapshot: traeDebugSnapshotState(this.gameState),
      });
      // #endregion debug-point
      console.warn(`[Action Failed] Player ${currentPlayer.name} is All-In.`);
      return { success: false, error: "玩家已全押，不能继续行动" };
    }

    // #region debug-point
    traeDebugReport({
      event: "action_start",
      playerId,
      action,
      amount,
      snapshot: traeDebugSnapshotState(this.gameState),
    });
    // #endregion debug-point
    console.log(`[Action Start] Player: ${currentPlayer.name}, Action: ${action}, Amount: ${amount}, CurrentBet: ${this.gameState.currentBet}, PlayerBet: ${currentPlayer.bet}, Chips: ${currentPlayer.chips}`);

    switch (action) {
      case "fold":
        currentPlayer.isFolded = true;
        currentPlayer.hasActed = true;

        // 检查是否只剩一个活跃玩家
        const activePlayers = this.gameState.players.filter((p) => !p.isFolded);
        if (activePlayers.length === 1) {
          // 只剩一个玩家，该玩家直接获胜 (不经过 Showdown)
          this.determineWinner();
          // #region debug-point
          traeDebugReport({
            event: "action_end_hand_completed",
            action: "fold",
            foldedPlayerId: playerId,
            snapshot: traeDebugSnapshotState(this.gameState),
          });
          // #endregion debug-point
          return { success: true };
        }
        break;

      case "check":
        if (this.gameState.currentBet > currentPlayer.bet) {
          return {
            success: false,
            error: "当前下注额与玩家已下注额不同，不能过牌",
          };
        }
        currentPlayer.hasActed = true;
        break;

      case "bet":
        if (this.gameState.currentBet > 0) {
          return {
            success: false,
            error: "当前已有下注，请使用 raise 或 call",
          };
        }
        if (!amount || amount <= 0) {
          return { success: false, error: "下注金额无效" };
        }
        if (amount < this.gameState.settings.bigBlind) {
          return {
            success: false,
            error: `下注金额必须至少为 ${this.gameState.settings.bigBlind}`,
          };
        }
        if (amount > currentPlayer.chips) {
          return { success: false, error: "筹码不足" };
        }

        currentPlayer.chips -= amount;
        currentPlayer.bet += amount;
        currentPlayer.totalHandBet += amount;
        committedAmount = amount;
        this.gameState.pot += amount;
        this.gameState.currentBet = amount;
        this.gameState.minRaise = amount;

        currentPlayer.hasActed = true;

        // Reset others acted
        this.gameState.players.forEach((player) => {
          if (player.id !== currentPlayer.id && this.canPlayerAct(player)) {
            player.hasActed = false;
          }
        });

        if (currentPlayer.chips === 0) {
          currentPlayer.isAllIn = true;
        }
        break;

      case "call":
        const callAmount = this.gameState.currentBet - currentPlayer.bet;

        if (callAmount <= 0) {
          return { success: false, error: "当前无需跟注，请使用 check" };
        }

        // 支持短码全押跟注
        const actualCallAmount = Math.min(callAmount, currentPlayer.chips);

        currentPlayer.chips -= actualCallAmount;
        currentPlayer.bet += actualCallAmount;
        currentPlayer.totalHandBet += actualCallAmount;
        committedAmount = actualCallAmount;
        this.gameState.pot += actualCallAmount;
        currentPlayer.hasActed = true;

        if (currentPlayer.chips === 0) {
          currentPlayer.isAllIn = true;
        }
        break;

      case "raise":
        if (!amount || amount <= 0) {
          return { success: false, error: "加注金额无效" };
        }

        if (this.gameState.currentBet === 0) {
          return { success: false, error: "当前无人下注，请使用 bet" };
        }

        // 检查最小加注额 (除非全押)
        const isFullRaise = amount >= this.gameState.minRaise;
        const totalReq = this.gameState.currentBet - currentPlayer.bet + amount;

        if (!isFullRaise && totalReq < currentPlayer.chips) {
          return {
            success: false,
            error: `加注金额必须至少为 ${this.gameState.minRaise}`,
          };
        }

        const raiseAmount =
          this.gameState.currentBet - currentPlayer.bet + amount;
        if (raiseAmount > currentPlayer.chips) {
          return { success: false, error: "筹码不足以加注" };
        }

        currentPlayer.chips -= raiseAmount;
        currentPlayer.bet += raiseAmount;
        currentPlayer.totalHandBet += raiseAmount;
        committedAmount = raiseAmount;
        this.gameState.pot += raiseAmount;
        this.gameState.currentBet = currentPlayer.bet;

        // 更新最小加注额
        // 只有构成有效加注才更新 minRaise 并重置其他玩家状态
        if (isFullRaise) {
          this.gameState.minRaise = amount;

          this.gameState.players.forEach((player) => {
            if (player.id !== currentPlayer.id && this.canPlayerAct(player)) {
              player.hasActed = false;
            }
          });
        }

        currentPlayer.hasActed = true;

        if (currentPlayer.chips === 0) {
          currentPlayer.isAllIn = true;
        }
        break;

      case "allin":
        const allInAmount = currentPlayer.chips;
        const totalBetAfterAllIn = currentPlayer.bet + allInAmount;

        // 检查是否构成加注
        const actualRaiseAmount =
          totalBetAfterAllIn - this.gameState.currentBet;

        currentPlayer.chips = 0;
        currentPlayer.bet = totalBetAfterAllIn;
        currentPlayer.totalHandBet += allInAmount;
        committedAmount = allInAmount;
        this.gameState.pot += allInAmount;

        if (totalBetAfterAllIn > this.gameState.currentBet) {
          this.gameState.currentBet = totalBetAfterAllIn;
          // 如果全押金额作为加注金额 >= 最小加注额，则更新最小加注额
          // 这里的逻辑比较复杂，简单处理：如果实际加注额 >= minRaise，则更新
          // 注意：all-in 即使不够 minRaise 也是合法的，但可能不触发再次加注权（这里简化处理）
          if (actualRaiseAmount >= this.gameState.minRaise) {
            this.gameState.minRaise = actualRaiseAmount;

            // 只有构成有效加注才重置其他玩家状态
            this.gameState.players.forEach((player) => {
              if (player.id !== currentPlayer.id && this.canPlayerAct(player)) {
                player.hasActed = false;
              }
            });
          }
        }

        currentPlayer.isAllIn = true;
        currentPlayer.hasActed = true;
        break;

      default:
        // #region debug-point
        traeDebugReport({
          event: "action_rejected",
          reason: "invalid_action",
          action,
          amount,
          playerId,
          snapshot: traeDebugSnapshotState(this.gameState),
        });
        // #endregion debug-point
        console.warn(`[Action Failed] Invalid action: ${action}`);
        return { success: false, error: "无效的操作" };
    }

    console.log(`[Action Success] Player: ${currentPlayer.name}, Action: ${action}, NewChips: ${currentPlayer.chips}, NewBet: ${currentPlayer.bet}, Pot: ${this.gameState.pot}`);
    this.recordActionEvent(
      currentPlayer,
      action as GameHistoryEvent["action"],
      committedAmount
    );

    // 移动到下一个玩家
    this.moveToNextPlayer();
    // #region debug-point
    traeDebugReport({
      event: "action_end",
      playerId,
      action,
      amount,
      snapshot: traeDebugSnapshotState(this.gameState),
    });
    // #endregion debug-point
    return { success: true };
  }

  private isPlayerActive(player: Player): boolean {
    return !player.isFolded;
  }

  private canPlayerAct(player: Player): boolean {
    return this.isPlayerActive(player) && !player.isAllIn && player.chips > 0;
  }

  private needsPlayerAction(player: Player): boolean {
    if (!this.canPlayerAct(player)) return false;
    if (!player.hasActed) return true;
    return player.bet !== this.gameState.currentBet;
  }

  private moveToNextPlayer(): void {
    // 检查活跃玩家数量
    const activePlayers = this.gameState.players.filter((p) =>
      this.isPlayerActive(p)
    );

    console.log(`\n>>> moveToNextPlayer 开始`);
    console.log(`当前阶段: ${this.gameState.phase}`);
    console.log(`活跃玩家数量: ${activePlayers.length}`);

    // 如果只剩一个活跃玩家，该玩家直接获胜
    if (activePlayers.length === 1) {
      this.determineWinner(); // 直接进入结算
      return;
    }

    // 检查是否所有活跃玩家都已行动且下注相等
    const shouldMoveToNextPhase = this.shouldMoveToNextPhase(activePlayers);

    console.log(`[moveToNextPlayer] shouldMoveToNextPhase: ${shouldMoveToNextPhase}`);

    if (shouldMoveToNextPhase) {
      // 所有玩家都行动完成且下注相等，进入下一阶段
      console.log(`>>> 准备进入下一阶段: ${this.gameState.phase} -> next`);

      // 检查是否所有活跃玩家都已All-In
      // 只有当没有任何 actionablePlayers (即 !isAllIn) 时，才自动 runOutBoard
      const actionablePlayers = activePlayers.filter((p) => this.canPlayerAct(p));
      if (actionablePlayers.length === 0) {
        console.log("No actionable players left. Running out board.");
        this.runOutBoard();
      } else {
        this.moveToNextPhase();
      }
      return;
    }

    console.log(`>>> 不满足进入下一阶段的条件，继续下一位玩家`);

    // 找下一个需要行动的玩家
    const playerCount = this.gameState.players.length;
    let nextIndex = (this.gameState.currentPlayerIndex + 1) % playerCount;
    let rounds = 0;
    const maxRounds = playerCount;

    while (rounds < maxRounds && !this.needsPlayerAction(this.gameState.players[nextIndex])) {
      nextIndex = (nextIndex + 1) % playerCount;
      rounds++;
    }

    if (rounds >= maxRounds) {
      console.log(`[moveToNextPlayer] No active non-all-in players found after loop.`);
      // 所有活跃玩家都已allin，进入下一阶段
      // 实际上这种情况应该被 shouldMoveToNextPhase 捕获，但作为保险
      const activePlayers = this.gameState.players.filter((p) =>
        this.isPlayerActive(p)
      );
      const actionablePlayers = activePlayers.filter((p) => this.canPlayerAct(p));
      console.log(`[moveToNextPlayer] Actionable players: ${actionablePlayers.length}`);

      if (actionablePlayers.length === 0) {
        console.log(`[moveToNextPlayer] Triggering runOutBoard`);
        this.runOutBoard();
      } else {
        console.log(`[moveToNextPlayer] Triggering moveToNextPhase`);
        this.moveToNextPhase();
      }
    } else {
      console.log(`[moveToNextPlayer] Next player found: Index ${nextIndex}`);
      this.gameState.currentPlayerIndex = nextIndex;
      this.gameState.players.forEach((player, index) => {
        player.isCurrent = index === nextIndex;
      });
    }
    console.log("[next player]", {
      phase: this.gameState.phase,
      currentPlayerIndex: this.gameState.currentPlayerIndex,
      currentPlayerName:
        this.gameState.players[this.gameState.currentPlayerIndex]?.name,
      currentPlayerIsBot:
        this.gameState.players[this.gameState.currentPlayerIndex]?.isBot,
    });
  }

  private runOutBoard(): void {
    // 避免重复调用或重入
    if (
      (this.gameState.phase as string) === "showdown" ||
      (this.gameState.phase as string) === "completed"
    ) {
      console.log(`[runOutBoard] Skipped because phase is ${this.gameState.phase}`);
      return;
    }

    console.log(`[runOutBoard] Running out board from ${this.gameState.phase}`);
    while (
      (this.gameState.phase as string) !== "showdown" &&
      (this.gameState.phase as string) !== "completed"
    ) {
      console.log(`[runOutBoard] Advancing phase: ${this.gameState.phase} -> next (auto)`);
      this.moveToNextPhase(true); // true = auto runout mode
    }

    this.progressToTerminalIfNeeded();
  }

  /**
   * 检查是否应该进入下一阶段
   * 条件：所有活跃玩家的下注相等，且都已行动过
   */
  private shouldMoveToNextPhase(activePlayers: Player[]): boolean {
    const currentBet = this.gameState.currentBet;

    // 调试日志
    console.log(`\n=== shouldMoveToNextPhase ===`);
    console.log(`阶段: ${this.gameState.phase}`);
    console.log(`当前最高下注: ${currentBet}`);
    activePlayers.forEach((player) => {
      console.log(
        `  ${player.name}: bet=${player.bet}, hasActed=${player.hasActed}, isAllIn=${player.isAllIn}`
      );
    });

    // 检查所有活跃玩家的下注是否相等
    // 特殊情况：如果所有未盖牌玩家都已全押，则视为下注“相等”（即使金额不同），可以进入下一阶段
    // 或者，如果只剩一个未全押的玩家，其他都全押了，且该玩家下注额 >= 其他全押玩家的最大有效下注（这里简化逻辑：只要该玩家已行动且跟注了当前最大注）

    // 检查是否所有活跃玩家都已全押
    const allAllIn = activePlayers.every((p) => p.isAllIn);
    if (allAllIn) {
      console.log(`All players are All-In, moving to next phase.`);
      return true;
    }

    // 检查是否除一人外都已全押
    const nonAllInPlayers = activePlayers.filter((p) => !p.isAllIn);
    if (nonAllInPlayers.length === 0) {
      // 应该被上面的 allAllIn 捕获，但作为保险
      return true;
    }

    const allBetsEqual = activePlayers.every((player) => {
      // 如果玩家已全押，则不需要下注等于当前最高注（因为他没筹码了）
      // 但如果他全押的金额小于当前注，这通常是允许的（边池逻辑处理）
      if (player.isAllIn) return true;

      // 未全押玩家，必须跟注到当前最高注
      return player.bet === currentBet;
    });
    console.log(`allBetsEqual: ${allBetsEqual}`);

    if (!allBetsEqual) {
      console.log(`[shouldMoveToNextPhase] Bets are NOT equal. CurrentBet: ${currentBet}`);
      activePlayers.forEach(p => {
          if (!p.isAllIn && p.bet !== currentBet) {
              console.log(`  - Player ${p.name} needs to call. Bet: ${p.bet}, Target: ${currentBet}`);
          }
      });
      return false;
    }

    // 检查所有活跃玩家是否都已行动
    const allHaveActed = activePlayers.every(
      (player) => player.hasActed || player.isAllIn
    );
    console.log(`allHaveActed: ${allHaveActed}`);

    if (!allHaveActed) {
      console.log(`[shouldMoveToNextPhase] Not all players have acted.`);
      activePlayers.forEach(p => {
          if (!p.isAllIn && !p.hasActed) {
              console.log(`  - Player ${p.name} has NOT acted.`);
          }
      });
      return false;
    }

    if (!allBetsEqual) {
      return false;
    }

    // 检查是否是preflop阶段
    // 用户指正：Preflop 并不是“只要所有人下注达到大盲就结束”，而是看是否等于 currentBet
    // 前面的 allBetsEqual 已经在做这个了，这里直接返回 true
    console.log(`=== 进入下一阶段: true ===\n`);
    return true;
  }

  private moveToNextPhase(isAutoRunout: boolean = false): void {
    const currentPhase = this.gameState.phase;
    console.log(`moveToNextPhase: ${currentPhase} (auto=${isAutoRunout})`);

    // 重置玩家下注和行动状态
    this.gameState.players.forEach((player) => {
      player.bet = 0;
      player.isCurrent = false;
      player.hasActed = false;
    });

    switch (currentPhase) {
      case "preflop":
        this.gameState.phase = "flop";
        this.dealCommunityCards(3);
        break;
      case "flop":
        this.gameState.phase = "turn";
        this.dealCommunityCards(1);
        break;
      case "turn":
        this.gameState.phase = "river";
        this.dealCommunityCards(1);
        break;
      case "river":
        this.gameState.phase = "showdown";
        this.gameState.showdownRevealed = true;
        this.gameState.resultReady = false;
        this.appendHistoryEvent({
          kind: "phase_change",
          phase: "showdown",
          pot: this.gameState.pot,
          currentBet: this.gameState.currentBet,
          communityCards: this.gameState.communityCards.map((card) => this.formatCard(card)),
          note: "进入摊牌阶段",
        });
        return;
      case "showdown": // Should not happen but safety check
      case "completed":
        return;
    }

    this.gameState.currentBet = 0;
    this.gameState.minRaise = this.gameState.settings.bigBlind; // 重置最小加注额
    this.appendHistoryEvent({
      kind: "phase_change",
      phase: this.gameState.phase,
      pot: this.gameState.pot,
      currentBet: this.gameState.currentBet,
      communityCards: this.gameState.communityCards.map((card) => this.formatCard(card)),
      note: `进入 ${this.gameState.phase} 阶段`,
    });

    // 如果是自动跑牌模式，直接返回，不设置当前玩家，由 runOutBoard 循环继续
    if (isAutoRunout) {
      console.log(`[moveToNextPhase] Auto-runout mode: skipping player selection.`);
      return;
    }

    // 设置第一个未弃牌的玩家为当前玩家
    // 正确规则：庄家左手第一位仍在局玩家先行动
    const playerCount = this.gameState.players.length;
    let nextIndex = (this.gameState.dealerIndex + 1) % playerCount;
    let nextRounds = 0;

    // 找下一个未弃牌且未全押的玩家
    while (
      nextRounds < playerCount &&
      !this.canPlayerAct(this.gameState.players[nextIndex])
    ) {
      nextIndex = (nextIndex + 1) % playerCount;
      nextRounds++;
    }

    if (nextRounds < playerCount) {
      this.gameState.currentPlayerIndex = nextIndex;
      this.gameState.players[nextIndex].isCurrent = true;
      console.log(`[moveToNextPhase] First player for ${this.gameState.phase}: ${this.gameState.players[nextIndex].name} (Index ${nextIndex})`);
    } else {
      // 没有任何玩家可以行动（所有人要么弃牌，要么全押）
      // 此时应该调用 runOutBoard，但为了避免递归死循环/重入
      // 我们在这里不直接调 runOutBoard，而是检查是否需要自动推进

      // 这里的逻辑稍微复杂：如果正常切阶段发现没人能动了，
      // 说明应该进入自动跑牌。但如果直接调 runOutBoard 会导致递归。
      // 所以我们在这里只做标记或一次性推进？

      // 更安全的做法：既然发现没人能动，直接把剩余阶段跑完
      // 但要小心不要无限递归。
      // 由于我们已经在 runOutBoard 里有 while 循环
      // 如果是由 runOutBoard 调用的 (isAutoRunout=true)，这里根本不会执行到 setting current player

      // 所以只有 isAutoRunout=false (正常流程) 才会进这里。
      // 既然是正常流程发现没人能动，那就可以安全启动 runOutBoard
      console.log(
        "No actionable players found after phase change. Starting auto runout."
      );
      this.runOutBoard();
    }
    console.log("[phase advanced]", {
      phase: this.gameState.phase,
      dealerIndex: this.gameState.dealerIndex,
      sbIndex: this.gameState.smallBlindIndex,
      bbIndex: this.gameState.bigBlindIndex,
      currentPlayerIndex: this.gameState.currentPlayerIndex,
      currentPlayerName:
        this.gameState.players[this.gameState.currentPlayerIndex]?.name,
      currentPlayerIsBot:
        this.gameState.players[this.gameState.currentPlayerIndex]?.isBot,
    });
  }

  private dealCommunityCards(count: number): void {
    console.log(`[dealCommunityCards] Dealing ${count} cards. Remaining deck: ${this.remainingDeck.length}`);
    for (let i = 0; i < count && this.remainingDeck.length > 0; i++) {
      const card = this.remainingDeck.pop()!;
      this.gameState.communityCards.push(card);
      console.log(`  - Dealt: ${card.suit}${card.rank}`);
    }
  }

  private determineWinner(): void {
    // #region debug-point
    traeDebugReport({
      event: "determine_winner_enter",
      snapshot: traeDebugSnapshotState(this.gameState),
    });
    // #endregion debug-point
    // 检查活跃玩家
    const activePlayers = this.gameState.players.filter((p) => !p.isFolded);

    if (activePlayers.length === 0) {
      return;
    }

    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      // #region debug-point
      const potBeforeAward = this.gameState.pot;
      // #endregion debug-point
      // 只剩一个玩家，该玩家赢得底池
      winner.chips += this.gameState.pot;

      // 记录获胜信息
      this.gameState.winners = [winner];
      this.gameState.winAmount = this.gameState.pot;
      this.gameState.settlementReason = "fold";
      this.gameState.handSummary = undefined;

      console.log(
        `>>> 游戏结算(弃牌获胜): ${winner.name} 获胜，赢得 ${this.gameState.pot} 筹码`
      );

      const survivors = this.gameState.players.filter((p) => p.chips > 0);
      this.gameState.endType = survivors.length < 2 ? "game" : "hand";

      const winnerIndex = this.gameState.players.findIndex(
        (player) => player.id === winner.id
      );
      if (winnerIndex >= 0) {
        this.gameState.currentPlayerIndex = winnerIndex;
      }
      this.gameState.players.forEach((player, index) => {
        player.isCurrent = index === this.gameState.currentPlayerIndex;
      });

      this.gameState.currentBet = 0;
      this.gameState.minRaise = this.gameState.settings.bigBlind;
      this.gameState.pots = [];
      this.gameState.pot = 0;
      this.gameState.phase = "completed";
      this.appendHistoryEvent({
        kind: "hand_end",
        phase: "completed",
        playerId: winner.id,
        playerName: winner.name,
        amount: this.gameState.winAmount,
        note: `${winner.name} 因其他玩家弃牌获胜`,
      });
      // #region debug-point
      traeDebugReport({
        event: "determine_winner_fold_completed",
        winnerPlayerId: winner.id,
        potBeforeAward,
        snapshot: traeDebugSnapshotState(this.gameState),
      });
      // #endregion debug-point
      return;
    }

    const handSummary: Record<string, { description: string; bestCards: Card[] }> =
      {};
    const evalByPlayerId: Record<string, HandEvaluation> = {};
    activePlayers.forEach((player) => {
      const evalResult = this.evaluateHand(
        player.cards,
        this.gameState.communityCards
      );
      evalByPlayerId[player.id] = evalResult;
      handSummary[player.id] = {
        description: evalResult.description,
        bestCards: evalResult.cards,
      };
    });
    this.gameState.settlementReason = "showdown";
    this.gameState.handSummary = handSummary;

    // Side Pot Logic

    // 1. Identify all contributors (including folded players)
    const contributors = this.gameState.players.filter(
      (p) => p.totalHandBet > 0
    );

    // 2. Create levels
    const betLevels = [
      ...new Set(contributors.map((p) => p.totalHandBet)),
    ].sort((a, b) => a - b);

    const pots: { amount: number; eligiblePlayers: Player[] }[] = [];
    let lastLevel = 0;

    for (const level of betLevels) {
      let potAmount = 0;

      // Calculate pot amount for this level (Standard Slice Method)
      // Contributors: Players who bet at least 'level'
      const contributorsAtLevel = this.gameState.players.filter(
        (p) => p.totalHandBet >= level
      );
      const slice = level - lastLevel;
      potAmount = contributorsAtLevel.length * slice;

      // Identify eligible players (Active players who bet at least this level)
      const eligiblePlayers: Player[] = [];
      activePlayers.forEach((p) => {
        if (p.totalHandBet >= level) {
          eligiblePlayers.push(p);
        }
      });

      if (potAmount > 0) {
        pots.push({ amount: potAmount, eligiblePlayers });
      }

      lastLevel = level;
    }

    // Update GameState pots
    this.gameState.pots = pots.map((p) => ({
      amount: p.amount,
      eligiblePlayers: p.eligiblePlayers.map((pl) => pl.id),
    }));

    const allWinners = new Set<Player>();

    // 3. Settle each pot
    pots.forEach((pot, index) => {
      console.log(
        `>>> 结算奖池 ${index + 1}: 金额 ${pot.amount}, 参与人数 ${
          pot.eligiblePlayers.length
        }`
      );

      if (pot.eligiblePlayers.length === 0) {
        console.error("Pot has no eligible players!");
        return;
      }

      if (pot.eligiblePlayers.length === 1) {
        // Only one player eligible
        const winner = pot.eligiblePlayers[0];
        winner.chips += pot.amount;
        allWinners.add(winner);
        console.log(`    ${winner.name} 自动赢得 ${pot.amount} (无竞争对手)`);
        return;
      }

      // Evaluate hands
      const evaluations = pot.eligiblePlayers.map((player) => ({
        player,
        hand: evalByPlayerId[player.id],
      }));

      // Sort
      evaluations.sort((a, b) => this.compareHands(b.hand, a.hand));

      // Find winners
      const bestHand = evaluations[0].hand;
      const winners = evaluations.filter(
        (e) => this.compareHands(e.hand, bestHand) === 0
      );

      const winAmountPerPlayer = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount % winners.length;

      // Distribute chips - Sort winners by position relative to dealer (left of dealer first)
      const sortedWinners = [...winners].sort((a, b) => {
        const idxA = this.gameState.players.indexOf(a.player);
        const idxB = this.gameState.players.indexOf(b.player);
        const leftOfDealer =
          (this.gameState.dealerIndex + 1) % this.gameState.players.length;
        // Relative position from left of dealer
        const posA =
          (idxA - leftOfDealer + this.gameState.players.length) %
          this.gameState.players.length;
        const posB =
          (idxB - leftOfDealer + this.gameState.players.length) %
          this.gameState.players.length;
        return posA - posB;
      });

      sortedWinners.forEach((w, idx) => {
        let amount = winAmountPerPlayer;
        if (idx < remainder) {
          amount += 1;
        }
        w.player.chips += amount;
        allWinners.add(w.player);
        console.log(
          `    ${w.player.name} 赢得 ${amount} (牌型: ${w.hand.description})`
        );
      });
    });

    // 记录获胜信息
    this.gameState.winners = Array.from(allWinners);
    this.gameState.winAmount = this.gameState.pot; // 显示总底池
    this.gameState.pot = 0;

    // 设置为 completed 阶段
    console.log(`>>> 阶段变更: ${this.gameState.phase} -> completed`);
    {
      const survivors = this.gameState.players.filter((p) => p.chips > 0);
      this.gameState.endType = survivors.length < 2 ? "game" : "hand";
    }
    this.gameState.phase = "completed";
    this.appendHistoryEvent({
      kind: "hand_end",
      phase: "completed",
      amount: this.gameState.winAmount,
      note: `摊牌结算完成，获胜者: ${this.gameState.winners.map((winner) => winner.name).join(", ")}`,
    });
    // #region debug-point
    traeDebugReport({
      event: "determine_winner_showdown_completed",
      snapshot: traeDebugSnapshotState(this.gameState),
    });
    // #endregion debug-point
  }

  /**
   * 开始新一局
   */
  private startNewRound(): void {
    logger.info(">>> startNewRound called");

    // 1. 检查是否有玩家破产 (chips <= 0)
    const survivors = this.gameState.players.filter((p) => p.chips > 0);
    logger.info(`Active players with chips > 0: ${survivors.length}`);

    if (survivors.length < 2) {
      // 游戏结束：只剩1人（或0人）有筹码
      logger.info(">>> Game Over! Resetting game for everyone.");

      // 重置所有玩家的筹码为 1000
      this.gameState.players.forEach((p) => {
        p.chips = 1000;
        p.isAllIn = false;
        p.isFolded = false;
        p.bet = 0;
        p.cards = [];
      });

      // 随机重置庄家位置
      this.gameState.dealerIndex = Math.floor(
        Math.random() * this.gameState.players.length
      );
    } else {
      // 游戏继续：移除破产玩家
      if (survivors.length < this.gameState.players.length) {
        logger.info(
          `Removing ${
            this.gameState.players.length - survivors.length
          } busted players.`
        );
        this.gameState.players = survivors;

        // 修正庄家位置（防止越界）
        if (this.gameState.dealerIndex >= this.gameState.players.length) {
          this.gameState.dealerIndex = 0;
        }
      }
    }

    console.log(">>> 开始新一局");
    // 移动庄家位置
    const dealerIndex = this.gameState.dealerIndex;
    const playerCount = this.gameState.players.length;
    const newDealerIndex = (dealerIndex + 1) % playerCount;

    // 重新洗牌
    this.remainingDeck = this.createDeck();
    this.shuffleDeck();

    // 重置玩家状态
    this.gameState.players.forEach((player, index) => {
      player.cards = [];
      player.bet = 0;
      player.isFolded = false;
      player.isAllIn = false;
      player.hasActed = false;
      player.isDealer = index === newDealerIndex;
      player.isCurrent = false;
      player.roundBet = 0;
      player.totalHandBet = 0;
    });

    // 设置新的位置
    let newSmallBlindIndex: number;
    let newBigBlindIndex: number;
    let newCurrentPlayerIndex: number;

    if (playerCount === 2) {
      // Heads-up specific rules:
      // Dealer is Small Blind
      // Other player is Big Blind
      // Preflop: Dealer acts first
      newSmallBlindIndex = newDealerIndex;
      newBigBlindIndex = (newDealerIndex + 1) % playerCount;
      newCurrentPlayerIndex = newDealerIndex;
    } else {
      newSmallBlindIndex = (newDealerIndex + 1) % playerCount;
      newBigBlindIndex = (newDealerIndex + 2) % playerCount;
      newCurrentPlayerIndex = (newDealerIndex + 3) % playerCount;
    }

    this.gameState.dealerIndex = newDealerIndex;
    this.gameState.smallBlindIndex = newSmallBlindIndex;
    this.gameState.bigBlindIndex = newBigBlindIndex;
    this.gameState.currentPlayerIndex = newCurrentPlayerIndex;

    // 重置游戏状态
    this.gameState.handNumber += 1;
    this.gameState.phase = "preflop";
    this.gameState.pot = 0;
    this.gameState.pots = [];
    this.gameState.currentBet = 0;
    this.gameState.minRaise = this.gameState.settings.bigBlind;
    this.gameState.communityCards = [];
    this.gameState.showdownRevealed = false;
    this.gameState.resultReady = false;
    this.gameState.endType = undefined;
    this.gameState.winners = [];
    this.gameState.winAmount = 0;
    this.gameState.settlementReason = undefined;
    this.gameState.handSummary = undefined;
    this.gameState.actionHistory = [];

    // 发牌
    this.dealCards();

    // 收取盲注
    this.collectBlinds();
  }

  private appendHistoryEvent(
    event: Omit<GameHistoryEvent, "sequence" | "handNumber" | "createdAt">
  ): void {
    this.gameState.actionHistory.push({
      sequence: this.gameState.actionHistory.length + 1,
      handNumber: this.gameState.handNumber,
      createdAt: new Date().toISOString(),
      ...event,
    });
  }

  private recordBlindEvent(
    player: Player,
    blindType: "small" | "big",
    amount: number
  ): void {
    this.appendHistoryEvent({
      kind: "blind",
      phase: "preflop",
      playerId: player.id,
      playerName: player.name,
      blindType,
      amount,
      pot: this.gameState.pot,
      currentBet: this.gameState.currentBet,
      playerBet: player.bet,
      chipsAfter: player.chips,
      note: blindType === "small" ? "支付小盲" : "支付大盲",
    });
  }

  private recordActionEvent(
    player: Player,
    action: GameHistoryEvent["action"],
    committedAmount: number
  ): void {
    this.appendHistoryEvent({
      kind: "action",
      phase: this.gameState.phase,
      playerId: player.id,
      playerName: player.name,
      action,
      amount: committedAmount > 0 ? committedAmount : undefined,
      pot: this.gameState.pot,
      currentBet: this.gameState.currentBet,
      playerBet: player.bet,
      chipsAfter: player.chips,
    });
  }

  private formatCard(card: Card): string {
    return `${card.rank}${card.suit}`;
  }

  /**
   * 评估玩家的最佳牌型
   */
  private evaluateHand(
    holeCards: Card[],
    communityCards: Card[]
  ): HandEvaluation {
    const allCards = [...holeCards, ...communityCards];

    if (allCards.length < 5) {
      return {
        rank: HandRank.HIGH_CARD,
        cards: [],
        kickers: [],
        description: "高牌",
      };
    }

    // 获取所有可能的5张牌组合
    const combinations = this.getCombinations(allCards, 5);

    // 找出最大的牌型
    let bestHand: HandEvaluation | null = null;
    for (const combo of combinations) {
      const hand = this.evaluateFiveCards(combo);
      if (!bestHand || this.compareHands(hand, bestHand) > 0) {
        bestHand = hand;
      }
    }

    return (
      bestHand || {
        rank: HandRank.HIGH_CARD,
        cards: [],
        kickers: [],
        description: "高牌",
      }
    );
  }

  /**
   * 评估5张牌的牌型
   */
  private evaluateFiveCards(cards: Card[]): HandEvaluation {
    // 按点数从大到小排序
    const sorted = [...cards].sort((a, b) => b.value - a.value);

    // 检查是否是同花
    const isFlush = cards.every((card) => card.suit === cards[0].suit);

    // 检查是否是顺子
    const isStraight = this.isStraight(sorted);

    // 检查是否是同花顺
    if (isFlush && isStraight) {
      const values = sorted.map((c) => c.value);
      // 检查是否是皇家同花顺 (A K Q J 10 同花)
      if (
        values[0] === 14 &&
        values[1] === 13 &&
        values[2] === 12 &&
        values[3] === 11 &&
        values[4] === 10
      ) {
        return {
          rank: HandRank.ROYAL_FLUSH,
          cards: sorted,
          kickers: [14],
          description: "皇家同花顺",
        };
      }
      return {
        rank: HandRank.STRAIGHT_FLUSH,
        cards: sorted,
        kickers: [this.getStraightHighCard(sorted)],
        description: "同花顺",
      };
    }

    // 统计每个点数的数量
    const valueCounts = this.getValueCounts(sorted);

    // 检查四条
    const quads = Object.entries(valueCounts).find(([_, count]) => count === 4);
    if (quads) {
      const kicker = sorted.find((card) => card.value !== parseInt(quads[0]))!;
      return {
        rank: HandRank.FOUR_OF_A_KIND,
        cards: sorted,
        kickers: [parseInt(quads[0]), kicker.value],
        description: "四条",
      };
    }

    // 检查葫芦
    const trips = Object.entries(valueCounts)
      .filter(([_, count]) => count === 3)
      .map(([v]) => parseInt(v))
      .sort((a, b) => b - a);

    const pairs = Object.entries(valueCounts)
      .filter(([_, count]) => count === 2)
      .map(([v]) => parseInt(v))
      .sort((a, b) => b - a);

    if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
      const tripValue = trips[0];
      const pairValue = trips.length > 1 ? trips[1] : pairs[0];
      return {
        rank: HandRank.FULL_HOUSE,
        cards: sorted,
        kickers: [tripValue, pairValue],
        description: "葫芦",
      };
    }

    // 检查同花
    if (isFlush) {
      return {
        rank: HandRank.FLUSH,
        cards: sorted,
        kickers: sorted.map((c) => c.value),
        description: "同花",
      };
    }

    // 检查顺子
    if (isStraight) {
      return {
        rank: HandRank.STRAIGHT,
        cards: sorted,
        kickers: [this.getStraightHighCard(sorted)],
        description: "顺子",
      };
    }

    // 检查三条
    if (trips.length > 0) {
      const tripValue = trips[0];
      const kickers = sorted
        .filter((card) => card.value !== tripValue)
        .map((c) => c.value);
      return {
        rank: HandRank.THREE_OF_A_KIND,
        cards: sorted,
        kickers: [tripValue, ...kickers],
        description: "三条",
      };
    }

    // 检查两对
    if (pairs.length >= 2) {
      const pairValues = pairs.slice(0, 2);
      const kicker = sorted.find((card) => !pairValues.includes(card.value))!;
      return {
        rank: HandRank.TWO_PAIR,
        cards: sorted,
        kickers: [...pairValues, kicker.value],
        description: "两对",
      };
    }

    // 检查一对
    if (pairs.length === 1) {
      const pairValue = pairs[0];
      const kickers = sorted
        .filter((card) => card.value !== pairValue)
        .map((c) => c.value);
      return {
        rank: HandRank.ONE_PAIR,
        cards: sorted,
        kickers: [pairValue, ...kickers],
        description: "一对",
      };
    }

    // 高牌
    return {
      rank: HandRank.HIGH_CARD,
      cards: sorted,
      kickers: sorted.map((c) => c.value),
      description: "高牌",
    };
  }

  /**
   * 比较两个牌型，返回 1 (a > b), 0 (a = b), -1 (a < b)
   */
  private compareHands(a: HandEvaluation, b: HandEvaluation): number {
    if (a.rank !== b.rank) {
      return a.rank > b.rank ? 1 : -1;
    }

    // 相同牌型，比较kickers
    for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
      const kickerA = a.kickers[i] || 0;
      const kickerB = b.kickers[i] || 0;
      if (kickerA !== kickerB) {
        return kickerA > kickerB ? 1 : -1;
      }
    }

    return 0;
  }

  /**
   * 获取所有C(n,k)组合
   */
  private getCombinations<T>(arr: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];

    const [first, ...rest] = arr;
    const withFirst = this.getCombinations(rest, k - 1).map((combo) => [
      first,
      ...combo,
    ]);
    const withoutFirst = this.getCombinations(rest, k);

    return [...withFirst, ...withoutFirst];
  }

  /**
   * 检查是否是顺子
   */
  private isStraight(cards: Card[]): boolean {
    const values = [...new Set(cards.map((c) => c.value))].sort(
      (a, b) => b - a
    );

    // 特殊情况：A 2 3 4 5 (A作为1)
    if (
      values.length === 5 &&
      values[0] === 14 &&
      values[1] === 5 &&
      values[2] === 4 &&
      values[3] === 3 &&
      values[4] === 2
    ) {
      return true;
    }

    // 普通顺子：5个连续的数字
    if (values.length === 5) {
      for (let i = 0; i < 4; i++) {
        if (values[i] !== values[i + 1] + 1) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  /**
   * 获取顺子的高牌
   */
  private getStraightHighCard(cards: Card[]): number {
    const values = [...new Set(cards.map((c) => c.value))].sort(
      (a, b) => b - a
    );

    // 特殊情况：A 2 3 4 5 (A作为1，高牌是5)
    if (
      values.length === 5 &&
      values[0] === 14 &&
      values[1] === 5 &&
      values[2] === 4 &&
      values[3] === 3 &&
      values[4] === 2
    ) {
      return 5;
    }

    return values[0];
  }

  /**
   * 统计每个点数的出现次数
   */
  private getValueCounts(cards: Card[]): Record<number, number> {
    const counts: Record<number, number> = {};
    cards.forEach((card) => {
      counts[card.value] = (counts[card.value] || 0) + 1;
    });
    return counts;
  }

  public getRemainingDeck(): Card[] {
    return this.remainingDeck;
  }
}
