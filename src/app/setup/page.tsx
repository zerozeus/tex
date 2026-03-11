'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { User, Play, ArrowLeft, Bot } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { gameApiClient } from '@/lib/api-client';

interface PlayerConfig {
  id: number;
  name: string;
  isBot: boolean;
  botToken?: string;
  botId?: string;
}

export default function GameSetup() {
  const router = useRouter();
  const [playerCount, setPlayerCount] = useState(3);
  const [players, setPlayers] = useState<PlayerConfig[]>([
    { id: 1, name: '玩家 1', isBot: false },
    { id: 2, name: '机器人 Alice', isBot: true, botToken: '', botId: '7615209749759426602' },
    { id: 3, name: '机器人 Bob', isBot: true, botToken: '', botId: '7615209749759426602' },
  ]);
  const [initialChips, setInitialChips] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [timeLimit, setTimeLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 更新玩家数量
  const handlePlayerCountChange = (value: number) => {
    const newCount = value;
    setPlayerCount(newCount);

    // 调整玩家列表
    if (newCount > players.length) {
      // 添加新玩家（默认为机器人）
      const newPlayers = [...players];
      for (let i = players.length; i < newCount; i++) {
        newPlayers.push({
          id: i + 1,
          name: `机器人 ${String.fromCharCode(65 + i)}`,
          isBot: true,
          botToken: '',
          botId: '7615209749759426602',
        });
      }
      setPlayers(newPlayers);
    } else if (newCount < players.length) {
      // 移除玩家（保留第一个真人玩家）
      const remainingPlayers = players.slice(0, newCount);
      // 确保至少有一个真人玩家
      if (!remainingPlayers.some(p => !p.isBot) && remainingPlayers.length > 0) {
        remainingPlayers[0].isBot = false;
        remainingPlayers[0].name = '玩家 1';
      }
      setPlayers(remainingPlayers);
    }
  };

  // 更新玩家配置
  const updatePlayerConfig = (playerId: number, updates: Partial<PlayerConfig>) => {
    setPlayers(players.map(p => p.id === playerId ? { ...p, ...updates } : p));
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

    // 检查是否至少有一个真人玩家
    const humanPlayer = players.find(p => !p.isBot);
    if (!humanPlayer) {
      return '至少需要一个真人玩家';
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
        })),
        smallBlind,
        bigBlind,
        timeLimit,
      });

      if (result.success) {
        // 跳转到游戏页面，传递真人玩家ID
        const humanPlayer = players.find(p => !p.isBot);
        const data = result.data as { gameId: string } | undefined;
        if (data?.gameId) {
          router.push(`/?gameId=${data.gameId}&playerId=${humanPlayer?.id || '1'}`);
        } else {
          setError('游戏初始化失败');
        }
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
              {players.map((player) => (
                <Card key={player.id} className={`p-4 ${player.isBot ? 'bg-purple-500/10 border-purple-500/30' : 'bg-blue-500/10 border-blue-500/30'}`}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={player.isBot ? "default" : "secondary"} className={player.isBot ? "bg-purple-500" : "bg-blue-500"}>
                        {player.isBot ? <Bot className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
                        {player.isBot ? '机器人' : '真人'}
                      </Badge>
                      <span className="text-white font-medium">玩家 {player.id}</span>
                    </div>
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
                      <div>
                        <Label className="text-gray-300 text-sm mb-1 block">API Token (必填)</Label>
                        <Input
                          type="password"
                          value={player.botToken || ''}
                          onChange={(e) => updatePlayerConfig(player.id, { botToken: e.target.value })}
                          className="bg-white/10 border-white/20 text-white"
                          placeholder="输入 Coze API Token"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          在 Coze 平台获取个人访问令牌 (PAT)
                        </p>
                      </div>

                      <div>
                        <Label className="text-gray-300 text-sm mb-1 block">Project ID (必填)</Label>
                        <Input
                          value={player.botId || ''}
                          onChange={(e) => updatePlayerConfig(player.id, { botId: e.target.value })}
                          className="bg-white/10 border-white/20 text-white"
                          placeholder="输入 Coze Project ID"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          例如: 7615209749759426602
                        </p>
                      </div>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </Card>

          {/* 错误提示 */}
          {error && (
            <Card className="p-4 bg-red-500/20 border-red-500 text-red-200">
              {error}
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
