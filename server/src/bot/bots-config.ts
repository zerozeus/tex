export interface BotConfig {
  id: string;
  name: string;
  botId: string;
  url: string;
}

export const AVAILABLE_BOTS: BotConfig[] = [
  {
    id: 'mad_dog',
    name: '疯狗',
    botId: '7616224336663576639',
    url: 'https://gvr48qv2qj.coze.site/stream_run'
  },
  {
    id: 'follow_or_not',
    name: '你跟不跟',
    botId: '7615209749759426602',
    url: 'https://rz2qynsv9r.coze.site/stream_run'
  },
  {
    id: 'jiancheng_bot',
    name: '德州小白菜',
    botId: '7615606911139954740',
    url: 'https://tt6ym3f4dx.coze.site/stream_run'
  }
];
