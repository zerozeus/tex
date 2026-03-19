'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { User, Play, ArrowLeft, Bot, Check, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { gameApiClient, type BotTemplate } from '@/lib/api-client';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface PlayerConfig {
  id: number;
  name: string;
  isBot: boolean;
  botToken?: string;
  botId?: string;
  apiUrl?: string;
}

type InviteLink = {
  playerId: string;
  playerName: string;
  token: string;
  url: string;
  shareUrl: string;
};

const DEFAULT_BOT_ID = '7615209749759426602';
const DEFAULT_BOT_API_URL = 'https://rz2qynsv9r.coze.site/stream_run';

function getHostFromUrl(url?: string): string {
  if (!url) return '-';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function matchBotTemplate(player: PlayerConfig, bot: BotTemplate): boolean {
  const byToken = Boolean(player.botToken) && bot.token === player.botToken;
  const byConfig = Boolean(player.botId && player.apiUrl) && bot.botId === player.botId && bot.url === player.apiUrl;
  return byToken || byConfig;
}

function collectUsedNames(players: PlayerConfig[], excludePlayerId?: number): Set<string> {
  const usedNames = new Set<string>();

  players.forEach((player) => {
    if (excludePlayerId !== undefined && player.id === excludePlayerId) return;
    const trimmedName = player.name.trim();
    if (trimmedName) {
      usedNames.add(trimmedName);
    }
  });

  return usedNames;
}

function getUniquePlayerName(baseName: string, usedNames: Set<string>): string {
  const normalizedBaseName = baseName.trim() || '机器人';
  if (!usedNames.has(normalizedBaseName)) {
    usedNames.add(normalizedBaseName);
    return normalizedBaseName;
  }

  let suffix = 2;
  let candidate = `${normalizedBaseName} ${suffix}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBaseName} ${suffix}`;
  }

  usedNames.add(candidate);
  return candidate;
}

function applyDefaultBots(players: PlayerConfig[], botTemplates: BotTemplate[]): PlayerConfig[] {
  if (!botTemplates.length) return players;
  let botIndex = 0;
  const usedNames = new Set<string>();

  return players.map((player) => {
    const trimmedName = player.name.trim();

    if (!player.isBot) {
      if (trimmedName) {
        usedNames.add(trimmedName);
      }
      return player;
    }

    const template = botTemplates[botIndex % botTemplates.length];
    botIndex += 1;

    if (player.botToken?.trim()) {
      if (trimmedName) {
        usedNames.add(trimmedName);
      }
      return player;
    }

    const shouldUseTemplateName = !trimmedName || trimmedName.startsWith('机器人');

    if (!shouldUseTemplateName) {
      usedNames.add(trimmedName);
      return {
        ...player,
        botToken: template.token ?? '',
        botId: template.botId,
        apiUrl: template.url,
      };
    }

    return {
      ...player,
      name: getUniquePlayerName(template.name, usedNames),
      botToken: template.token ?? '',
      botId: template.botId,
      apiUrl: template.url,
    };
  });
}

