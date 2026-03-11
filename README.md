# 🎰 德州扑克游戏 (Texas Hold'em)

一个完整的德州扑克游戏系统，包含前端界面、后端游戏引擎、WebSocket 实时通信、数据库持久化及 AI 机器人支持。

> **注意**：本项目专为 Coze 平台设计，前端 (Next.js) 和后端 (Express) 统一打包部署，不支持分开部署。

## ✨ 功能特性

### 游戏功能
- ✅ **完整的德州扑克规则实现**
  - 翻牌前、翻牌、转牌、河牌、摊牌阶段
  - 完整的牌型比较系统（高牌到皇家同花顺）
  - 盲注收取、下注、跟注、加注、弃牌、全押
  - 阶段自动推进逻辑

- ✅ **多玩家支持**
  - 2-9人同时游戏
  - 实时游戏状态同步 (WebSocket)
  - 玩家筹码管理

- ✅ **AI 机器人**
  - 内置默认策略机器人
  - 支持 Coze AI 智能体集成
  - 可配置不同 AI 模型

- ✅ **精美的 UI 界面**
  - 绿色渐变牌桌背景
  - 扑克牌精美展示
  - 玩家信息卡片
  - 公共牌区域
  - 底池实时显示
  - 庄家标识和当前玩家高亮

### 技术架构
- **前端**：Next.js 16 (React) + Tailwind CSS + Shadcn UI
- **后端**：Express + TypeScript + WebSocket (ws)
- **数据库**：Supabase (可选)
- **部署模式**：一体化部署 (Express 托管 Next.js 页面)

---

## 🚀 快速开始

### 前置要求
- Node.js 18+
- pnpm

### 本地开发

#### 1. 克隆项目
```bash
git clone <你的仓库地址>
cd texas-holdem
```

#### 2. 安装依赖
```bash
# 安装根目录及前端依赖
pnpm install

# 安装后端依赖
cd server
pnpm install
cd ..
```

#### 3. 配置环境变量（可选）
在 `server` 目录下创建 `.env` 文件：
```bash
cd server
cat > .env << 'EOF'
# Supabase配置（可选，如不配置将使用内存存储）
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# Coze AI配置（可选）
COZE_API_KEY=your_coze_api_key
COZE_API_BASE=https://api.coze.com
COZE_BOT_ID=your_bot_id

# 服务器配置
PORT=5100
EOF
cd ..
```

#### 4. 启动服务
只需一条命令即可同时启动前端和后端服务：
```bash
pnpm dev
```
> 服务默认运行在 [http://localhost:5100](http://localhost:5100)

### 目录结构说明
```
.
├── src/                # 前端源代码 (Next.js)
│   ├── app/            # 页面路由
│   ├── components/     # UI 组件
│   └── lib/            # 前端工具库
├── server/             # 后端源代码 (Express)
│   ├── src/
│   │   ├── game-engine.ts # 核心游戏逻辑
│   │   ├── index.ts       # 服务入口 (Express + Next.js handler)
│   │   └── websocket-handler.ts # WebSocket 处理
│   └── package.json    # 后端依赖
├── scripts/            # 启动脚本
└── package.json        # 项目配置
```

## 🛠️ 部署说明 (Coze)

本项目配置为单体应用部署模式。在部署时，`server/src/index.ts` 会作为入口文件，它不仅提供 API 和 WebSocket 服务，还会通过 `next.getRequestHandler()` 来处理所有的页面请求。

**请勿尝试将 `src` 和 `server` 拆分为两个服务部署。**
