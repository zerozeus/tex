'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, RotateCw, User, Coins, ArrowLeft, Terminal, Bot } from 'lucide-react';
import { API_CONFIG, gameApiClient } from '@/lib/api-client';

// 类型定义
interface Card {
  suit: '♠' | '♥' | '♦' | '♣';
  rank: string;
  value: number;
}

interface Player {
  id: string;
  name: string;
  chips: number;
  cards: Card[];
  bet: number;
  totalHandBet?: number;
  isFolded: boolean;
  isDealer: boolean;
  isCurrent: boolean;
  isAllIn: boolean;
  isBot: boolean;
}

interface GameState {
  gameId: string;
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'completed';
  endType?: 'hand' | 'game';
  pot: number;
  pots?: { amount: number; eligiblePlayers: string[] }[]; // 奖池列表
  currentBet: number;
  minRaise?: number; // 最小加注额
  communityCards: Card[];
  players: Player[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  showdownRevealed?: boolean;
  resultReady?: boolean;
  winners?: Player[];
  winAmount?: number;
  settlementReason?: 'fold' | 'showdown';
  handSummary?: Record<string, { description: string; bestCards: Card[] }>;
  settings: {
    smallBlind: number;
    bigBlind: number;
    timeLimit: number;
  };
}

// 控制台日志类型
interface ConsoleLog {
  id: string;
  type: 'info' | 'action' | 'phase' | 'pot' | 'error';
  timestamp: string;
  message: string;
  playerName?: string;
}

export default function TexasHoldem() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get('gameId');
  const DEBUG = process.env.NEXT_PUBLIC_POKER_DEBUG === '1';
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [betAmount, setBetAmount] = useState<number>(10);
  const [currentPlayerId] = useState<string>('1'); // 假设当前玩家ID为1
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [showConsole, setShowConsole] = useState(true);
  const previousGameStateRef = useRef<GameState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const handStartChipsRef = useRef<Record<string, number> | null>(null);
  const handStartGameIdRef = useRef<string | null>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [consoleLogs.length, showConsole]);

  // 添加控制台日志
  const addConsoleLog = (type: ConsoleLog['type'], message: string, playerName?: string) => {
    const newLog: ConsoleLog = {
      id: `${Date.now()}-${Math.random()}`,
      type,
      timestamp: new Date().toLocaleTimeString('zh-CN'),
      message,
      playerName,
    };
    setConsoleLogs(prev => [...prev, newLog]);
  };

  // 获取阶段名称
  function getPhaseName(phase: GameState['phase']): string {
    const names: Record<string, string> = {
      preflop: '翻牌前',
      flop: '翻牌',
      turn: '转牌',
      river: '河牌',
      showdown: '摊牌',
    };
    return names[phase] || phase;
  }

  type SettlementRow = {
    player: Player;
    delta: number;
    isWinner: boolean;
    handDescription?: string;
    bestCards?: Card[];
  };

  type WinnerInfo = {
    endType: 'hand' | 'game';
    champion?: Player;
    winners: Player[];
    amount: number;
    show: boolean;
    gameId: string;
    reasonLabel: string;
    boardCards: Card[];
    showBoard: boolean;
    showHands: boolean;
    rows: SettlementRow[];
    pots?: { amount: number; eligiblePlayers: string[] }[];
    baselineLabel: string;
  };

  const [winnerInfo, setWinnerInfo] = useState<WinnerInfo | null>(null);

  // 倒计时引用
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const [nextRoundCountdown, setNextRoundCountdown] = useState(0);
  const showdownCountdownRef = useRef<NodeJS.Timeout | null>(null);
  const settleInFlightRef = useRef(false);
  const [showdownCountdown, setShowdownCountdown] = useState(0);
  const resultRevealCountdownRef = useRef<NodeJS.Timeout | null>(null);
  const pendingResultRef = useRef<WinnerInfo | null>(null);
  const [resultRevealCountdown, setResultRevealCountdown] = useState(0);
  const nextRoundInFlightRef = useRef(false);
  const [nextRoundInFlight, setNextRoundInFlight] = useState(false);

  const debugLog = (...args: unknown[]) => {
    if (!DEBUG) return;
    console.debug('[ui]', ...args);
  };

  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [showConsole, winnerInfo?.show, nextRoundInFlight]);

  function snapshotHandStart(state: GameState): void {
    handStartGameIdRef.current = state.gameId;
    handStartChipsRef.current = Object.fromEntries(
      state.players.map(p => [p.id, p.chips + (p.totalHandBet ?? p.bet ?? 0)])
    );
  }

  function formatCardText(card: Card): string {
    return `${card.rank}${card.suit}`;
  }

  function buildWinnerInfo(prev: GameState | null, nextState: GameState, winners: Player[], amount: number): WinnerInfo {
    const winnersById = new Set(winners.map(w => w.id));
    const showHands = nextState.showdownRevealed === true || prev?.phase === 'showdown';
    const showBoard = nextState.communityCards.length === 5;
    const endType: WinnerInfo['endType'] = nextState.endType === 'game' ? 'game' : 'hand';
    const champion = endType === 'game' ? winners[0] : undefined;

    const baseline =
      handStartGameIdRef.current === nextState.gameId ? handStartChipsRef.current : null;
    const prevChips = prev ? Object.fromEntries(prev.players.map(p => [p.id, p.chips])) : null;
    const baselineLabel = baseline ? '本手净输赢' : '结算变化';

    const rows: SettlementRow[] = nextState.players.map(player => {
      const base = baseline?.[player.id] ?? prevChips?.[player.id] ?? player.chips;
      const delta = player.chips - base;
      const summary =
        showHands && !player.isFolded ? nextState.handSummary?.[player.id] : undefined;
      return {
        player,
        delta,
        isWinner: winnersById.has(player.id),
        handDescription: summary?.description,
        bestCards: summary?.bestCards,
      };
    });

    rows.sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
      return a.player.name.localeCompare(b.player.name, 'zh-CN');
    });

    const isFoldWin =
      nextState.settlementReason === 'fold' ||
      (prev?.phase !== 'showdown' && nextState.communityCards.length < 5);

    return {
      endType,
      champion,
      winners,
      amount,
      show: true,
      gameId: nextState.gameId,
      reasonLabel: isFoldWin ? '弃牌获胜' : '比牌胜出',
      boardCards: nextState.communityCards,
      showBoard,
      showHands,
      rows,
      pots: nextState.pots,
      baselineLabel,
    };
  }

  function startNextRoundAuto(gameId: string) {
    setNextRoundCountdown(10);
    if (countdownRef.current) clearInterval(countdownRef.current);

    countdownRef.current = setInterval(() => {
      setNextRoundCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          handleNextRound(gameId);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function isGameState(value: unknown): value is GameState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Partial<GameState> & Record<string, unknown>;

    return (
      typeof v.gameId === 'string' &&
      typeof v.phase === 'string' &&
      typeof v.pot === 'number' &&
      typeof v.currentBet === 'number' &&
      Array.isArray(v.communityCards) &&
      Array.isArray(v.players) &&
      typeof v.currentPlayerIndex === 'number' &&
      typeof v.dealerIndex === 'number' &&
      typeof v.smallBlindIndex === 'number' &&
      typeof v.bigBlindIndex === 'number' &&
      typeof v.settings === 'object' &&
      v.settings !== null
    );
  }

  function applyIncomingGameState(rawNextState: unknown): boolean {
    if (!isGameState(rawNextState)) return false;
    const nextState = rawNextState;
    let prev = previousGameStateRef.current;
    if (prev && prev.gameId !== nextState.gameId) {
      debugLog('gameId changed', { from: prev.gameId, to: nextState.gameId });
      prev = null;
      previousGameStateRef.current = null;
      setWinnerInfo(null);
      if (countdownRef.current) clearInterval(countdownRef.current);
      setNextRoundCountdown(0);
      if (showdownCountdownRef.current) {
        clearInterval(showdownCountdownRef.current);
        showdownCountdownRef.current = null;
      }
      settleInFlightRef.current = false;
      setShowdownCountdown(0);
      if (resultRevealCountdownRef.current) {
        clearInterval(resultRevealCountdownRef.current);
        resultRevealCountdownRef.current = null;
      }
      pendingResultRef.current = null;
      setResultRevealCountdown(0);
    }

    if (prev) {
      if (
        prev.phase !== nextState.phase ||
        prev.currentPlayerIndex !== nextState.currentPlayerIndex ||
        prev.pot !== nextState.pot ||
        prev.currentBet !== nextState.currentBet
      ) {
        debugLog('state', {
          gameId: nextState.gameId,
          phase: `${prev.phase} -> ${nextState.phase}`,
          endType: nextState.endType,
          resultReady: nextState.resultReady,
          winners: nextState.winners?.map(w => w.id),
          pot: `${prev.pot} -> ${nextState.pot}`,
          currentBet: `${prev.currentBet} -> ${nextState.currentBet}`,
          currentPlayerIndex: `${prev.currentPlayerIndex} -> ${nextState.currentPlayerIndex}`,
        });
      }
    } else {
      debugLog('state', {
        gameId: nextState.gameId,
        phase: nextState.phase,
        endType: nextState.endType,
        resultReady: nextState.resultReady,
        players: nextState.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, isBot: p.isBot })),
      });
    }

    if (!prev) {
      if (nextState.phase === 'preflop') {
        snapshotHandStart(nextState);
      }
      addConsoleLog('info', `游戏 ${nextState.gameId.substring(0, 8)} 已加载`);
      addConsoleLog('phase', `游戏阶段: ${getPhaseName(nextState.phase)}`);
      nextState.players.forEach(player => {
        addConsoleLog('info', `玩家 ${player.name} 加入游戏，筹码: ${player.chips}`);
      });

      if (nextState.phase === 'completed') {
        const winners = nextState.winners || [];
        const winAmount = nextState.winAmount || 0;
        if (winners.length > 0) {
          const built = buildWinnerInfo(null, nextState, winners, winAmount);
          setWinnerInfo(built);
          if (built.endType !== 'game') {
            startNextRoundAuto(nextState.gameId);
          }
        }
      }
    } else {
      // 动作日志记录...
      nextState.players.forEach((player, index) => {
        const prevPlayer = prev.players[index];
        if (!prevPlayer) return;

        if (!prevPlayer.isFolded && player.isFolded) {
          addConsoleLog('action', `${player.name} 弃牌`, player.name);
        }

        if (!prevPlayer.isAllIn && player.isAllIn) {
          addConsoleLog('action', `${player.name} 全押！`, player.name);
        }

        if (player.bet !== prevPlayer.bet) {
          const betDiff = player.bet - prevPlayer.bet;
          if (betDiff > 0) {
            if (player.bet === nextState.currentBet && prevPlayer.bet < prev.currentBet) {
              addConsoleLog('action', `${player.name} 跟注 ${betDiff}`, player.name);
            } else if (player.bet > prev.currentBet) {
              addConsoleLog('action', `${player.name} 加注到 ${player.bet}`, player.name);
            }
          }
        }
      });

      // 阶段变化处理
      if (prev.phase !== nextState.phase) {
        if (showdownCountdownRef.current) {
          clearInterval(showdownCountdownRef.current);
          showdownCountdownRef.current = null;
        }
        settleInFlightRef.current = false;
        setShowdownCountdown(0);

        if (resultRevealCountdownRef.current) {
          clearInterval(resultRevealCountdownRef.current);
          resultRevealCountdownRef.current = null;
        }
        pendingResultRef.current = null;
        setResultRevealCountdown(0);

        // 如果进入 Completed 结算阶段
        if (nextState.phase === 'completed' && prev.phase !== 'completed') {
           setNextRoundCountdown(0);
           if (countdownRef.current) clearInterval(countdownRef.current);
           // 从服务端状态获取获胜信息
           const winners = nextState.winners || [];
           const winAmount = nextState.winAmount || 0;
           
           if (winners.length > 0) {
             const isFoldWin = prev.phase !== 'showdown' && nextState.communityCards.length < 5;
             const built = buildWinnerInfo(prev, nextState, winners, winAmount);
             if (isFoldWin && built.endType !== 'game') {
               addConsoleLog('info', `对手弃牌，本局无需摊牌`);
               pendingResultRef.current = built;
               setResultRevealCountdown(5);
               resultRevealCountdownRef.current = setInterval(() => {
                 setResultRevealCountdown(prev => {
                   if (prev <= 1) {
                     if (resultRevealCountdownRef.current) {
                       clearInterval(resultRevealCountdownRef.current);
                       resultRevealCountdownRef.current = null;
                     }
                     const pending = pendingResultRef.current;
                     pendingResultRef.current = null;
                     if (pending) {
                       setWinnerInfo(pending);
                       if (pending.endType === 'game') {
                         addConsoleLog('info', `👑 ${pending.champion?.name ?? pending.winners[0]?.name ?? '赢家'} 赢得整局！`, pending.champion?.name);
                       } else {
                         addConsoleLog('info', `🏆 ${pending.winners.map(w => w.name).join(' & ')} 赢得本局！`, pending.winners[0]?.name);
                         startNextRoundAuto(pending.gameId);
                       }
                     }
                     return 0;
                   }
                   return prev - 1;
                 });
               }, 1000);
             } else {
               setWinnerInfo(built);
               if (built.endType === 'game') {
                 addConsoleLog('info', `👑 ${built.champion?.name ?? winners[0].name} 赢得整局！`, built.champion?.name ?? winners[0].name);
               } else {
                 addConsoleLog('info', `🏆 ${winners.map(w => w.name).join(' & ')} 赢得本局！`, winners[0].name);
                 startNextRoundAuto(nextState.gameId);
               }
             }
           }
        }
        // 如果是新一局开始 (Preflop)
        else if (nextState.phase === 'preflop' && (prev.phase === 'completed' || prev.phase === 'showdown')) {
          setWinnerInfo(null);
          setNextRoundCountdown(0);
          if (countdownRef.current) clearInterval(countdownRef.current);
          snapshotHandStart(nextState);
          addConsoleLog('phase', `🎲 开始新一局游戏`);
        }
        else {
          addConsoleLog('phase', `阶段变化: ${getPhaseName(prev.phase)} → ${getPhaseName(nextState.phase)}`);
          
          if (nextState.phase === 'showdown') {
             addConsoleLog('info', `🏆 摊牌时刻！`);
             if (!nextState.resultReady) {
               setShowdownCountdown(5);
               showdownCountdownRef.current = setInterval(() => {
                 setShowdownCountdown(prev => {
                   if (prev <= 1) {
                     if (showdownCountdownRef.current) {
                       clearInterval(showdownCountdownRef.current);
                       showdownCountdownRef.current = null;
                     }
                     if (!settleInFlightRef.current) {
                       settleInFlightRef.current = true;
                       void handleSettleShowdown(nextState.gameId);
                     }
                     return 0;
                   }
                   return prev - 1;
                 });
               }, 1000);
             }
          }
        }
      }

      // 轮次变化日志
      if (prev.currentPlayerIndex !== nextState.currentPlayerIndex && nextState.phase !== 'completed') {
        const currentPlayer = nextState.players[nextState.currentPlayerIndex];
        addConsoleLog('info', `轮到: ${currentPlayer?.name ?? '未知玩家'}`, currentPlayer?.name);
        if (currentPlayer?.id === currentPlayerId) {
             setBetAmount(nextState.minRaise || nextState.settings.bigBlind);
        }
      }

      if (prev.pot !== nextState.pot && nextState.phase !== 'preflop' && nextState.phase !== 'completed') {
        addConsoleLog('pot', `底池变化: ${prev.pot} → ${nextState.pot}`);
      }
    }

    previousGameStateRef.current = nextState;
    setGameState(nextState);
    return true;
  }


  // 手动进入下一局
  async function handleNextRound(gameId: string) {
    if (nextRoundInFlightRef.current) return;
    nextRoundInFlightRef.current = true;
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextRoundCountdown(0);
    
    try {
      setNextRoundInFlight(true);
      debugLog('nextRound start', { gameId });
      const result = await gameApiClient.nextRound(gameId);
      debugLog('nextRound response', { success: result.success, hasData: Boolean(result.data), error: result.error, message: result.message });
      if (result.success && !result.data) {
        debugLog('nextRound no data, fallback to getGameState', { gameId });
        const refreshed = await gameApiClient.getGameState(gameId);
        debugLog('getGameState response', { success: refreshed.success, hasData: Boolean(refreshed.data), error: refreshed.error, message: refreshed.message });
        if (refreshed.success && refreshed.data) {
          const applied = applyIncomingGameState(refreshed.data);
          if (!applied) {
            setError('游戏状态格式不正确');
            addConsoleLog('error', '进入下一局失败: 游戏状态格式不正确');
          }
          return;
        }
        const message = refreshed.error || '进入下一局失败';
        setError(message);
        addConsoleLog('error', `进入下一局失败: ${message}`);
        return;
      }

      if (result.success && result.data) {
        const applied = applyIncomingGameState(result.data as GameState);
        if (!applied) {
          setError('游戏状态格式不正确');
          addConsoleLog('error', '进入下一局失败: 游戏状态格式不正确');
        }
        return;
      }

      const message = result.error || result.message || '进入下一局失败';
      setError(message);
      addConsoleLog('error', `进入下一局失败: ${message}`);
    } catch (err) {
      console.error('Failed to start next round:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError('网络错误，请重试');
      addConsoleLog('error', `网络错误: ${message}`);
    } finally {
      debugLog('nextRound end', { gameId });
      nextRoundInFlightRef.current = false;
      setNextRoundInFlight(false);
    }
  }

  async function handleSettleShowdown(gameId: string) {
    try {
      const result = await gameApiClient.settleShowdown(gameId);
      if (result.success && result.data) {
        applyIncomingGameState(result.data as GameState);
      } else {
        const message = result.error || '结算失败';
        if (message.includes('当前不在摊牌阶段') || message.includes('结果已结算')) {
          return;
        }
        setError(message);
        addConsoleLog('error', `结算失败: ${message}`);
      }
    } catch (err) {
      console.error('Failed to settle showdown:', err);
      setError('网络错误，请重试');
      addConsoleLog('error', '网络错误');
    }
  }


  // 加载游戏状态
  async function loadGame(gameId: string) {
    setLoading(true);
    setError('');

    try {
      const result = await gameApiClient.getGameState(gameId);

      if (result.success && result.data) {
        const applied = applyIncomingGameState(result.data);
        if (!applied) {
          setError('游戏状态格式不正确');
          addConsoleLog('error', '加载失败: 游戏状态格式不正确');
        }
        setLoading(false);
      } else {
        setError(result.error || '游戏加载失败');
        setLoading(false);
        addConsoleLog('error', `加载失败: ${result.error}`);
      }
    } catch (err) {
      console.error('Failed to load game:', err);
      setError('网络错误，请重试');
      setLoading(false);
      const message = err instanceof Error ? err.message : String(err);
      addConsoleLog('error', `网络错误: ${message}`);
    }
  }

  const getLogLabel = (type: ConsoleLog['type']) => {
    switch (type) {
      case 'phase':
        return '状态';
      case 'action':
        return '行动';
      case 'pot':
        return '底池';
      case 'error':
        return '错误';
      case 'info':
      default:
        return '系统';
    }
  };

  useEffect(() => {
    if (!gameState?.gameId) return;

    let wsUrl = '';
    if (API_CONFIG.WS_SERVER_URL) {
      try {
        const u = new URL(API_CONFIG.WS_SERVER_URL);
        if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
        wsUrl = u.toString();
      } catch {
        wsUrl = API_CONFIG.WS_SERVER_URL;
      }
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      wsUrl = `${protocol}://${window.location.host}/ws`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let active = true;

    ws.onopen = () => {
      debugLog('ws open', { wsUrl, gameId: gameState.gameId, playerId: currentPlayerId });
      addConsoleLog('info', `WebSocket 已连接: ${wsUrl}`);
      ws.send(JSON.stringify({ type: 'join_game', data: { gameId: gameState.gameId, playerId: currentPlayerId } }));
    };

    ws.onclose = () => {
      if (!active) return;
      debugLog('ws close');
      addConsoleLog('error', 'WebSocket 已断开');
    };

    ws.onerror = () => {
      if (!active) return;
      debugLog('ws error');
      addConsoleLog('error', 'WebSocket 发生错误');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        debugLog('ws message', { type: message.type, keys: message.data ? Object.keys(message.data) : undefined });
        if (message.type === 'connected') {
          addConsoleLog('info', message.data?.message || '已连接到服务器');
          return;
        }
        if (message.type === 'bot_thinking') {
          addConsoleLog('info', `🤖 ${message.data.playerName} 正在思考...`, message.data.playerName);
        } else if (message.type === 'bot_decision') {
          const { playerName, action, amount } = message.data;
          const chat = message.chat;
          
          addConsoleLog('action', `🤖 [${playerName}] ${action}${amount ? ` ${amount}` : ''}`, playerName);
          if (chat) {
            addConsoleLog('action', `💬 [${playerName}] ${chat}`, playerName);
          }
        } else if (message.type === 'game_update' || message.type === 'game_state') {
          if (isGameState(message.data)) {
            addConsoleLog('info', `收到状态更新: ${getPhaseName(message.data.phase)} / 底池 ${message.data.pot} / 玩家 ${message.data.players.length}`);
          } else {
            addConsoleLog('error', '收到状态更新但数据格式不正确，已忽略');
          }
          applyIncomingGameState(message.data);
        }
      } catch (e) {
        console.error('WS message error:', e);
      }
    };

    return () => {
      active = false;
      if (wsRef.current === ws) wsRef.current = null;
      ws.close();
    };
  }, [gameState?.gameId]);

  // 初始化游戏
  useEffect(() => {
    const timerId = setTimeout(() => {
      if (gameId) {
        setLoading(true);
        void loadGame(gameId);
      }
    }, 0);

    // 清理定时器
    return () => {
      clearTimeout(timerId);
    };
  }, [gameId]);

  // 刷新游戏状态
  const refreshGame = async () => {
    if (!gameState) return;
    addConsoleLog('info', '刷新游戏状态...');

    try {
      const result = await gameApiClient.getGameState(gameState.gameId);
      if (result.success && result.data) {
        const applied = applyIncomingGameState(result.data);
        if (!applied) addConsoleLog('error', '刷新失败: 游戏状态格式不正确');
      }
    } catch (err) {
      console.error('Failed to refresh game:', err);
      const message = err instanceof Error ? err.message : String(err);
      addConsoleLog('error', `刷新失败: ${message}`);
    }
  };

  // 渲染扑克牌
  const renderCard = (card: Card, hidden: boolean = false) => {
    if (hidden) {
      return (
        <div className="w-14 h-20 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg shadow-md flex items-center justify-center border-2 border-blue-400">
          <div className="w-10 h-16 bg-blue-700 rounded"></div>
        </div>
      );
    }

    const isRed = card.suit === '♥' || card.suit === '♦';

    return (
      <div className="w-14 h-20 bg-white rounded-lg shadow-md flex flex-col items-center justify-center border-2 border-gray-200">
        <div className={`text-xl font-bold ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {card.rank}
        </div>
        <div className={`text-2xl ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {card.suit}
        </div>
      </div>
    );
  };

  // 玩家操作处理
  const handlePlayerAction = async (action: string, amount?: number) => {
    if (!gameState) return;

    setError('');

    try {
      const result = await gameApiClient.playerAction(
        gameState.gameId,
        currentPlayerId,
        action,
        amount
      );

      if (result.success && result.data) {
        const nextState = result.data as GameState;
        applyIncomingGameState(nextState);
      } else {
        setError(result.error || '操作失败');
        addConsoleLog('error', `操作失败: ${result.error}`);
      }
    } catch (err) {
      console.error('Action failed:', err);
      setError('网络错误，请重试');
      addConsoleLog('error', '网络错误');
    }
  };

  // 检查当前玩家是否可以执行某个操作
  const canPerformAction = (action: string): boolean => {
    if (!gameState) return false;

    const currentPlayer = gameState.players[gameState.currentPlayerIndex];

    // 检查是否是当前玩家的回合
    if (!currentPlayer || currentPlayer.id !== currentPlayerId) {
      return false;
    }

    // 检查玩家是否已弃牌
    if (currentPlayer.isFolded) {
      return false;
    }

    // 检查具体操作是否允许
    switch (action) {
      case 'check':
        return gameState.currentBet === currentPlayer.bet;
      case 'call':
        return gameState.currentBet > currentPlayer.bet &&
               gameState.currentBet - currentPlayer.bet <= currentPlayer.chips;
      case 'bet': {
        if (gameState.currentBet > 0) return false;
        const amount = betAmount || 0;
        if (amount <= 0) return false;
        if (amount < gameState.settings.bigBlind) return false;
        return amount <= currentPlayer.chips;
      }
      case 'raise':
        if (gameState.currentBet === 0) return false;
        const raiseAmount = betAmount || 0;
        if (raiseAmount <= 0) return false;
        const minRaise = gameState.minRaise || gameState.settings.bigBlind;
        if (raiseAmount < minRaise) return false;
        return gameState.currentBet - currentPlayer.bet + raiseAmount <= currentPlayer.chips;
      default:
        return true;
    }
  };

  // 玩家操作函数
  const handleFold = () => handlePlayerAction('fold');
  const handleCheck = () => handlePlayerAction('check');
  const handleCall = () => handlePlayerAction('call');
  const handleBet = () => handlePlayerAction('bet', betAmount);
  const handleRaise = () => handlePlayerAction('raise', betAmount);
  const handleAllIn = () => handlePlayerAction('allin');

  // 欢迎界面
  if (!loading && !gameState && !error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full bg-white/10 border-white/20">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">德州扑克</h1>
            <p className="text-gray-400">欢迎来到德州扑克游戏</p>
          </div>

          <div className="space-y-4">
            <Button
              size="lg"
              onClick={() => router.push('/setup')}
              className="w-full h-14 text-lg font-bold bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700"
            >
              <Play className="w-6 h-6 mr-2" />
              开始新游戏
            </Button>

            <div className="pt-6 border-t border-white/20">
              <h3 className="text-white font-semibold mb-3">游戏特色</h3>
              <ul className="space-y-2 text-gray-400 text-sm">
                <li className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  支持2-9人对战
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  自定义盲注和筹码
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  实时游戏状态
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  完整的游戏流程
                </li>
                <li className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  实时操作日志
                </li>
              </ul>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // 加载中
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto"></div>
          <p className="mt-4 text-white">加载游戏...</p>
        </div>
      </div>
    );
  }

  // 错误状态
  if (error && !gameState) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full bg-white/10 border-white/20">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white mb-4">出错了</h2>
            <p className="text-red-400 mb-6">{error}</p>
            <Button onClick={() => router.push('/setup')} className="bg-white/10 hover:bg-white/20 text-white">
              <ArrowLeft className="w-4 h-4 mr-2" />
              返回设置
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!gameState) {
    // 如果没有 gameId，显示引导界面
    if (!gameId) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
          <Card className="p-8 max-w-lg w-full bg-white/10 border-white/20 backdrop-blur">
            <div className="text-center">
              <div className="mb-6 flex justify-center">
                <div className="w-20 h-20 bg-gradient-to-br from-green-500 to-green-700 rounded-full flex items-center justify-center">
                  <span className="text-4xl">🃏</span>
                </div>
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">德州扑克</h1>
              <p className="text-gray-300 mb-6">Texas Hold'em</p>
              <p className="text-gray-400 mb-8">
                欢迎来到德州扑克游戏！<br />
                点击下方按钮开始游戏设置
              </p>
              <Button
                onClick={() => router.push('/setup')}
                className="bg-gradient-to-r from-green-500 to-green-700 hover:from-green-600 hover:to-green-800 text-white font-semibold px-8 py-3"
              >
                <Play className="w-5 h-5 mr-2" />
                开始游戏
              </Button>
              {error && (
                <p className="mt-4 text-red-400 text-sm">{error}</p>
              )}
            </div>
          </Card>
        </div>
      );
    }
    
    // 如果有 gameId 但 gameState 为 null，显示错误
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-red-600 mb-4">游戏初始化失败</p>
          <p className="text-gray-400 mb-4">游戏ID: {gameId}</p>
          <Button onClick={() => router.push('/setup')}>返回设置</Button>
        </div>
      </div>
    );
  }

  function rotatePlayers(players: Player[], myId: string): Player[] {
    const myIndex = players.findIndex(p => p.id === myId);
    if (myIndex <= 0) return players;
    return [...players.slice(myIndex), ...players.slice(0, myIndex)];
  }

  function getSeatPositions(seatCount: number): Array<{ leftPct: number; topPct: number }> {
    // 基础半径设置（百分比）
    const rx = 42; // 水平半径
    const ry = 32; // 垂直半径 (减小以避免上下边缘溢出)

    // 如果只有2人，直接上下对战
    if (seatCount === 2) {
      return [
        { leftPct: 50, topPct: 88 }, // 自己（底部） - 贴底
        { leftPct: 50, topPct: 12 }, // 对手（顶部） - 贴顶
      ];
    }

    return Array.from({ length: seatCount }, (_, seatIndex) => {
      // 座位 0 固定在底部中心 (270度 / -90度)
      // 其他座位从底部顺时针分布
      
      // 计算角度：底部为起点 (Math.PI / 2 * 3)，顺时针分布
      // 为了让 seat 0 在底部，我们需要特殊的映射
      // seat 0 -> 90度 (Math.PI/2) -- 在Canvas坐标系中，90度是正下方
      
      // 让我们重新定义：
      // 0度: 右侧
      // 90度: 底部
      // 180度: 左侧
      // 270度: 顶部
      
      if (seatIndex === 0) {
        return { leftPct: 50, topPct: 100 }; // 强制底部对齐
      }
      
      // 计算对家位置（如果有偶数个座位，seatCount/2 的位置应该在顶部）
      const topSeatIndex = Math.floor(seatCount / 2);
      if (seatIndex === topSeatIndex) {
        return { leftPct: 50, topPct: 0 }; // 强制顶部对齐
      }

      // 其他座位均匀分布
      // 我们希望座位分布在椭圆周围
      // 我们可以将剩余座位分为两组：左边和右边
      
      // 简单算法：平均分布角度，然后修正 0 和 top 的位置
      const angleStep = 360 / seatCount;
      const angleDeg = 90 + angleStep * seatIndex;
      
      const angleRad = (Math.PI / 180) * angleDeg;
      
      // 计算位置
      let leftPct = 50 + Math.cos(angleRad) * rx;
      let topPct = 50 + Math.sin(angleRad) * ry;
      
      // 底部玩家特殊位置修正：大幅上移避免被底部操作栏遮挡
      if (seatIndex === 0) {
        topPct = 88; // 与2人模式保持一致
      }
      
      // 边缘修正：防止溢出
      leftPct = Math.max(0, Math.min(100, leftPct));
      topPct = Math.max(0, Math.min(100, topPct));
      
      return { leftPct, topPct };
    });
  }

  const isMyTurn = gameState.phase !== 'showdown' && gameState.phase !== 'completed' && gameState.players[gameState.currentPlayerIndex]?.id === currentPlayerId;
  const revealOthers = gameState.showdownRevealed === true;
  const isShowdownPending = gameState.phase === 'showdown' && !gameState.resultReady;
  const isFoldResultPending = gameState.phase === 'completed' && !winnerInfo && resultRevealCountdown > 0;
  const seatedPlayers = rotatePlayers(gameState.players, currentPlayerId);
  const seatCount = seatedPlayers.length;
  const seatPositions = getSeatPositions(seatCount);
  // 增加卡片宽度以适应左右布局
  const seatCardClass =
    seatCount >= 8 ? 'w-52' : seatCount >= 6 ? 'w-56' : seatCount >= 4 ? 'w-60' : 'w-64'; 
  
  // 视觉风格配置
  const tableColorClass = "bg-[#35654d]"; // 经典德州绿
  const tableBorderClass = "border-[#4a3728]"; // 木纹色边框

  function renderSeatCard(player: Player, variant: 'table' | 'compact') {
    const isMe = player.id === currentPlayerId;
    const hiddenCards = !isMe && (!revealOthers || player.isFolded);
    // 缩小卡片尺寸以适应框内显示
    const cardSizeClass = variant === 'compact' ? 'w-8 h-12' : 'w-10 h-14';
    
    // 玩家卡片样式升级
    const cardBgClass = isMe 
      ? 'bg-black/90 border-yellow-500/50' 
      : player.isCurrent 
        ? 'bg-black/80 border-yellow-400' 
        : 'bg-black/60 border-white/10';
        
    const textColorClass = 'text-white';

    return (
      <Card
        className={`relative transition-all border shadow-xl backdrop-blur-sm overflow-visible ${cardBgClass} ${
          player.isCurrent ? 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-transparent' : ''
        } ${player.isFolded ? 'opacity-50 grayscale' : ''}`}
      >
        <div className="flex items-center justify-between p-2 gap-1 h-20">
          {/* 左侧信息区域：头像、名字、筹码 */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
             <div className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${player.isBot ? 'bg-purple-900' : 'bg-blue-900'} border-2 border-white/20 shadow-inner`}>
               {player.isBot ? <Bot className="w-5 h-5 text-purple-200" /> : <User className="w-5 h-5 text-blue-200" />}
             </div>
             
             <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1">
                  <span className={`text-sm font-bold truncate max-w-[60px] ${textColorClass}`}>{player.name}</span>
                  {player.isDealer && <Badge variant="secondary" className="h-3 px-1 text-[9px] bg-white text-black font-bold shrink-0">D</Badge>}
                  {isMe && <Badge variant="default" className="h-3 px-1 text-[9px] bg-blue-600 shrink-0">你</Badge>}
                </div>
                <div className="flex items-center gap-1">
                   <Coins className="w-3 h-3 text-yellow-400 shrink-0" />
                   <span className="text-xs text-yellow-400 font-mono font-bold tracking-wide">{player.chips}</span>
                </div>
             </div>
          </div>
          
          {/* 右侧手牌区域 - 在框内靠右 */}
          <div className="flex justify-center pl-1 shrink-0 pr-4">
            {player.cards.length > 0 ? (
               player.cards.map((card, index) => (
                <div key={index} className={`${cardSizeClass} shadow-2xl transform transition-transform hover:-translate-y-2 ${index === 0 ? '-rotate-[12deg]' : 'rotate-[12deg]'}`}>
                  {renderCard(card, hiddenCards)}
                </div>
              ))
            ) : (
              // 占位符，保持高度一致
              <div className={`${cardSizeClass} opacity-0`}></div>
            )}
          </div>
        </div>

        {/* 下注额展示 - 悬浮在右上角 */}
        {player.bet > 0 && (
          <div className="absolute -top-3 -right-2 bg-yellow-500 text-black px-2 py-0.5 rounded-md border border-yellow-600 flex items-center gap-1 shadow-lg z-20 font-bold text-xs">
            <Coins className="w-3 h-3" />
            <span>{player.bet}</span>
          </div>
        )}

        {/* 全押标识 */}
        {player.isAllIn && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-600/90 text-white text-xs font-bold px-4 py-1 rounded-sm rotate-12 border-2 border-white shadow-lg z-30 animate-pulse whitespace-nowrap">
            ALL IN
          </div>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-br from-green-800 to-green-900 overflow-hidden">
      {/* 顶部导航栏 */}
      <div className="flex justify-between items-center p-4 text-white z-10 shrink-0">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/setup')}
            className="bg-white/10 hover:bg-white/20 text-white border-white/20 backdrop-blur-sm"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回
          </Button>
          <h1 className="text-xl font-bold hidden sm:block">德州扑克</h1>
          <Badge variant="secondary" className="bg-white/20 backdrop-blur-sm">
            {getPhaseName(gameState.phase).toUpperCase()}
          </Badge>
          <Badge
            variant={isMyTurn ? 'default' : 'secondary'}
            className={`${isMyTurn ? 'bg-yellow-500 text-black' : 'bg-white/20 text-white'} backdrop-blur-sm transition-colors`}
          >
            {isMyTurn ? '你的回合' : '等待中'}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowConsole(v => !v)}
            className="bg-white/10 hover:bg-white/20 text-white border-white/20 backdrop-blur-sm"
          >
            <Terminal className="w-4 h-4 mr-2" />
            日志
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshGame}
            disabled={loading}
            className="bg-white/10 hover:bg-white/20 text-white border-white/20 backdrop-blur-sm"
          >
            <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''} mr-2`} />
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-2 bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded-lg backdrop-blur-md z-20">
          {error}
        </div>
      )}

      {/* 游戏主区域 - 占据剩余空间，增加底部padding避免遮挡 */}
      <div className="flex-1 relative flex items-center justify-center p-4 md:p-8 pb-32 md:pb-40 overflow-hidden">
        <Card className={`relative w-full max-w-6xl aspect-[16/9] ${tableColorClass} border-[12px] ${tableBorderClass} rounded-[120px] shadow-2xl flex items-center justify-center overflow-visible`}>
            {isShowdownPending && (
              <div className="absolute left-1/2 top-6 -translate-x-1/2 z-30 bg-black/60 backdrop-blur-md px-5 py-2 rounded-full border border-white/10 shadow-lg">
                <span className="text-white font-bold">
                  摊牌中{showdownCountdown > 0 ? `，${showdownCountdown}s 后结算` : '，结算中...'}
                </span>
              </div>
            )}
            {isFoldResultPending && (
              <div className="absolute left-1/2 top-6 -translate-x-1/2 z-30 bg-black/60 backdrop-blur-md px-5 py-2 rounded-full border border-white/10 shadow-lg">
                <span className="text-white font-bold">
                  对手弃牌，{resultRevealCountdown}s 后展示结果
                </span>
              </div>
            )}
            {/* 移动端简易视图 */}
            <div className="md:hidden w-full h-full p-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2 mb-4">
                {seatedPlayers.map(player => (
                  <div key={player.id}>{renderSeatCard(player, 'compact')}</div>
                ))}
              </div>

              <div className="flex justify-center items-center gap-2 my-4 bg-black/20 p-2 rounded-xl">
                {gameState.communityCards.length === 0 ? (
                  <div className="flex gap-1">
                    {[...Array(5)].map((_, index) => (
                      <div
                        key={index}
                        className="w-10 h-14 bg-green-900/40 rounded border border-green-500/30 flex items-center justify-center"
                      >
                        <span className="text-white/20 text-lg">?</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex gap-1">
                    {gameState.communityCards.map((card, index) => (
                      <div key={index} className="w-10 h-14 transform scale-90">{renderCard(card)}</div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-center">
                <div className="bg-black/40 px-4 py-1.5 rounded-full border border-yellow-500/20">
                  <div className="flex items-center gap-2 text-white">
                    <Coins className="w-4 h-4 text-yellow-400" />
                    <span className="text-sm font-bold">底池: {gameState.pot}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 桌面端完整视图 */}
            <div className="hidden md:block absolute inset-0">
              {/* 公共牌区域 - 绝对居中 */}
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-6 z-10">
                <div className="flex justify-center items-center gap-3">
                  {gameState.communityCards.length === 0 ? (
                    <div className="flex gap-3">
                      {[...Array(5)].map((_, index) => (
                        <div
                          key={index}
                          className="w-16 h-24 bg-green-900/20 rounded-lg border-2 border-green-800/30 flex items-center justify-center shadow-inner"
                        >
                          <div className="w-12 h-20 border border-green-800/20 rounded opacity-30"></div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-3 perspective-1000">
                      {gameState.communityCards.map((card, index) => (
                        <div key={index} className="animate-in fade-in zoom-in duration-500 shadow-xl rounded-lg">
                          {renderCard(card)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-black/40 px-8 py-2 rounded-full border border-yellow-500/20 backdrop-blur-sm shadow-lg">
                  <div className="flex items-center gap-3 text-white">
                    <Coins className="w-6 h-6 text-yellow-400 drop-shadow-md" />
                    <span className="text-2xl font-bold font-mono tracking-wider text-yellow-100 drop-shadow-md">
                      {gameState.pot}
                    </span>
                  </div>
                </div>
              </div>

              {/* 玩家座位 */}
              {seatedPlayers.map((player, seatIndex) => {
                const pos = seatPositions[seatIndex];
                return (
                  <div
                    key={player.id}
                    className={`${seatCardClass} z-20 transition-all duration-500 ease-out`}
                    style={{
                      left: `${pos.leftPct}%`,
                      top: `${pos.topPct}%`,
                      transform: 'translate(-50%, -50%)',
                      position: 'absolute',
                    }}
                  >
                    {renderSeatCard(player, 'table')}
                  </div>
                );
              })}
            </div>
        </Card>
      </div>

      {/* 胜利弹窗 */}
      {winnerInfo && winnerInfo.show && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none bg-black/50 backdrop-blur-sm">
          <div className="bg-black/90 text-white p-5 rounded-2xl border border-white/15 shadow-2xl animate-in zoom-in duration-300 pointer-events-auto max-w-2xl w-full mx-4 max-h-[82vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{winnerInfo.endType === 'game' ? '👑' : '🏁'}</span>
                  <h2 className="text-xl font-black text-yellow-300 truncate">
                    {winnerInfo.endType === 'game'
                      ? '整局结束'
                      : winnerInfo.winners.length > 1
                        ? '本局平分'
                        : '本局获胜'}
                  </h2>
                  <Badge variant="secondary" className="bg-white/10 text-white border border-white/10">
                    {winnerInfo.endType === 'game' ? '整局结算' : winnerInfo.reasonLabel}
                  </Badge>
                  {winnerInfo.endType === 'game' && (
                    <Badge variant="secondary" className="bg-white/5 text-white/80 border border-white/10">
                      {winnerInfo.reasonLabel}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 text-xs text-white/70">
                  {winnerInfo.endType === 'game'
                    ? `冠军：${winnerInfo.champion?.name ?? winnerInfo.winners[0]?.name ?? '未知'} · 下一局将重置筹码`
                    : `${winnerInfo.baselineLabel}${nextRoundCountdown > 0 ? ` · ${nextRoundCountdown}s 后自动开局` : ''}`}
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2 bg-yellow-500/15 px-3 py-2 rounded-xl border border-yellow-500/25">
                <Coins className="w-4 h-4 text-yellow-300" />
                <span className="font-mono font-extrabold text-yellow-200 text-lg">+{winnerInfo.amount}</span>
              </div>
            </div>

            {winnerInfo.showBoard && (
              <div className="mt-4">
                <div className="text-xs font-bold text-white/70 mb-2">公共牌</div>
                <div className="flex flex-wrap items-center gap-2">
                  {winnerInfo.boardCards.map((card, idx) => (
                    <div key={idx} className="scale-[0.85] origin-left">{renderCard(card)}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-white/70">输赢明细</div>
                {winnerInfo.pots && winnerInfo.pots.length > 1 && (
                  <div className="text-[11px] text-white/60">
                    {winnerInfo.pots.map((p, i) => `P${i + 1}:${p.amount}`).join(' · ')}
                  </div>
                )}
              </div>

              <div className="mt-2 space-y-2">
                {winnerInfo.rows.map(({ player, delta, isWinner, handDescription, bestCards }) => {
                  const deltaText = delta >= 0 ? `+${delta}` : `${delta}`;
                  const showHole = winnerInfo.showHands && (!player.isFolded || player.id === currentPlayerId);
                  const holeCards = showHole ? player.cards : [];
                  const bestText =
                    isWinner && bestCards && bestCards.length > 0
                      ? bestCards.map(formatCardText).join(' ')
                      : '';

                  return (
                    <div
                      key={player.id}
                      className={`rounded-xl border px-3 py-2 ${isWinner ? 'bg-yellow-500/10 border-yellow-500/25' : 'bg-white/5 border-white/10'}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-center gap-2">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${player.isBot ? 'bg-purple-900' : 'bg-blue-900'} border border-white/15`}>
                            {player.isBot ? <Bot className="w-4 h-4 text-purple-200" /> : <User className="w-4 h-4 text-blue-200" />}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-bold truncate max-w-[140px]">{player.name}</span>
                              {player.id === currentPlayerId && (
                                <Badge variant="default" className="h-5 px-2 text-[10px] bg-blue-600">你</Badge>
                              )}
                              {isWinner && (
                                <Badge variant="secondary" className="h-5 px-2 text-[10px] bg-yellow-500 text-black">胜</Badge>
                              )}
                              {player.isFolded && (
                                <Badge variant="secondary" className="h-5 px-2 text-[10px] bg-white/10 text-white/80">弃</Badge>
                              )}
                              {!!handDescription && (
                                <Badge variant="secondary" className="h-5 px-2 text-[10px] bg-emerald-500/15 text-emerald-200 border border-emerald-500/20">
                                  {handDescription}
                                </Badge>
                              )}
                            </div>
                            {bestText && (
                              <div className="text-[11px] text-white/60 mt-0.5 truncate">
                                成牌 {bestText}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className={`shrink-0 font-mono font-extrabold ${delta >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                          {deltaText}
                        </div>
                      </div>

                      {holeCards.length > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          {holeCards.map((card, idx) => (
                            <div key={idx} className="scale-[0.7] origin-left">{renderCard(card, player.id !== currentPlayerId && player.isFolded)}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              {winnerInfo.endType === 'game' && (
                <Button
                  onClick={() => router.push('/setup')}
                  size="lg"
                  disabled={nextRoundInFlight}
                  className="bg-white/10 hover:bg-white/15 text-white font-bold border border-white/10"
                >
                  返回开局设置
                </Button>
              )}
              <Button
                onClick={() => void handleNextRound(winnerInfo.gameId)}
                size="lg"
                disabled={nextRoundInFlight}
                className="flex-1 bg-gradient-to-r from-yellow-600 to-yellow-500 hover:from-yellow-500 hover:to-yellow-400 text-black font-black shadow-lg shadow-yellow-900/40"
              >
                {nextRoundInFlight
                  ? winnerInfo.endType === 'game'
                    ? '重置中...'
                    : '开局中...'
                  : winnerInfo.endType === 'game'
                    ? '开始新一整局'
                    : '开始下一局'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 底部操作控制台 - 悬浮式玻璃拟态 */}
      <div className="fixed bottom-0 left-0 right-0 p-4 pb-6 z-30">
        <div className="max-w-4xl mx-auto">
          {(() => {
            const actionButtonBase =
              "relative transition-[transform,box-shadow,filter,background-color,border-color] duration-150 ease-out hover:-translate-y-0.5 active:translate-y-px active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-0 disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35 disabled:saturate-0 disabled:brightness-75 disabled:shadow-none disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:active:scale-100";
            const adjustButtonBase =
              "transition-[transform,background-color,color] duration-150 ease-out active:translate-y-px active:scale-[0.97] disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35 disabled:saturate-0 disabled:brightness-75";

            return (
              <>
                <div className="flex justify-center mb-3">
                  <div className="bg-black/60 backdrop-blur-md px-4 py-1.5 rounded-full border border-white/10 flex items-center gap-2 shadow-lg">
                    {isMyTurn && (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
                      </span>
                    )}
                    <span className="text-white/90 text-sm font-medium">
                      {gameState.phase === 'showdown'
                        ? `摊牌中，${showdownCountdown > 0 ? `${showdownCountdown}s 后结算...` : '结算中...' }`
                        : gameState.phase === 'completed' && isFoldResultPending
                          ? `对手弃牌，${resultRevealCountdown}s 后展示结果...`
                          : isMyTurn
                            ? '轮到你了，请选择操作'
                            : `等待 ${gameState.players[gameState.currentPlayerIndex]?.name} 思考中...`}
                    </span>
                  </div>
                </div>

                <div className="bg-black/80 backdrop-blur-xl rounded-2xl p-2 border border-white/10 shadow-2xl flex flex-wrap md:flex-nowrap items-center justify-center gap-2 md:gap-4">
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="destructive"
                      size="default"
                      onClick={handleFold}
                      disabled={!isMyTurn}
                      className={`w-20 font-black tracking-wide text-white border border-red-300/30 shadow-[0_10px_30px_rgba(0,0,0,0.35)] hover:shadow-[0_14px_40px_rgba(239,68,68,0.25)] bg-gradient-to-b from-red-500 to-red-700 hover:from-red-400 hover:to-red-600 disabled:hover:from-red-500 disabled:hover:to-red-700 ${actionButtonBase}`}
                    >
                      弃牌
                    </Button>
                    <Button
                      variant="outline"
                      size="default"
                      onClick={handleCheck}
                      disabled={!isMyTurn || !canPerformAction('check')}
                      className={`w-20 font-black text-white border border-slate-200/15 bg-slate-400/10 hover:bg-slate-300/15 hover:border-slate-200/25 disabled:hover:bg-slate-400/10 disabled:hover:border-slate-200/15 shadow-[0_10px_30px_rgba(0,0,0,0.25)] ${actionButtonBase}`}
                    >
                      过牌
                    </Button>
                    <Button
                      variant="secondary"
                      size="default"
                      onClick={handleCall}
                      disabled={!isMyTurn || !canPerformAction('call')}
                      className={`min-w-[110px] font-black text-white border border-emerald-200/25 shadow-[0_14px_40px_rgba(16,185,129,0.20)] hover:shadow-[0_18px_54px_rgba(16,185,129,0.28)] bg-gradient-to-b from-emerald-500 to-emerald-700 hover:from-emerald-400 hover:to-emerald-600 disabled:hover:from-emerald-500 disabled:hover:to-emerald-700 ${actionButtonBase}`}
                    >
                      跟注 {gameState.currentBet > 0 && `(${gameState.currentBet - (gameState.players[gameState.currentPlayerIndex]?.bet || 0)})`}
                    </Button>
                  </div>

                  <div className="hidden md:block w-px h-8 bg-white/10"></div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center bg-black/40 rounded-lg p-1 border border-white/5">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setBetAmount(Math.max(gameState.minRaise || gameState.settings.bigBlind, betAmount - gameState.settings.bigBlind))
                        }
                        className={`h-9 w-9 text-white/60 hover:text-white hover:bg-white/12 rounded-md ${adjustButtonBase}`}
                      >
                        -
                      </Button>
                      <div className="px-2 min-w-[60px] text-center">
                        <span className="text-yellow-400 font-mono font-bold text-lg">{betAmount}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setBetAmount(betAmount + gameState.settings.bigBlind)}
                        className={`h-9 w-9 text-white/60 hover:text-white hover:bg-white/12 rounded-md ${adjustButtonBase}`}
                      >
                        +
                      </Button>
                    </div>

                    <Button
                      variant="default"
                      size="default"
                      onClick={gameState.currentBet === 0 ? handleBet : handleRaise}
                      disabled={!isMyTurn || !canPerformAction(gameState.currentBet === 0 ? 'bet' : 'raise')}
                      className={`text-black font-black px-5 border border-yellow-200/25 shadow-[0_14px_40px_rgba(234,179,8,0.20)] hover:shadow-[0_18px_54px_rgba(234,179,8,0.28)] bg-gradient-to-b from-yellow-400 to-yellow-600 hover:from-yellow-300 hover:to-yellow-500 disabled:hover:from-yellow-400 disabled:hover:to-yellow-600 ${actionButtonBase}`}
                    >
                      {gameState.currentBet === 0 ? '下注' : '加注'}
                    </Button>

                    <Button
                      variant="default"
                      size="default"
                      onClick={handleAllIn}
                      disabled={!isMyTurn || gameState.players[0].chips <= 0}
                      className={`text-white font-black px-5 border border-red-200/25 tracking-wider shadow-[0_14px_40px_rgba(239,68,68,0.22)] hover:shadow-[0_18px_54px_rgba(239,68,68,0.30)] bg-gradient-to-b from-red-500 to-red-800 hover:from-red-400 hover:to-red-700 disabled:hover:from-red-500 disabled:hover:to-red-800 ${actionButtonBase}`}
                    >
                      ALL IN
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {showConsole ? (
        <div className="fixed inset-4 md:right-4 md:top-24 md:bottom-4 md:left-auto md:w-80 z-40">
          <Card className="bg-slate-950/90 border-slate-700 backdrop-blur flex flex-col h-full shadow-2xl">
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between bg-black/40">
              <div className="flex items-center gap-2 text-white">
                <Terminal className="w-4 h-4 text-green-400" />
                <h2 className="font-bold text-sm">游戏日志</h2>
                <span className="text-xs text-slate-500 font-mono">({consoleLogs.length})</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConsoleLogs([])}
                  className="h-7 text-xs text-slate-400 hover:text-white hover:bg-white/10"
                >
                  清空
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowConsole(false)}
                  className="h-7 text-xs text-slate-400 hover:text-white hover:bg-white/10"
                >
                  收起
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
              {consoleLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-2">
                  <Terminal className="w-8 h-8 opacity-20" />
                  <p>暂无日志记录</p>
                </div>
              ) : (
                consoleLogs.map(log => (
                  <div
                    key={log.id}
                    className={`relative pl-3 py-1 border-l-2 ${
                      log.type === 'action'
                        ? 'border-blue-500 text-blue-200 bg-blue-500/5'
                        : log.type === 'phase'
                          ? 'border-green-500 text-green-200 bg-green-500/5'
                          : log.type === 'pot'
                            ? 'border-yellow-500 text-yellow-200 bg-yellow-500/5'
                            : log.type === 'error'
                              ? 'border-red-500 text-red-200 bg-red-500/5'
                              : 'border-slate-600 text-slate-400'
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex justify-between items-center opacity-70 text-[10px]">
                        <span>{log.timestamp}</span>
                        <span className="font-bold">{getLogLabel(log.type)}</span>
                      </div>
                      <div className="leading-relaxed break-words">
                        {log.playerName ? `[${log.playerName}] ` : ''}
                        {log.message}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={consoleEndRef} />
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
