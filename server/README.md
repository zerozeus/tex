# 德州扑克游戏服务器

完整的德州扑克游戏服务器，支持REST API和WebSocket实时通信。

## 功能特性

- ✅ 完整的游戏逻辑实现
- ✅ REST API接口
- ✅ WebSocket实时通信
- ✅ 支持2-9人对战
- ✅ 盲注管理
- ✅ 玩家操作（弃牌、过牌、跟注、加注、全押）
- ✅ 游戏阶段管理（翻牌前、翻牌、转牌、河牌、摊牌）
- ✅ 多游戏支持
- ✅ 内存存储（适合开发测试）

## 技术栈

- **Node.js** - 运行环境
- **Express** - Web框架
- **WebSocket (ws)** - 实时通信
- **TypeScript** - 类型安全

## 快速开始

### 安装依赖

```bash
cd server
pnpm install
```

### 启动服务器

```bash
# 开发模式（支持热更新）
pnpm run dev

# 生产模式
pnpm run build
pnpm start
```

服务器将启动在：
- REST API: `http://localhost:5001`
- WebSocket: `ws://localhost:5002`

## API 接口文档

### 1. 健康检查

**GET** `/health`

```bash
curl http://localhost:5001/health
```

**响应:**
```json
{
  "status": "ok",
  "timestamp": 1234567890
}
```

### 2. 初始化游戏

**POST** `/api/game/init`

创建新的一局德州扑克游戏。

**请求体:**
```json
{
  "players": [
    { "id": "1", "name": "玩家 1", "chips": 1000 },
    { "id": "2", "name": "玩家 2", "chips": 1000 },
    { "id": "3", "name": "玩家 3", "chips": 1000 }
  ],
  "smallBlind": 10,
  "bigBlind": 20,
  "timeLimit": 30
}
```

**响应:**
```json
{
  "success": true,
  "data": {
    "gameId": "game-1773071183324-hf176es3z",
    "phase": "preflop",
    "pot": 30,
    "currentBet": 20,
    "communityCards": [],
    "players": [...],
    "currentPlayerIndex": 2,
    "dealerIndex": 2,
    "smallBlindIndex": 0,
    "bigBlindIndex": 1,
    "timeRemaining": 30,
    "settings": {
      "smallBlind": 10,
      "bigBlind": 20,
      "timeLimit": 30
    }
  }
}
```

### 3. 获取游戏状态

**GET** `/api/game/state?gameId=xxx`

获取当前游戏的完整状态。

```bash
curl "http://localhost:5001/api/game/state?gameId=game-1773071183324-hf176es3z"
```

### 4. 玩家操作

**POST** `/api/game/action`

处理玩家的各种操作。

**请求体:**
```json
{
  "gameId": "game-xxx",
  "playerId": "1",
  "action": "fold" | "check" | "call" | "raise" | "allin",
  "amount": 100  // 仅加注时需要
}
```

**示例 - 跟注:**
```bash
curl -X POST http://localhost:5001/api/game/action \
  -H 'Content-Type: application/json' \
  -d '{
    "gameId": "game-xxx",
    "playerId": "1",
    "action": "call"
  }'
```

**示例 - 加注:**
```bash
curl -X POST http://localhost:5001/api/game/action \
  -H 'Content-Type: application/json' \
  -d '{
    "gameId": "game-xxx",
    "playerId": "1",
    "action": "raise",
    "amount": 50
  }'
```

### 5. 进入下一阶段

**POST** `/api/game/next-phase`

进入游戏的下一个阶段（翻牌、转牌、河牌、摊牌）。

**请求体:**
```json
{
  "gameId": "game-xxx"
}
```

### 6. 获取游戏列表

**GET** `/api/games`

获取所有正在进行的游戏列表。

```bash
curl http://localhost:5001/api/games
```

## WebSocket 使用

### 连接服务器

```javascript
const ws = new WebSocket('ws://localhost:5002');

ws.on('open', () => {
  console.log('Connected to server');
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});
```

### 消息格式