export default function GameSetup() {
  const router = useRouter();
  const [playerCount, setPlayerCount] = useState(4);
  const [players, setPlayers] = useState<PlayerConfig[]>([
    { id: 1, name: '玩家 1', isBot: false },
    { id: 2, name: '机器人 Alice', isBot: true, botToken: '', botId: '7615209749759426602', apiUrl: 'https://rz2qynsv9r.coze.site/stream_run' },
    { id: 3, name: '机器人 Bob', isBot: true, botToken: '', botId: '7615209749759426602', apiUrl: 'https://rz2qynsv9r.coze.site/stream_run' },
    { id: 4, name: '机器人 Charlie', isBot: true, botToken: '', botId: '7615209749759426602', apiUrl: 'https://rz2qynsv9r.coze.site/stream_run' },
  ]);
  const [initialChips, setInitialChips] = useState(2000);
  const [smallBlind, setSmallBlind] = useState(100);
  const [bigBlind, setBigBlind] = useState(200);
  const [timeLimit, setTimeLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [availableBots, setAvailableBots] = useState<BotTemplate[]>([]);
  const [advancedBotPlayers, setAdvancedBotPlayers] = useState<Record<number, boolean>>({});
  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([]);
  const [hostInviteLink, setHostInviteLink] = useState<InviteLink | null>(null);
  const [copiedPlayerId, setCopiedPlayerId] = useState<string | null>(null);

  useEffect(() => {
    // 获取可用机器人列表
    const fetchBots = async () => {
      try {
        const result = await gameApiClient.getBots();
        if (result.success && Array.isArray(result.data)) {
          setAvailableBots(result.data);
          setPlayers((prev) => applyDefaultBots(prev, result.data ?? []));
        }
      } catch (error) {
        console.error('Failed to fetch bots:', error);
      }
    };
    fetchBots();
  }, []);

  // 更新玩家数量
  const handlePlayerCountChange = (value: number) => {
    const newCount = value;
    setPlayerCount(newCount);

    // 调整玩家列表
    if (newCount > players.length) {
      // 添加新玩家（默认为机器人）
      const newPlayers = [...players];
      const usedNames = collectUsedNames(newPlayers);
      let botIndex = players.filter((p) => p.isBot).length;

      for (let i = players.length; i < newCount; i++) {
        const template = availableBots[botIndex % availableBots.length];
        botIndex += 1;
        const fallbackBotName = `机器人 ${i + 1}`;

        newPlayers.push({
          id: i + 1,
          name: getUniquePlayerName(template?.name ?? fallbackBotName, usedNames),
          isBot: true,
          botToken: template?.token || '',
          botId: template?.botId || DEFAULT_BOT_ID,
          apiUrl: template?.url || DEFAULT_BOT_API_URL,
        });
      }
      setPlayers(newPlayers);
    } else if (newCount < players.length) {
      // 移除末尾玩家
      setPlayers(players.slice(0, newCount));
    }
  };

  // 更新玩家配置
  const updatePlayerConfig = (playerId: number, updates: Partial<PlayerConfig>) => {
    setPlayers((prev) => prev.map((player) => (player.id === playerId ? { ...player, ...updates } : player)));
  };

  const toggleAdvancedBotConfig = (playerId: number) => {
    setAdvancedBotPlayers((prev) => ({
      ...prev,
      [playerId]: !prev[playerId],
    }));
  };

  const togglePlayerType = (playerId: number) => {
    setError('');
    setPlayers((prev) => {
      const current = prev.find((player) => player.id === playerId);
      if (!current) return prev;

      if (!current.isBot) {
        const botCount = prev.filter((player) => player.isBot).length;
        const template = availableBots.length
          ? availableBots[botCount % availableBots.length]
          : undefined;
        const usedNames = collectUsedNames(prev, playerId);
        return prev.map((player) => {
          if (player.id !== playerId) return player;
          const fallbackBotName = `机器人 ${player.id}`;
          const currentName = player.name.trim();
          const preferredName =
            currentName && !currentName.startsWith('玩家')
              ? currentName
              : template?.name ?? fallbackBotName;

          return {
            ...player,
            isBot: true,
            name: getUniquePlayerName(preferredName, usedNames),
            botToken: template?.token ?? '',
            botId: template?.botId ?? DEFAULT_BOT_ID,
            apiUrl: template?.url ?? DEFAULT_BOT_API_URL,
          };
        });
      }

      return prev.map((player) => {
        if (player.id !== playerId) return player;
        const currentName = player.name.trim();
        return {
          ...player,
          isBot: false,
          name:
            !currentName || currentName.startsWith('机器人')
              ? `玩家 ${player.id}`
              : player.name,
          botToken: undefined,
        };
      });
    });
  };

  const copyInviteLink = async (invite: InviteLink) => {
    try {
      await navigator.clipboard.writeText(invite.shareUrl);
      setCopiedPlayerId(invite.playerId);
      setTimeout(() => setCopiedPlayerId((prev) => (prev === invite.playerId ? null : prev)), 1500);
    } catch {
      setError('复制链接失败，请手动复制');
    }
  };

  // 验证设置
  const validateSettings = () => {
    // 检查玩家名称
    const nameSet = new Set(players.map(p => p.name.trim()));
    if (nameSet.size !== players.length) {
      return '玩家名称不能重复';
    }

    if (players.some(p => !p.name.trim())) {
      return '所有玩家必须设置名称';
    }

    // 检查机器人配置（botToken 现在是可选的，没有token会使用默认策略）
    // 移除 token 检查，允许空 token（使用默认策略）

    // 检查盲注
    if (smallBlind <= 0 || bigBlind <= 0) {
      return '盲注必须大于0';
    }

    if (bigBlind < smallBlind) {
      return '大盲注不能小于小盲注';
    }

    // 检查初始筹码
    if (initialChips < bigBlind * 2) {
      return '初始筹码应该至少是大盲注的2倍';
    }

    // 检查时间限制
    if (timeLimit < 10) {
      return '思考时间不能少于10秒';
    }

    return '';
  };

  // 开始游戏
  const handleStartGame = async () => {
    const validationError = validateSettings();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setLoading(true);
    setInviteLinks([]);
    setHostInviteLink(null);

    try {
      // 调用游戏服务器初始化游戏
      const result = await gameApiClient.initGame({
        players: players.map(p => ({
          id: p.id.toString(),
          name: p.name,
          chips: initialChips,
          isBot: p.isBot,
          botToken: p.botToken,
          botId: p.botId,
          apiUrl: p.apiUrl,
        })),
        smallBlind,
        bigBlind,
        timeLimit,
      });

      if (result.success) {
        const humanPlayer = players.find(p => !p.isBot);
        const data = result.data as {
          gameId?: string;
          playerAccess?: Array<{
            playerId?: string;
            playerName?: string;
            token?: string;
          }>;
        } | undefined;

        if (!data?.gameId) {
          setError('游戏初始化失败');
          return;
        }

        const rawPlayerAccess = Array.isArray(data.playerAccess)
          ? data.playerAccess
          : [];
        const baseUrl = window.location.origin;
        const normalizedLinks: InviteLink[] = rawPlayerAccess
          .map((entry) => {
            const playerId = typeof entry.playerId === 'string' ? entry.playerId : '';
            const token = typeof entry.token === 'string' ? entry.token : '';
            if (!playerId || !token) return null;
            const playerName =
              typeof entry.playerName === 'string' && entry.playerName.trim()
                ? entry.playerName
                : `玩家 ${playerId}`;
            const url = `/?gameId=${encodeURIComponent(data.gameId as string)}&playerId=${encodeURIComponent(playerId)}&playerToken=${encodeURIComponent(token)}`;
            return {
              playerId,
              playerName,
              token,
              url,
              shareUrl: `${baseUrl}${url}`,
            };
          })
          .filter((item): item is InviteLink => Boolean(item));

        if (normalizedLinks.length > 0) {
          setInviteLinks(normalizedLinks);
          const hostPlayerId = String(humanPlayer?.id || normalizedLinks[0].playerId);
          const hostLink =
            normalizedLinks.find((entry) => entry.playerId === hostPlayerId) ??
            normalizedLinks[0];
          setHostInviteLink(hostLink);

          if (normalizedLinks.length === 1) {
            router.push(hostLink.url);
            return;
          }

          return;
        }

        if (!humanPlayer) {
          router.push(`/?gameId=${encodeURIComponent(data.gameId)}`);
          return;
        }

        setError('服务端未返回玩家凭证，请重试');
      } else {
        setError(result.error || '游戏初始化失败');
      }
    } catch (err) {
      console.error('Start game error:', err);
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="max-w-4xl mx-auto">
        {/* 标题 */}
        <div className="flex items-center gap-4 mb-8">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/')}
            className="bg-white/10 hover:bg-white/20 text-white border-white/20"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-bold text-white">游戏设置</h1>
          <Badge className="bg-gradient-to-r from-purple-500 to-pink-500">
            <Bot className="w-4 h-4 mr-1" />
            AI 机器人支持
          </Badge>
        </div>

        <div className="grid gap-6">
          {/* 游戏规则设置 */}
          <Card className="p-6 bg-white/10 border-white/20">
            <h2 className="text-xl font-semibold text-white mb-4">游戏规则</h2>

            {/* 玩家数量 */}
            <div className="mb-6">
              <Label className="text-white mb-2 block">
                玩家数量: <span className="font-bold text-yellow-400">{playerCount}</span> 人
              </Label>
              <Slider
                value={[playerCount]}
                onValueChange={(value) => handlePlayerCountChange(value[0])}
                min={2}
                max={9}
                step={1}
                className="py-4"
              />
              <div className="flex justify-between text-sm text-gray-400 mt-1">
                <span>2人</span>
                <span>9人</span>
              </div>
            </div>

            {/* 初始筹码 */}
            <div className="mb-6">
              <Label className="text-white mb-2 block">
                初始筹码: <span className="font-bold text-yellow-400">{initialChips}</span>
              </Label>
              <div className="grid grid-cols-4 gap-2">
                {[500, 1000, 2000, 5000].map((chips) => (
                  <Button
                    key={chips}
                    variant={initialChips === chips ? 'default' : 'outline'}
                    onClick={() => setInitialChips(chips)}
                    className={initialChips === chips ? '' : 'bg-white/10 hover:bg-white/20 text-white border-white/20'}
                  >
                    {chips}
                  </Button>
                ))}
              </div>
              <div className="mt-2">
                <Input
                  type="number"
                  value={initialChips}
                  onChange={(e) => setInitialChips(Number(e.target.value))}
                  className="bg-white/10 border-white/20 text-white"
                  placeholder="自定义筹码"
                  min={100}
                />
              </div>
            </div>

            {/* 盲注设置 */}
            <div className="mb-6 grid grid-cols-2 gap-4">
              <div>
                <Label className="text-white mb-2 block">小盲注</Label>
                <Input
                  type="number"
                  value={smallBlind}
                  onChange={(e) => setSmallBlind(Number(e.target.value))}
                  className="bg-white/10 border-white/20 text-white"
                  min={1}
                />
              </div>
              <div>
                <Label className="text-white mb-2 block">大盲注</Label>
                <Input
                  type="number"
                  value={bigBlind}
                  onChange={(e) => setBigBlind(Number(e.target.value))}
                  className="bg-white/10 border-white/20 text-white"
                  min={1}
                />
              </div>
            </div>

            {/* 思考时间 */}
            <div>
              <Label className="text-white mb-2 block">
                思考时间: <span className="font-bold text-yellow-400">{timeLimit}</span> 秒
              </Label>
              <Slider
                value={[timeLimit]}
                onValueChange={(value) => setTimeLimit(value[0])}
                min={10}
                max={120}
                step={5}
                className="py-4"
              />
              <div className="flex justify-between text-sm text-gray-400 mt-1">
                <span>10秒</span>
                <span>120秒</span>
              </div>
            </div>
          </Card>

          {/* 玩家配置 */}
          <Card className="p-6 bg-white/10 border-white/20">
            <h2 className="text-xl font-semibold text-white mb-4">玩家配置</h2>
            <div className="space-y-4">
              {players.map((player) => {
                const selectedBot = availableBots.find((bot) => matchBotTemplate(player, bot));
                const advancedOpen = Boolean(advancedBotPlayers[player.id]);

                return (
                  <Card key={player.id} className={`p-4 ${player.isBot ? 'bg-purple-500/10 border-purple-500/30' : 'bg-blue-500/10 border-blue-500/30'}`}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Badge variant={player.isBot ? 'default' : 'secondary'} className={player.isBot ? 'bg-purple-500' : 'bg-blue-500'}>
                          {player.isBot ? <Bot className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
                          {player.isBot ? '机器人' : '真人'}
                        </Badge>
                        <span className="text-white font-medium">玩家 {player.id}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => togglePlayerType(player.id)}
                        className="h-7 border-white/20 bg-white/5 text-xs text-white hover:bg-white/10"
                      >
                        {player.isBot ? '改为真人' : '改为机器人'}
                      </Button>
                    </div>

                    {/* 玩家名称 */}
                    <div className="mb-3">
                      <Label className="text-gray-300 text-sm mb-1 block">名称</Label>
                      <Input
                        value={player.name}
                        onChange={(e) => updatePlayerConfig(player.id, { name: e.target.value })}
                        className="bg-white/10 border-white/20 text-white"
                        placeholder="输入玩家名称"
                      />
                    </div>

                    {/* 机器人专属配置 */}
                    {player.isBot && (
                      <div className="space-y-3 pt-3 border-t border-white/10">
                        <div className="flex flex-col space-y-2">
                          <Label className="text-gray-300 text-sm">选择预设机器人</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                role="combobox"
                                className="w-full justify-between bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
                              >
                                {selectedBot ? selectedBot.name : '选择机器人模板...'}
                                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[300px] p-0 bg-slate-800 border-slate-700">
                              <Command className="bg-slate-800 text-white">
                                <CommandInput placeholder="搜索机器人..." className="h-9 text-white" />
                                <CommandList>
                                  <CommandEmpty>未找到机器人</CommandEmpty>
                                  <CommandGroup>
                                    {availableBots.map((bot) => (
                                    <CommandItem
                                      key={bot.id}
                                      value={bot.name}
                                      onSelect={() => {
                                          setPlayers((prev) => {
                                            const usedNames = collectUsedNames(prev, player.id);
                                            return prev.map((targetPlayer) => {
                                              if (targetPlayer.id !== player.id) return targetPlayer;

                                              return {
                                                ...targetPlayer,
                                                name: getUniquePlayerName(bot.name, usedNames),
                                                botToken: bot.token ?? targetPlayer.botToken ?? '',
                                                botId: bot.botId,
                                                apiUrl: bot.url,
                                              };
                                            });
                                          });
                                        }}
                                        className="text-white hover:bg-slate-700 cursor-pointer"
                                      >
                                        <Check
                                          className={cn(
                                            'mr-2 h-4 w-4',
                                            selectedBot?.id === bot.id ? 'opacity-100' : 'opacity-0'
                                          )}
                                        />
                                        {bot.name}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        </div>

                        <div className="flex items-center justify-between text-xs text-gray-400">
                          <span>BotID: {player.botId || '-'}</span>
                          <span>域名: {getHostFromUrl(player.apiUrl)}</span>
                        </div>

                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => toggleAdvancedBotConfig(player.id)}
                          className="h-8 px-2 text-gray-300 hover:text-white hover:bg-white/10"
                        >
                          {advancedOpen ? '收起高级设置' : '展开高级设置'}
                        </Button>

                        {advancedOpen && (
                          <div className="space-y-3 pt-3 border-t border-white/10">
                            <div>
                              <Label className="text-gray-300 text-sm mb-1 block">API Token（可选）</Label>
                              <Input
                                type="password"
                                value={player.botToken || ''}
                                onChange={(e) => updatePlayerConfig(player.id, { botToken: e.target.value })}
                                className="bg-white/10 border-white/20 text-white"
                                placeholder="输入 Coze API Token"
                              />
                            </div>

                            <div>
                              <Label className="text-gray-300 text-sm mb-1 block">Bot ID</Label>
                              <Input
                                value={player.botId || ''}
                                onChange={(e) => updatePlayerConfig(player.id, { botId: e.target.value })}
                                className="bg-white/10 border-white/20 text-white"
                                placeholder="输入 Coze Bot ID"
                              />
                            </div>

                            <div>
                              <Label className="text-gray-300 text-sm mb-1 block">API URL</Label>
                              <Input
                                value={player.apiUrl || ''}
                                onChange={(e) => updatePlayerConfig(player.id, { apiUrl: e.target.value })}
                                className="bg-white/10 border-white/20 text-white"
                                placeholder="https://rz2qynsv9r.coze.site/stream_run"
                              />
                            </div>

                            <p className="text-xs text-gray-400">
                              一般无需修改以上字段；若 Token 为空，机器人将回退到默认策略。
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </Card>

          {/* 错误提示 */}
          {error && (
            <Card className="p-4 bg-red-500/20 border-red-500 text-red-200">
              {error}
            </Card>
          )}

          {inviteLinks.length > 0 && (
            <Card className="p-4 bg-emerald-500/10 border-emerald-500/40 text-emerald-100">
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">邀请链接已生成</h3>
                  <p className="text-xs text-emerald-200/80">
                    将对应链接发送给每位真人玩家，机器人无需链接。
                  </p>
                </div>
                <div className="space-y-2">
                  {inviteLinks.map((invite) => (
                    <div
                      key={invite.playerId}
                      className="rounded border border-emerald-500/30 bg-black/20 p-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{invite.playerName}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => void copyInviteLink(invite)}
                          className="h-7 border-emerald-400/50 bg-transparent text-emerald-100 hover:bg-emerald-500/20"
                        >
                          {copiedPlayerId === invite.playerId ? '已复制' : '复制链接'}
                        </Button>
                      </div>
                      <p className="break-all text-xs text-emerald-200/85">{invite.shareUrl}</p>
                    </div>
                  ))}
                </div>
                {hostInviteLink && (
                  <Button
                    type="button"
                    onClick={() => router.push(hostInviteLink.url)}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                  >
                    我先进入（{hostInviteLink.playerName}）
                  </Button>
                )}
              </div>
            </Card>
          )}

          {/* 开始游戏按钮 */}
          <Button
            onClick={handleStartGame}
            disabled={loading}
            className="w-full h-14 text-lg font-bold bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700"
          >
            <Play className="w-6 h-6 mr-2" />
            {loading ? '初始化中...' : '开始游戏'}
          </Button>
        </div>
      </div>
    </div>
  );
}
