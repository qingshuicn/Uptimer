<div align="center">

# Uptimer

**基于 Cloudflare 边缘网络的 Serverless 可用性监控与状态页**

[![CI](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml)
[![Deploy](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

监控你的服务，向访客展示实时状态，并在服务异常时发送通知 — 全部运行在 Cloudflare Workers + Pages + D1 上，零运维。

[快速开始](#快速开始) · [部署](#部署到-cloudflare) · [文档](#文档) · [贡献指南](CONTRIBUTING.zh-CN.md)

**[English](README.md)** | 中文

</div>

---

## 为什么选择 Uptimer？

- **零运维** — 无需管理服务器、容器或数据库。完全运行在 Cloudflare 的免费/付费套餐上。
- **边缘原生** — 监控探针从 Cloudflare Workers 发起，状态页由 CDN 边缘节点分发。
- **一键部署** — 推送到 `main` 分支，GitHub Actions 自动完成：D1 迁移、Worker 部署、Pages 构建。
- **功能完整** — HTTP/TCP 探测、事件管理、维护窗口、Webhook 通知、管理后台。

## 功能特性

**监控**
- HTTP(S) 探测，支持自定义 Headers、Body、状态码与关键词断言
- TCP 端口连通性检测
- 可配置的超时、重试阈值与抖动控制
- 自动状态机：UP / DOWN / MAINTENANCE / PAUSED / UNKNOWN

**状态页**
- 面向公众的状态页，实时展示聚合状态
- 每个监控项的可用率百分比与延迟图表
- 当前活跃的事件与维护窗口
- 多语言支持（en、zh-CN、zh-TW、ja、es）

**事件管理**
- 创建、更新、解决事件，附带时间线
- 计划维护窗口
- 所有事件在公共状态页可见

**通知**
- Webhook 通知至 Discord、Slack、ntfy 或任意 HTTP 端点
- 可自定义的消息与 Payload 模板，支持魔法变量
- 可选的 HMAC-SHA256 签名验证
- 幂等投递与去重

**管理后台**
- 监控项 CRUD 与实时状态概览
- 通知渠道管理，支持测试按钮
- 分析面板，含可用率/延迟图表与 CSV 导出
- 系统设置（站点标题、时区、阈值、数据保留）

## 架构

```
                ┌──────────────────────────────────────────┐
                │            Cloudflare Network            │
                │                                          │
Visitors ──────►│  Pages (React SPA)                       │
                │      │                                   │
                │      ▼                                   │
Admin ─────────►│  Workers (Hono API)                      │
                │      │              │                    │
                │      ▼              ▼                    │
                │    D1 DB      Cron Triggers              │
                │              (scheduled probes)          │
                │                     │                    │
                └─────────────────────┼────────────────────┘
                                      │
                                      ▼
                           Target Services (HTTP/TCP)
                                      │
                                      ▼
                              Webhooks ──► Discord / Slack / ntfy
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts |
| 后端 | Cloudflare Workers, Hono, Zod |
| 数据库 | Cloudflare D1 (SQLite), Drizzle ORM |
| 托管 | Cloudflare Pages（前端）、Workers（API） |
| CI/CD | GitHub Actions |
| 包管理 | pnpm（monorepo） |

## 快速开始

### 前置要求

- Node.js >= 22.14.0
- pnpm >= 10.8.1

### 本地开发

```bash
# 1. 克隆并安装依赖
git clone https://github.com/VrianCao/Uptimer.git
cd Uptimer
pnpm install

# 2. 配置本地密钥
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# 编辑 .dev.vars，设置 ADMIN_TOKEN=your-secret-token

# 3. 一键初始化并启动开发服务器
pnpm dev
```

默认地址：
- **状态页**：http://localhost:5173
- **管理后台**：http://localhost:5173/admin
- **API**：http://localhost:8787/api/v1

> 完整的本地开发指南（种子数据、API 测试、常见问题）请参阅 [Develop/LOCAL-TESTING.md](Develop/LOCAL-TESTING.md)。

## 部署到 Cloudflare

最快的部署方式是通过 GitHub Actions — 推送到 `main`/`master` 分支，内置的工作流会自动完成所有操作。

### 最小配置

1. **添加仓库密钥**：`CLOUDFLARE_API_TOKEN`
2. **添加仓库密钥**：`UPTIMER_ADMIN_TOKEN`（管理面板访问密钥）
3. **推荐密钥**：`CLOUDFLARE_ACCOUNT_ID`
4. **推送到 `main`**（或手动触发 Deploy 工作流）

工作流会自动：
- 创建/迁移 D1 数据库
- 部署 Worker 与 Cron 触发器
- 构建并部署 Pages 前端
- 注入密钥（ADMIN_TOKEN）

> 详细的配置选项、自定义命名与故障排除请参阅[部署指南](docs/deploy-github-actions.zh-CN.md)。

### 部署后验证

```bash
# 公开状态 API
curl https://your-worker.workers.dev/api/v1/public/status

# 管理 API（替换 token）
curl https://your-worker.workers.dev/api/v1/admin/monitors \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## 文档

| 文档 | 说明 |
|------|------|
| [部署指南](docs/deploy-github-actions.zh-CN.md) | GitHub Actions 部署完整流程 |
| [配置参考](docs/configuration-reference.zh-CN.md) | 所有可配置参数（密钥、变量、设置） |
| [通知系统](docs/notifications.zh-CN.md) | Webhook 配置、模板、签名、故障排除 |
| [本地开发](Develop/LOCAL-TESTING.md) | 本地环境搭建、种子数据、测试流程 |

## 质量检查

```bash
pnpm lint          # ESLint 全包检查
pnpm typecheck     # TypeScript 严格类型检查
pnpm test          # 单元测试
pnpm format:check  # Prettier 格式检查
```

## 贡献

欢迎贡献！请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) 了解详情。

## 许可证

本项目基于 MIT 许可证开源 — 详见 [LICENSE](LICENSE) 文件。

---

<div align="center">

基于 [Cloudflare Workers](https://workers.cloudflare.com/) + [Hono](https://hono.dev/) + [React](https://react.dev/) 构建

</div>
