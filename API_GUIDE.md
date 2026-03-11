# 德州扑克 API 接口文档

本文档列出了所有预留的API接口，您需要实现这些接口来完成德州扑克的后端逻辑。

## 接口列表

### 1. 初始化游戏
**POST** `/api/game/init`

初始化新的一局德州扑克游戏。

**请求体:**
```json
{
  "playerIds": [1, 2, 3],
  "smallBlind": 10,
  "bigBlind": 20
}
```

**需要实现的功能:**
- [ ] 验证玩家数量（2-9人）
- [ ] 创建唯一游戏ID
- [ ] 洗牌并分配底牌（每人2张）
- [ ] 确定庄家位置（轮换或随机）
- [ ] 收取盲注（小盲注由庄家下家支付，大盲注由小盲注下家支付）
- [ ] 设置当前玩家为小盲注下家
- [ ] 保存游戏状态到数据库或内存
- [ ] 返回完整的游戏状态

**响应:**
```json
{
  "success": true,
  "data": {
    "gameId": "game-001",
    "phase": "preflop",
    "pot": 30,
    "currentBet": 20,
    "communityCards": [],
    "players": [
      {
        "id": 1,
        "name": "玩家 1",
        "chips": 980,
        "cards": [
          { "suit": "♠", "rank": "A", "value": 14 },
          { "suit": "♦", "rank": "K", "value": 13 }
        ],
        "bet": 10,
        "isFolded": false,
        "isDealer": true,
        "isCurrent": false
      }
    ],
    "currentPlayerIndex": 2,
    "timeRemaining": 30
  }
}
```

---

### 2. 玩家操作
**POST** `/api/game/action`

处理玩家的各种操作。

**请求体:**
```json
{
  "gameId": "game-001",
  "playerId": 1,
  "action": "fold" | "check" | "call" | "raise" | "allin",
  "amount": 100  // 仅加注时需要
}
```

**需要实现的功能:**
- [ ] 验证操作合法性（是否轮到该玩家，筹码是否足够等）
- [ ] 处理弃牌：标记玩家为已弃牌
- [ ] 处理过牌：不增加下注额，仅当当前下注额与玩家已下注额相同时才允许
- [ ] 处理跟注：玩家支付当前下注额与已下注额的差额
- [ ] 处理加注：玩家在跟注基础上增加额外下注
- [ ] 处理全押：玩家押上所有筹码
- [ ] 更新玩家筹码和下注额
- [ ] 检查是否所有玩家操作完成
- [ ] 如果所有玩家操作完成，自动调用进入下一阶段接口
- [ ] 更新当前玩家索引

**响应:**
```json
{
  "success": true,
  "data": {
    "gameId": "game-001",
    "phase": "flop",
    "pot": 150,
    "currentBet": 0,
    "communityCards": [
      { "suit": "♠", "rank": "A", "value": 14 },
      { "suit": "♥", "rank": "K", "value": 13 },
      { "suit": "♦", "rank": "Q", "value": 12 }
    ],
    "players": [...],
    "currentPlayerIndex": 0,
    "timeRemaining": 30
  }
}
```

---

### 3. 获取游戏状态
**GET** `/api/game/state?gameId=xxx`

获取当前游戏的完整状态。

**需要实现的功能:**
- [ ] 从数据库或内存中获取游戏状态
- [ ] 如果游戏不存在，返回404错误
- [ ] 返回完整的游戏信息

**响应:**
```json
{
  "success": true,
  "data": {
    "gameId": "game-001",
    "phase": "flop",
    "pot": 150,
    "currentBet": 0,
    "communityCards": [...],
    "players": [...],
    "currentPlayerIndex": 1,
    "timeRemaining": 30
  }
}
```

---

### 4. 进入下一阶段
**POST** `/api/game/next-phase`

进入游戏的下一个阶段。

**请求体:**
```json
{
  "gameId": "game-001"
}
```

**需要实现的功能:**
- [ ] 验证当前阶段
- [ ] 根据当前阶段决定下一阶段：
  - preflop → flop：发3张公共牌
  - flop → turn：发1张公共牌
  - turn → river：发1张公共牌
  - river → showdown：摊牌比较牌型
- [ ] 重置所有玩家的下注额
- [ ] 在摊牌阶段：
  - [ ] 计算每个未弃牌玩家的最佳牌型
  - [ ] 比较牌型大小，确定胜负
  - [ ] 分配底池给获胜者
  - [ ] 处理平局情况
- [ ] 设置当前玩家为第一个未弃牌的玩家
- [ ] 更新游戏状态

**响应:**
```json
{
  "success": true,
  "data": {
    "gameId": "game-001",
    "phase": "flop",
    "pot": 150,
    "currentBet": 0,
    "communityCards": [...],
    "players": [...],
    "currentPlayerIndex": 0,
    "timeRemaining": 30
  }
}
```

---

## 数据结构

### Card（扑克牌）
```typescript
interface Card {
  suit: '♠' | '♥' | '♦' | '♣';  // 花色
  rank: string;                   // 点数: 2-10, J, Q, K, A
  value: number;                  // 数值: 2-14
}
```

### Player（玩家）
```typescript
interface Player {
  id: number;          // 玩家ID
  name: string;        // 玩家名称
  chips: number;       // 筹码数量
  cards: Card[];       // 手牌（2张）
  bet: number;         // 当前轮次下注额
  isFolded: boolean;   // 是否弃牌
  isDealer: boolean;   // 是否为庄家
  isCurrent: boolean;  // 是否为当前操作玩家
}
```

### GameState（游戏状态）
```typescript
interface GameState {
  gameId: string;           // 游戏ID
  phase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';  // 当前阶段
  pot: number;              // 底池
  currentBet: number;       // 当前最大下注额
  communityCards: Card[];   // 公共牌（0-5张）
  players: Player[];        // 所有玩家
  currentPlayerIndex: number;  // 当前玩家索引
  timeRemaining: number;    // 剩余思考时间（秒）
}
```

---

## 牌型优先级（从高到低）

1. **皇家同花顺** (Royal Flush)
2. **同花顺** (Straight Flush)
3. **四条** (Four of a Kind)
4. **葫芦** (Full House)
5. **同花** (Flush)
6. **顺子** (Straight)
7. **三条** (Three of a Kind)
8. **两对** (Two Pair)
9. **一对** (One Pair)
10. **高牌** (High Card)

---

## 实现建议

1. **数据持久化**：建议使用数据库（如 PostgreSQL、MongoDB）或 Redis 存储游戏状态
2. **并发控制**：使用乐观锁或悲观锁处理并发操作
3. **错误处理**：实现完善的错误处理和日志记录
4. **超时处理**：实现玩家操作超时自动弃牌或过牌
5. **牌型计算**：实现高效的牌型比较算法
6. **测试**：编写单元测试和集成测试

---

## 前端集成

前端页面已经完成，包含了所有必要的UI组件和交互逻辑。您只需要：

1. 实现 `/api/game/init` 接口，让游戏可以正常初始化
2. 实现 `/api/game/action` 接口，处理玩家的各种操作
3. 实现 `/api/game/state` 接口，获取游戏状态
4. 实现 `/api/game/next-phase` 接口，处理游戏阶段转换

前端代码中已经预留了API调用位置，只需取消注释并使用真实数据即可。