**发送消息:**
```json
{
  "type": "player_action",
  "data": {
    "gameId": "game-xxx",
    "playerId": "1",
    "action": "call",
    "amount": 50
  },
  "timestamp": 1234567890
}
```

**接收消息:**
```json
{
  "type": "game_update",
  "data": {
    "gameId": "game-xxx",
    "phase": "flop",
    "pot": 150,
    "communityCards": [...],
    "players": [...]
  },
  "timestamp": 1234567890
}
```

## 消息类型

### 客户端发送的消息

- `player_action` - 玩家操作
- `game_state` - 请求游戏状态

### 服务器发送的消息

- `game_update` - 游戏状态更新
- `game_state` - 完整游戏状态
- `error` - 错误信息

## 游戏规则

1. **玩家数量**: 2-9人
2. **游戏阶段**:
   - Preflop（翻牌前）：每人发2张底牌
   - Flop（翻牌）：发3张公共牌
   - Turn（转牌）：发第4张公共牌
   - River（河牌）：发第5张公共牌
   - Showdown（摊牌）：比牌定胜负

3. **牌型优先级**（从高到低）:
   - 皇家同花顺
   - 同花顺
   - 四条
   - 葫芦
   - 同花
   - 顺子
   - 三条
   - 两对
   - 一对
   - 高牌

## 项目结构

```
server/
├── src/
│   ├── index.ts              # 主服务器文件
│   ├── game-engine.ts        # 游戏逻辑引擎
│   ├── websocket-handler.ts  # WebSocket处理器
│   └── types.ts              # TypeScript类型定义
├── dist/                     # 编译输出目录
├── package.json
├── tsconfig.json
└── README.md
```

## 环境变量

```bash
PORT=5001           # REST API端口
WS_PORT=5002        # WebSocket端口
```

## 开发说明

### 代码结构

- `GameEngine` - 核心游戏逻辑类
  - 洗牌和发牌
  - 盲注收取
  - 玩家操作处理
  - 阶段转换
  - 胜负判定

- `WebSocketHandler` - WebSocket通信处理
  - 客户端连接管理
  - 消息路由
  - 广播游戏状态

### 扩展功能

1. **持久化存储** - 添加数据库支持
2. **用户认证** - 添加JWT认证
3. **聊天系统** - 实现玩家聊天
4. **游戏录像** - 记录游戏过程
5. **排行榜** - 玩家战绩统计

## 测试

### 测试API

```bash
# 健康检查
curl http://localhost:5001/health

# 初始化游戏
curl -X POST http://localhost:5001/api/game/init \
  -H 'Content-Type: application/json' \
  -d '{
    "players": [
      {"id": "1", "name": "Alice", "chips": 1000},
      {"id": "2", "name": "Bob", "chips": 1000}
    ],
    "smallBlind": 10,
    "bigBlind": 20,
    "timeLimit": 30
  }'
```

### 测试WebSocket

使用WebSocket测试工具或浏览器控制台：

```javascript
const ws = new WebSocket('ws://localhost:5002');
ws.onmessage = (event) => console.log(JSON.parse(event.data));
```

## 部署

### 使用PM2部署

```bash
npm install -g pm2

# 构建项目
pnpm run build

# 启动服务
pm2 start dist/index.js --name texas-holdem-server

# 查看日志
pm2 logs texas-holdem-server

# 重启服务
pm2 restart texas-holdem-server
```

### Docker部署

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN pnpm install

COPY . .
RUN pnpm run build

EXPOSE 5001 5002

CMD ["node", "dist/index.js"]
```

## 故障排除

### 端口被占用

```bash
# 查看端口占用
lsof -i :5001
lsof -i :5002

# 修改端口
PORT=5003 WS_PORT=5004 pnpm run dev
```

### 服务器无法启动

1. 检查Node.js版本（需要 >= 18）
2. 检查依赖是否安装：`pnpm install`
3. 查看日志：`tail -f /app/work/logs/bypass/game-server.log`

## 许可证

MIT

## 支持

如有问题，请联系开发团队或提交Issue。
