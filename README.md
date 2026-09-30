# amos111：Quick Come
Quick Come 的官网、线上开户（KYB）和稳定币收付款（TRON USDT）。本仓库由四个角色协作产出：产品经理、研发工程师、测试工程师、运维工程师，规则见 `dollar3651314/agents` 仓库。

## 从这里开始
| 想了解 | 看 |
|---|---|
| 项目现在是什么样、代码怎么分层、环境、不能破坏的约定、常用命令 | 《[项目地图](项目地图.md)》 |
| 某个文件、接口、页面、数据表、环境变量、测试、历史问题、文档在哪里 | 《[项目索引](项目索引.md)》 |
| 当前状态和遗留事项 | 《[v6 交付说明](交付记录/v6-交付说明.md)》 |
| 给编程智能体的入口 | `CLAUDE.md`（Claude Code）、`AGENTS.md`（其他智能体） |

## 地址
| 环境 | 地址 |
|---|---|
| 生产 | https://amos111.vercel.app/ |
| 测试环境（`staging` 分支，Nile 测试网，有访问保护） | https://amos111-git-staging-jeffzhaifei-3827s-projects.vercel.app/ |

## 常用命令
```bash
npm ci && (cd site && npm ci) && (cd e2e && npm ci)   # 安装
npm test                                              # 单元测试（含项目索引的检查）
cd site && npm run build                              # 构建页面
cd e2e && npx playwright test                         # 端到端测试
npm run dev:local                                     # 本地运行 http://127.0.0.1:8080
```
