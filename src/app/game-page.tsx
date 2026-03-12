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

interface GameHistoryEvent {
  sequence: number;
  handNumber: number;
  kind: 'hand_start' | 'blind' | 'action' | 'phase_change' | 'hand_end';
  phase: string;
  playerId?: string;
  playerName?: string;
  blindType?: 'small' | 'big';
  action?: string;
  amount?: number;
  pot?: number;
  currentBet?: number;
  playerBet?: number;
  chipsAfter?: number;
  communityCards?: string[];
  note?: string;
}

interface GameState {
  gameId: string;
  handNumber?: number;
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
  actionHistory?: GameHistoryEvent[];
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
  const mobileConsoleEndRef = useRef<HTMLDivElement>(null);
  const handStartChipsRef = useRef<Record<string, number> | null>(null);
  const handStartGameIdRef = useRef<string | null>(null);

  function scrollConsoleToEnd() {
    if (!showConsole) return;
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    mobileConsoleEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

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
  const [wsConnected, setWsConnected] = useState(false);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const debugLog = (...args: unknown[]) => {
    if (!DEBUG) return;
    console.debug('[ui]', ...args);
  };

  useEffect(() => {
    scrollConsoleToEnd();
  }, [consoleLogs.length, showConsole, winnerInfo?.show, nextRoundInFlight]);

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

  // WebSocket 连接函数
  const connectWebSocket = () => {
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

    debugLog('ws connecting', { wsUrl, gameId: gameState.gameId });
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let active = true;

    ws.onopen = () => {
      if (!active) return;
      debugLog('ws open', { wsUrl, gameId: gameState.gameId, playerId: currentPlayerId });
      setWsConnected(true);
      addConsoleLog('info', `WebSocket 已连接: ${wsUrl}`);
      ws.send(JSON.stringify({ type: 'join_game', data: { gameId: gameState.gameId, playerId: currentPlayerId } }));
      
      // 清除重连定时器
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    ws.onclose = (event) => {
      if (!active) return;
      debugLog('ws close', { code: event.code, reason: event.reason });
      setWsConnected(false);
      addConsoleLog('error', `WebSocket 已断开 (${event.code})，3秒后自动重连...`);
      
      // 尝试重连
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (active && gameState?.gameId) {
          addConsoleLog('info', '正在尝试重连...');
          connectWebSocket();
        }
      }, 5000);
    };

    ws.onerror = (event) => {
      if (!active) return;
      debugLog('ws error', event);
      setWsConnected(false);
      addConsoleLog('error', 'WebSocket 发生错误');
    };

    ws.onmessage = (event) => {
      try {
        // 处理 ping 消息
        if (event.data === 'ping') {
          debugLog('ws ping received, sending pong');
          ws.send('pong');
          return;
        }

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
    };
  };

  useEffect(() => {
    if (!gameState?.gameId) return;

    // 初始连接
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
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
  const renderCard = (card: Card, hidden: boolean = false, size: 'sm' | 'md' = 'md') => {
    const sizeClass =
      size === 'sm'
        ? 'w-10 h-14 rounded-md border'
        : 'w-14 h-20 rounded-lg border-2';
    const rankClass = size === 'sm' ? 'text-sm' : 'text-xl';
    const suitClass = size === 'sm' ? 'text-lg' : 'text-2xl';

    if (hidden) {
      return (
        <div className={`${sizeClass} bg-gradient-to-br from-blue-600 to-blue-800 shadow-md flex items-center justify-center border-blue-400`}>
          <div className={`${size === 'sm' ? 'w-7 h-10 rounded-sm' : 'w-10 h-16 rounded'} bg-blue-700`}></div>
        </div>
      );
    }

    const isRed = card.suit === '♥' || card.suit === '♦';

    return (
      <div className={`${sizeClass} bg-white shadow-md flex flex-col items-center justify-center border-gray-200`}>
        <div className={`${rankClass} font-bold ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {card.rank}
        </div>
        <div className={`${suitClass} ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
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
              <p className="text-gray-300 mb-6">Texas Hold&apos;em</p>
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
    const layout =
      seatCount >= 8
        ? { rx: 42, ry: 28, bottom: 88, top: 12 }
        : seatCount >= 6
          ? { rx: 40, ry: 26, bottom: 86, top: 14 }
          : { rx: 38, ry: 24, bottom: 84, top: 16 };

    if (seatCount === 2) {
      return [
        { leftPct: 50, topPct: 84 },
        { leftPct: 50, topPct: 16 },
      ];
    }

    return Array.from({ length: seatCount }, (_, seatIndex) => {
      if (seatIndex === 0) {
        return { leftPct: 50, topPct: layout.bottom };
      }

      const topSeatIndex = Math.floor(seatCount / 2);
      if (seatIndex === topSeatIndex) {
        return { leftPct: 50, topPct: layout.top };
      }

      const angleStep = 360 / seatCount;
      const angleDeg = 90 + angleStep * seatIndex;
      const angleRad = (Math.PI / 180) * angleDeg;

      let leftPct = 50 + Math.cos(angleRad) * layout.rx;
      let topPct = 50 + Math.sin(angleRad) * layout.ry;

      leftPct = Math.max(10, Math.min(90, leftPct));
      topPct = Math.max(layout.top, Math.min(layout.bottom, topPct));

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
  const seatCardClass = '';
  const currentTurnPlayer = gameState.players[gameState.currentPlayerIndex];
  const myPlayer = gameState.players.find(player => player.id === currentPlayerId) ?? seatedPlayers[0];
  const activePlayers = gameState.players.filter(player => !player.isFolded);
  const botCount = gameState.players.filter(player => player.isBot).length;
  const humanCount = gameState.players.length - botCount;
  const pendingCallAmount = myPlayer ? Math.max(0, gameState.currentBet - myPlayer.bet) : 0;
  const recentHandHistory = (gameState.actionHistory ?? []).slice(-8);
  const handNumber = gameState.handNumber ?? 1;
  const shellCardClass = 'border-white/10 bg-slate-950/55 text-white backdrop-blur-xl shadow-[0_24px_80px_rgba(0,0,0,0.35)]';

  function formatHistoryMessage(event: GameHistoryEvent): string {
    switch (event.kind) {
      case 'hand_start':
        return event.note ?? `第 ${event.handNumber} 手开始`;
      case 'blind':
        return `${event.playerName ?? '玩家'} 支付${event.blindType === 'small' ? '小盲' : '大盲'}${event.amount ? ` ${event.amount}` : ''}`;
      case 'phase_change':
        return event.note ?? `进入 ${event.phase} 阶段`;
      case 'hand_end':
        return event.note ?? '本手结束';
      case 'action':
        return `${event.playerName ?? '玩家'} ${event.action ?? '行动'}${event.amount ? ` ${event.amount}` : ''}`;
      default:
        return event.note ?? '牌局更新';
    }
  }

  function getHistoryAccent(event: GameHistoryEvent): string {
    switch (event.kind) {
      case 'hand_start':
        return 'border-cyan-400/40 bg-cyan-400/10 text-cyan-100';
      case 'blind':
        return 'border-amber-400/40 bg-amber-400/10 text-amber-100';
      case 'phase_change':
        return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100';
      case 'hand_end':
        return 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100';
      case 'action':
      default:
        return 'border-slate-200/10 bg-white/5 text-slate-100';
    }
  }

  function renderSeatCard(player: Player, variant: 'table' | 'compact') {
    const isMe = player.id === currentPlayerId;
    const hiddenCards = !isMe && (!revealOthers || player.isFolded);
    const cardSize = 'sm' as const;
    const isCompact = variant === 'compact';
    
    // 基础状态颜色
    const statusColor = player.isCurrent 
      ? 'border-emerald-400/60 bg-emerald-500/10 shadow-[0_0_15px_rgba(52,211,153,0.2)]' 
      : player.isFolded 
        ? 'border-white/5 bg-white/5 opacity-50 grayscale' 
        : 'border-white/10 bg-slate-900/60';

    const avatarClass = player.isBot ? 'bg-fuchsia-900/50 text-fuchsia-200' : 'bg-sky-900/50 text-sky-200';

    if (!isCompact) {
      return (
        <div className={`flex flex-col items-center gap-2 transition-all duration-300 ${player.isCurrent ? 'scale-105' : ''}`}>
          {/* 上方：下注区域 */}
          <div className="h-6 flex items-end justify-center">
             {player.bet > 0 && (
              <div className="flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400 px-2 py-0.5 text-[10px] font-black text-slate-950 shadow-lg animate-in fade-in zoom-in">
                <Coins className="h-2.5 w-2.5" />
                <span>{player.bet}</span>
              </div>
            )}
             {player.isAllIn && (
              <div className={`rounded-full bg-red-600 px-2 py-0.5 text-[9px] font-black tracking-wider text-white shadow-lg animate-pulse ${player.bet > 0 ? 'ml-1' : ''}`}>
                ALL IN
              </div>
            )}
          </div>

          {/* 下方：信息+手牌 左右布局 */}
          <div className={`flex items-center gap-3 rounded-full border py-1.5 pl-2 pr-4 backdrop-blur-md transition-colors ${statusColor}`}>
            {/* 左侧：玩家信息 */}
            <div className="flex items-center gap-2">
               {/* 头像 */}
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 ${avatarClass}`}>
                {player.isBot ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
              </div>

              {/* 名字和筹码 */}
              <div className="flex flex-col leading-tight min-w-[50px]">
                <div className="flex items-center gap-1">
                  <span className="max-w-[70px] truncate text-[11px] font-bold text-white">{player.name}</span>
                  {player.isDealer && <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-[9px] font-black text-black">D</span>}
                </div>
                <div className="flex items-center gap-1 text-[10px] font-bold text-amber-300/90">
                  <Coins className="h-2.5 w-2.5" />
                  <span className="font-mono">{player.chips}</span>
                </div>
              </div>
            </div>

            {/* 右侧：手牌 */}
            <div className="flex -space-x-3 drop-shadow-lg pl-2 border-l border-white/10">
              {player.cards.length > 0 ? (
                player.cards.map((card, index) => (
                  <div 
                    key={index} 
                    className={`transition-transform duration-300 ${
                      index === 0 ? '-rotate-3 hover:-translate-x-1' : 'rotate-3 hover:translate-x-1'
                    } hover:-translate-y-2 origin-bottom`}
                  >
                    {renderCard(card, hiddenCards, cardSize)}
                  </div>
                ))
              ) : (
                <div className="flex gap-1">
                  <div className="h-10 w-7 rounded border border-white/5 bg-white/5" />
                  <div className="h-10 w-7 rounded border border-white/5 bg-white/5" />
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // 移动端/紧凑视图保持原有风格但优化尺寸
    return (
      <Card
        className={`relative overflow-visible border shadow-xl backdrop-blur-sm transition-all ${
          isMe ? 'bg-slate-950/90 border-amber-400/40' : statusColor
        } ${player.isCurrent ? 'ring-2 ring-emerald-300/60' : ''}`}
      >
        <div className="flex items-center justify-between gap-2 p-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/15 ${avatarClass}`}>
              {player.isBot ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1">
                <span className="truncate text-xs font-bold text-white">{player.name}</span>
                {isMe && <Badge className="h-3 px-1 text-[8px] bg-sky-500">你</Badge>}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-amber-200">
                <Coins className="h-2.5 w-2.5" />
                <span className="font-mono">{player.chips}</span>
              </div>
            </div>
          </div>
          <div className="flex -space-x-3">
            {player.cards.map((card, index) => (
              <div key={index} className="scale-75 origin-right">
                {renderCard(card, hiddenCards, cardSize)}
              </div>
            ))}
          </div>
        </div>
        {player.bet > 0 && (
          <div className="absolute -right-1 -top-1 flex items-center gap-0.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-black text-slate-950 shadow-md">
            {player.bet}
          </div>
        )}
      </Card>
    );
  }

  const actionButtonBase =
    'relative transition-[transform,box-shadow,filter,background-color,border-color] duration-150 ease-out hover:-translate-y-0.5 active:translate-y-px active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-0 disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35 disabled:saturate-0 disabled:brightness-75 disabled:shadow-none disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:active:scale-100';
  const adjustButtonBase =
    'transition-[transform,background-color,color] duration-150 ease-out active:translate-y-px active:scale-[0.97] disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35 disabled:saturate-0 disabled:brightness-75';

  return (
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(22,163,74,0.18),_transparent_28%),linear-gradient(180deg,_#0f172a_0%,_#10241d_48%,_#07120d_100%)] text-white">
      <div className="mx-auto flex h-full w-full flex-col gap-1 px-2 py-2 md:gap-2 xl:px-4">
        <div className="shrink-0 rounded-xl border border-white/10 bg-black/25 px-3 py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <div className="flex flex-col gap-1.5 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-2 md:gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/setup')}
                className="border-white/15 bg-white/5 text-white hover:bg-white/10"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回
              </Button>
              <div>
                <div className="text-lg font-black tracking-wide md:text-xl">多人德州桌</div>
                <div className="text-xs text-white/60">
                  第 {handNumber} 手 · {seatCount} 人桌 · {humanCount} 真人 / {botCount} 机器人
                </div>
              </div>
              <Badge variant="secondary" className="border border-white/10 bg-white/10 text-white">
                {getPhaseName(gameState.phase)}
              </Badge>
              <Badge
                variant={isMyTurn ? 'default' : 'secondary'}
                className={isMyTurn ? 'bg-amber-400 text-slate-950' : 'border border-white/10 bg-white/10 text-white'}
              >
                {isMyTurn ? '你的回合' : `当前 ${currentTurnPlayer?.name ?? '未知玩家'}`}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {[
                { label: '底池', value: gameState.pot, tone: 'border-amber-400/20 bg-amber-400/10 text-amber-100' },
                { label: '当前注', value: gameState.currentBet, tone: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100' },
                { label: '在局', value: `${activePlayers.length}/${seatCount}`, tone: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-100' },
                { label: '盲注', value: `${gameState.settings.smallBlind}/${gameState.settings.bigBlind}`, tone: 'border-white/10 bg-white/5 text-white' },
              ].map(metric => (
                <div key={metric.label} className={`rounded-2xl border px-3 py-2 ${metric.tone}`}>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/55">{metric.label}</div>
                  <div className="text-sm font-black md:text-base">{metric.value}</div>
                </div>
              ))}

              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConsole(v => !v)}
                className="border-white/15 bg-white/5 text-white hover:bg-white/10"
              >
                <Terminal className="mr-2 h-4 w-4" />
                {showConsole ? '隐藏日志' : '显示日志'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshGame}
                disabled={loading}
                className="border-white/15 bg-white/5 text-white hover:bg-white/10"
              >
                <RotateCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
              <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${wsConnected ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100' : 'border-red-400/40 bg-red-400/10 text-red-100'}`}>
                <span className={`h-2 w-2 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
                {wsConnected ? '实时连接' : '连接中断'}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-red-100 backdrop-blur-md">
            {error}
          </div>
        )}

        <div className="grid flex-1 min-h-0 gap-2 lg:gap-3 lg:grid-cols-[260px_minmax(0,1fr)_280px] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          {/* 左侧区域：实时日志 */}
          <aside className="hidden lg:flex lg:flex-col lg:gap-2 h-full min-h-0">
            {showConsole && (
              <Card className={`${shellCardClass} flex min-h-0 flex-1 flex-col overflow-hidden`}>
                <div className="flex items-center justify-between border-b border-white/10 bg-black/20 px-3 py-2">
                  <div className="flex items-center gap-2 text-white">
                    <Terminal className="h-3.5 w-3.5 text-emerald-300" />
                    <h2 className="text-xs font-bold">实时日志</h2>
                    <span className="font-mono text-[10px] text-white/35">({consoleLogs.length})</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConsoleLogs([])}
                      className="h-7 text-xs text-white/55 hover:bg-white/10 hover:text-white"
                    >
                      清空
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowConsole(false)}
                      className="h-7 text-xs text-white/55 hover:bg-white/10 hover:text-white"
                    >
                      收起
                    </Button>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-4 font-mono text-xs">
                  {consoleLogs.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
                      <Terminal className="h-8 w-8 opacity-20" />
                      <p>暂无日志记录</p>
                    </div>
                  ) : (
                    consoleLogs.map(log => (
                      <div
                        key={log.id}
                        className={`relative border-l-2 pl-3 py-1 ${
                          log.type === 'action'
                            ? 'border-blue-500 bg-blue-500/5 text-blue-200'
                            : log.type === 'phase'
                              ? 'border-green-500 bg-green-500/5 text-green-200'
                              : log.type === 'pot'
                                ? 'border-yellow-500 bg-yellow-500/5 text-yellow-200'
                                : log.type === 'error'
                                  ? 'border-red-500 bg-red-500/5 text-red-200'
                                  : 'border-slate-600 text-slate-400'
                        }`}
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center justify-between text-[10px] opacity-70">
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
            )}
          </aside>

          {/* 中间区域：游戏桌 + Action Console */}
          <div className="flex min-h-0 flex-col gap-2 h-full">
            <div className="flex-1 flex flex-col gap-2 relative min-h-0 justify-center">
              {/* 游戏桌区域 */}
              <Card className={`${shellCardClass} flex-1 overflow-hidden relative max-h-[600px] xl:max-h-[720px] m-auto w-full`}>
                <div className="absolute inset-0 p-2 sm:p-3">
                  <div className="relative h-full w-full overflow-hidden rounded-[24px] border border-white/10 bg-[#1c4332]">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(99,179,132,0.35),_rgba(14,44,33,0.96)_72%)]" />
                    <div className="absolute inset-[5%] rounded-[999px] border-[18px] border-[#60472f] bg-black/10 shadow-[inset_0_0_80px_rgba(0,0,0,0.22)]" />
                    <div className="absolute inset-[9%] rounded-[999px] border border-white/10 bg-[radial-gradient(circle_at_center,_rgba(34,197,94,0.18),_rgba(0,0,0,0)_70%)]" />
                    <div className="absolute inset-x-10 top-4 flex justify-between text-[10px] uppercase tracking-[0.35em] text-white/40">
                      <span>Dealer Orbit</span>
                      <span>Side Pressure</span>
                    </div>

                    {isShowdownPending && (
                      <div className="absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-5 py-2 shadow-lg backdrop-blur-md">
                        <span className="font-bold text-white">
                          摊牌中{showdownCountdown > 0 ? `，${showdownCountdown}s 后结算` : '，结算中...'}
                        </span>
                      </div>
                    )}
                    {isFoldResultPending && (
                      <div className="absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-5 py-2 shadow-lg backdrop-blur-md">
                        <span className="font-bold text-white">
                          对手弃牌，{resultRevealCountdown}s 后展示结果
                        </span>
                      </div>
                    )}

                    <div className="relative z-10 h-full md:hidden overflow-y-auto p-4">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {seatedPlayers.map(player => (
                          <div key={player.id}>{renderSeatCard(player, 'compact')}</div>
                        ))}
                      </div>

                      <div className="mt-5 rounded-[28px] border border-white/10 bg-black/25 p-4">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-white/45">
                          <span>Board</span>
                          <span>Pot {gameState.pot}</span>
                        </div>
                        <div className="mt-4 flex justify-center gap-2">
                          {gameState.communityCards.length === 0
                            ? [...Array(5)].map((_, index) => (
                                <div
                                  key={index}
                                  className="flex h-14 w-10 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/15"
                                >
                                  ?
                                </div>
                              ))
                            : gameState.communityCards.map((card, index) => (
                                <div key={index}>{renderCard(card, false, 'sm')}</div>
                              ))}
                        </div>
                        <div className="mt-4 flex items-center justify-center gap-2 rounded-full border border-amber-400/20 bg-amber-300/10 px-4 py-2 text-amber-100">
                          <Coins className="h-4 w-4" />
                          <span className="font-mono text-sm font-black">{gameState.pot}</span>
                        </div>
                      </div>
                    </div>

                    <div className="absolute inset-0 z-10 hidden md:block">
                      <div className="absolute inset-[4%_5%_6%]">
                        <div className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-5">
                          <div className="rounded-[28px] border border-white/10 bg-black/25 px-5 py-3 backdrop-blur-md shadow-xl">
                            <div className="flex items-center justify-center gap-3">
                              {gameState.communityCards.length === 0
                                ? [...Array(5)].map((_, index) => (
                                    <div
                                      key={index}
                                      className="flex h-20 w-14 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/15"
                                    >
                                      ?
                                    </div>
                                  ))
                                : gameState.communityCards.map((card, index) => (
                                    <div key={index} className="animate-in fade-in zoom-in duration-500">
                                      {renderCard(card)}
                                    </div>
                                  ))}
                            </div>
                          </div>

                          <div className="rounded-full border border-amber-400/20 bg-black/35 px-8 py-3 shadow-lg backdrop-blur-sm">
                            <div className="flex items-center gap-3">
                              <Coins className="h-6 w-6 text-amber-300" />
                              <div>
                                <div className="text-[10px] uppercase tracking-[0.25em] text-white/45">Main Pot</div>
                                <div className="font-mono text-2xl font-black tracking-wider text-amber-100">{gameState.pot}</div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {seatedPlayers.map((player, seatIndex) => {
                          const pos = seatPositions[seatIndex];
                          return (
                            <div
                              key={player.id}
                              className={`${seatCardClass} absolute z-20 transition-all duration-500 ease-out`}
                              style={{
                                left: `${pos.leftPct}%`,
                                top: `${pos.topPct}%`,
                                transform: 'translate(-50%, -50%)',
                              }}
                            >
                              {renderSeatCard(player, 'table')}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Action Console (Moved Inside Table) */}
                    <div className="absolute bottom-0 left-0 right-0 z-30 flex flex-col items-center justify-end p-4 pointer-events-none">
                      <div className="pointer-events-auto flex flex-col gap-4 w-full max-w-3xl items-center">
                        <div className="flex flex-wrap items-center justify-between gap-3 lg:hidden bg-black/60 backdrop-blur-md rounded-xl p-3 border border-white/10 w-full">
                          <div>
                            <div className="text-xs uppercase tracking-[0.25em] text-white/45">Action Console</div>
                            <div className="mt-1 text-base font-bold text-white">
                              {gameState.phase === 'showdown'
                                ? `摊牌中${showdownCountdown > 0 ? ` · ${showdownCountdown}s` : ''}`
                                : gameState.phase === 'completed' && isFoldResultPending
                                  ? `结果即将揭示 · ${resultRevealCountdown}s`
                                  : isMyTurn
                                    ? '轮到你了，请选择操作'
                                    : `等待 ${currentTurnPlayer?.name ?? '未知玩家'} 思考中...`}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-2 text-xs text-white/60">
                            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">当前阶段 {getPhaseName(gameState.phase)}</div>
                            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">待跟注 {pendingCallAmount}</div>
                            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">最小加注 {gameState.minRaise || gameState.settings.bigBlind}</div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-center gap-2 bg-black/40 backdrop-blur-sm p-2 rounded-2xl border border-white/5 shadow-2xl">
                          <Button
                            variant="destructive"
                            size="default"
                            onClick={handleFold}
                            disabled={!isMyTurn}
                            className={`w-20 border border-red-300/30 bg-gradient-to-b from-red-500 to-red-700 font-black tracking-wide text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)] hover:from-red-400 hover:to-red-600 ${actionButtonBase}`}
                          >
                            弃牌
                          </Button>
                          <Button
                            variant="outline"
                            size="default"
                            onClick={handleCheck}
                            disabled={!isMyTurn || !canPerformAction('check')}
                            className={`w-20 border border-slate-200/15 bg-slate-400/10 font-black text-white hover:bg-slate-300/15 ${actionButtonBase}`}
                          >
                            过牌
                          </Button>
                          <Button
                            variant="secondary"
                            size="default"
                            onClick={handleCall}
                            disabled={!isMyTurn || !canPerformAction('call')}
                            className={`min-w-[110px] border border-emerald-200/25 bg-gradient-to-b from-emerald-500 to-emerald-700 font-black text-white hover:from-emerald-400 hover:to-emerald-600 ${actionButtonBase}`}
                          >
                            跟注 {gameState.currentBet > 0 && `(${pendingCallAmount})`}
                          </Button>

                          <div className="mx-1 hidden h-8 w-px bg-white/10 md:block" />

                          <div className="flex items-center rounded-xl border border-white/5 bg-black/35 p-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                setBetAmount(Math.max(gameState.minRaise || gameState.settings.bigBlind, betAmount - gameState.settings.bigBlind))
                              }
                              className={`h-9 w-9 rounded-md text-white/60 hover:bg-white/12 hover:text-white ${adjustButtonBase}`}
                            >
                              -
                            </Button>
                            <div className="min-w-[72px] px-2 text-center">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-white/35">筹码量</div>
                              <span className="font-mono text-lg font-black text-amber-300">{betAmount}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setBetAmount(betAmount + gameState.settings.bigBlind)}
                              className={`h-9 w-9 rounded-md text-white/60 hover:bg-white/12 hover:text-white ${adjustButtonBase}`}
                            >
                              +
                            </Button>
                          </div>

                          <Button
                            variant="default"
                            size="default"
                            onClick={gameState.currentBet === 0 ? handleBet : handleRaise}
                            disabled={!isMyTurn || !canPerformAction(gameState.currentBet === 0 ? 'bet' : 'raise')}
                            className={`border border-yellow-200/25 bg-gradient-to-b from-yellow-400 to-yellow-600 px-5 font-black text-slate-950 hover:from-yellow-300 hover:to-yellow-500 ${actionButtonBase}`}
                          >
                            {gameState.currentBet === 0 ? '下注' : '加注'}
                          </Button>

                          <Button
                            variant="default"
                            size="default"
                            onClick={handleAllIn}
                            disabled={!isMyTurn || (myPlayer?.chips ?? 0) <= 0}
                            className={`border border-red-200/25 bg-gradient-to-b from-red-500 to-red-800 px-5 font-black tracking-wider text-white hover:from-red-400 hover:to-red-700 ${actionButtonBase}`}
                          >
                            ALL IN
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>


            </div>
          </div>

          {/* 右侧区域：Table Pulse + Hand Story */}
          <aside className="hidden lg:flex lg:flex-col lg:gap-2 h-full min-h-0">
            <Card className={`${shellCardClass} p-3 shrink-0`}>
              <div className="text-[10px] uppercase tracking-[0.25em] text-white/45">Table Pulse</div>
              <div className="mt-1 text-base font-black">{currentTurnPlayer?.name ?? '未知玩家'} 正在行动</div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  { label: '仍在局', value: `${activePlayers.length}` },
                  { label: '总玩家', value: `${seatCount}` },
                  { label: '机器人', value: `${botCount}` },
                  { label: '待跟注', value: `${pendingCallAmount}` },
                ].map(item => (
                  <div key={item.label} className="rounded-xl border border-white/10 bg-white/5 px-2 py-2">
                    <div className="text-[9px] uppercase tracking-[0.18em] text-white/35">{item.label}</div>
                    <div className="mt-0.5 text-sm font-black text-white">{item.value}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className={`${shellCardClass} flex min-h-0 flex-1 flex-col p-3`}>
              <div className="flex flex-col gap-3 border-b border-white/10 pb-3 mb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-white/45">Hand Story</div>
                    <div className="mt-1 text-base font-black">本手脉络</div>
                  </div>
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white text-[10px] h-5 px-2">
                    {recentHandHistory.length} 条
                  </Badge>
                </div>

                <div>
                  <div className="text-sm font-bold text-white mb-1.5">
                    {gameState.phase === 'showdown'
                      ? `摊牌中${showdownCountdown > 0 ? ` · ${showdownCountdown}s` : ''}`
                      : gameState.phase === 'completed' && isFoldResultPending
                        ? `结果即将揭示 · ${resultRevealCountdown}s`
                        : isMyTurn
                          ? '轮到你了，请选择操作'
                          : `等待 ${currentTurnPlayer?.name ?? '未知玩家'} 思考中...`}
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[10px] text-white/60">
                    <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1">当前阶段 {getPhaseName(gameState.phase)}</div>
                    <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1">待跟注 {pendingCallAmount}</div>
                    <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1">最小加注 {gameState.minRaise || gameState.settings.bigBlind}</div>
                  </div>
                </div>
              </div>
              <div className="mt-2 flex-1 space-y-2 overflow-y-auto pr-1">
                {recentHandHistory.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 px-3 py-4 text-sm text-white/45">
                    暂无本手历史，等待第一步行动。
                  </div>
                ) : (
                  recentHandHistory.map(event => (
                    <div key={`${event.sequence}-${event.kind}`} className={`rounded-2xl border px-3 py-2 ${getHistoryAccent(event)}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-black tracking-[0.18em]">#{event.sequence}</span>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">{event.phase}</span>
                      </div>
                      <div className="mt-1 text-sm">{formatHistoryMessage(event)}</div>
                      {!!event.communityCards?.length && (
                        <div className="mt-1 text-[11px] text-white/55">
                          公共牌: {event.communityCards.join(' ')}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </Card>
          </aside>
        </div>

        {winnerInfo && winnerInfo.show && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="pointer-events-auto mx-4 max-h-[82vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/15 bg-black/90 p-5 text-white shadow-2xl animate-in zoom-in duration-300">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{winnerInfo.endType === 'game' ? '👑' : '🏁'}</span>
                    <h2 className="truncate text-xl font-black text-yellow-300">
                      {winnerInfo.endType === 'game'
                        ? '整局结束'
                        : winnerInfo.winners.length > 1
                          ? '本局平分'
                          : '本局获胜'}
                    </h2>
                    <Badge variant="secondary" className="border border-white/10 bg-white/10 text-white">
                      {winnerInfo.endType === 'game' ? '整局结算' : winnerInfo.reasonLabel}
                    </Badge>
                    {winnerInfo.endType === 'game' && (
                      <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/80">
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

                <div className="flex shrink-0 items-center gap-2 rounded-xl border border-yellow-500/25 bg-yellow-500/15 px-3 py-2">
                  <Coins className="h-4 w-4 text-yellow-300" />
                  <span className="font-mono text-lg font-extrabold text-yellow-200">+{winnerInfo.amount}</span>
                </div>
              </div>

              {winnerInfo.showBoard && (
                <div className="mt-4">
                  <div className="mb-2 text-xs font-bold text-white/70">公共牌</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {winnerInfo.boardCards.map((card, idx) => (
                      <div key={idx}>{renderCard(card, false, 'sm')}</div>
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
                        className={`rounded-xl border px-3 py-2 ${isWinner ? 'border-yellow-500/25 bg-yellow-500/10' : 'border-white/10 bg-white/5'}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/15 ${player.isBot ? 'bg-purple-900' : 'bg-blue-900'}`}>
                              {player.isBot ? <Bot className="h-4 w-4 text-purple-200" /> : <User className="h-4 w-4 text-blue-200" />}
                            </div>
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="max-w-[140px] truncate font-bold">{player.name}</span>
                                {player.id === currentPlayerId && (
                                  <Badge variant="default" className="h-5 bg-blue-600 px-2 text-[10px]">你</Badge>
                                )}
                                {isWinner && (
                                  <Badge variant="secondary" className="h-5 bg-yellow-500 px-2 text-[10px] text-black">胜</Badge>
                                )}
                                {player.isFolded && (
                                  <Badge variant="secondary" className="h-5 bg-white/10 px-2 text-[10px] text-white/80">弃</Badge>
                                )}
                                {!!handDescription && (
                                  <Badge variant="secondary" className="h-5 border border-emerald-500/20 bg-emerald-500/15 px-2 text-[10px] text-emerald-200">
                                    {handDescription}
                                  </Badge>
                                )}
                              </div>
                              {bestText && (
                                <div className="mt-0.5 truncate text-[11px] text-white/60">成牌 {bestText}</div>
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
                              <div key={idx}>{renderCard(card, player.id !== currentPlayerId && player.isFolded, 'sm')}</div>
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
                    className="border border-white/10 bg-white/10 font-bold text-white hover:bg-white/15"
                  >
                    返回开局设置
                  </Button>
                )}
                <Button
                  onClick={() => void handleNextRound(winnerInfo.gameId)}
                  size="lg"
                  disabled={nextRoundInFlight}
                  className="flex-1 bg-gradient-to-r from-yellow-600 to-yellow-500 font-black text-black shadow-lg shadow-yellow-900/40 hover:from-yellow-500 hover:to-yellow-400"
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

        {showConsole && (
          <div className="fixed inset-3 z-40 xl:hidden">
            <Card className="flex h-full flex-col overflow-hidden border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/10 bg-black/20 px-4 py-3">
                <div className="flex items-center gap-2 text-white">
                  <Terminal className="h-4 w-4 text-emerald-300" />
                  <h2 className="text-sm font-bold">游戏日志</h2>
                  <span className="font-mono text-xs text-white/35">({consoleLogs.length})</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConsoleLogs([])}
                    className="h-7 text-xs text-white/55 hover:bg-white/10 hover:text-white"
                  >
                    清空
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowConsole(false)}
                    className="h-7 text-xs text-white/55 hover:bg-white/10 hover:text-white"
                  >
                    关闭
                  </Button>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4 font-mono text-xs">
                {consoleLogs.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
                    <Terminal className="h-8 w-8 opacity-20" />
                    <p>暂无日志记录</p>
                  </div>
                ) : (
                  consoleLogs.map(log => (
                    <div
                      key={log.id}
                      className={`relative border-l-2 pl-3 py-1 ${
                        log.type === 'action'
                          ? 'border-blue-500 bg-blue-500/5 text-blue-200'
                          : log.type === 'phase'
                            ? 'border-green-500 bg-green-500/5 text-green-200'
                            : log.type === 'pot'
                              ? 'border-yellow-500 bg-yellow-500/5 text-yellow-200'
                              : log.type === 'error'
                                ? 'border-red-500 bg-red-500/5 text-red-200'
                                : 'border-slate-600 text-slate-400'
                      }`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between text-[10px] opacity-70">
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
                <div ref={mobileConsoleEndRef} />
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
