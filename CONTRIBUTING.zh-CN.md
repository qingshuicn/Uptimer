# 贡献指南

[English](CONTRIBUTING.md) | 中文

感谢你对 Uptimer 项目的关注！本指南介绍贡献的基本流程。

## 开发环境搭建

```bash
# 前置要求：Node.js >= 22.14.0、pnpm >= 10.8.1

git clone https://github.com/VrianCao/Uptimer.git
cd Uptimer
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm dev
```

完整的本地开发指南请参阅 [Develop/LOCAL-TESTING.md](Develop/LOCAL-TESTING.md)。

## 提交变更

1. 从 `master` 创建新分支
2. 进行修改，保持变更小而聚焦
3. 确保通过质量检查：
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm format:check
   ```
4. 如果修改了 D1 Schema，必须添加 **新的** migration 文件（不要修改已有的 migration）
5. 提交 Pull Request

## 代码风格

- 所有包均启用 TypeScript strict 模式
- 代码格式由 Prettier 统一管理 — 提交前运行 `pnpm format`
- Lint 规则定义在 `eslint.config.mjs`

## 架构说明

提交变更前，请先阅读以下文档：

- [Develop/Application.md](Develop/Application.md) — 产品规格与技术约束
- [Develop/Structure.md](Develop/Structure.md) — 目录结构与模块边界
- [AGENTS.md](AGENTS.md) — 协作约定

关键约定：

- 所有 API 输入必须使用 Zod 校验
- 所有数据库写入必须使用参数化查询（Drizzle ORM）
- 共享类型放在 `packages/shared`，不要在各 app 中重复定义
- API 路由定义在 `apps/worker/src/routes/`，业务逻辑放在对应的领域模块中

## 提交 Issue

提交 Bug 报告时，请包含：

- 复现步骤
- 期望行为 vs 实际行为
- 相关日志或错误信息
- 部署方式（本地开发 / GitHub Actions / 手动部署）

## Pull Request

- PR 应小而聚焦于单一关注点
- 包含清晰的变更说明（做了什么、为什么）
- 关联相关 Issue
- 确保 CI 通过后再请求 Review
