# artoo opportunities

> 调研日期：2026-06-11  
> 项目代号：`artoo`，取意 Star Wars 中的 R2-D2。  
> 文档目标：梳理与 artoo 相关的成熟开源项目、能力边界和市场空白，为后续 `design.md` 提供可直接展开的产品定位、架构对象、MVP 路线和风险判断。

## 0. Reading guide

本调研按 artoo 的四个核心功能域展开：Computer/Agent 管理、IM 协作、Scrum Dashboard、Skill/协作治理。项目筛选优先考虑 GitHub 上可访问、开源、活跃或在社区中有明确影响力的项目；部分概念接近但开源基座有限的项目会被标注为“参照”，不作为可直接复用的技术底座。

后续阅读建议：

- 如果要先确定产品定位，读第 1、4、5、6、14 节。
- 如果要写 `design.md`，读第 2、7、8、11、12 节。
- 如果要评估复用或集成，读第 3、13、Appendix A。
- 如果要控制范围，读第 8、10、11 节。

## 1. Executive summary

artoo 最值得争取的位置不是“又一个 AI coding agent”、也不是“又一个通用 IM”，而是一个 **open-source agent team operating system**：

- **Computer control plane**：统一连接多台 Computer，发现每台机器上的 agent runtime、资源、权限和健康状态，并把任务分配到最合适的机器与 agent 实例。
- **Agent-native IM**：把用户和 Agent 都建模为同等的 actor，支持私聊、群聊、任务房间、状态、@mention、审批、handoff 和可审计消息流。
- **Scrum dashboard**：把 backlog、sprint、task、artifact、approval 和 agent run 串起来，让 iOS/Web 客户端既能聊天，也能创建、分发、暂停、验收任务。
- **Skill governance**：用统一的 skill manifest 管理技能、工具、权限、版本、兼容 agent、输入输出 schema、评测样例和启停策略。
- **Collaboration protocol**：Agent 之间不是隐藏在黑箱里“互相调用”，而是在可读、可追踪、可重放的协作空间中完成拆解、执行、评审、交接和升级。

当前成熟项目大多只覆盖其中一块：OpenHands、SWE-agent、Codex CLI、Cline、Roo Code、aider 偏 coding agent；browser-use、Agent-S、Cua、Bytebot 偏 browser/desktop/computer use；AutoGen、LangGraph、CrewAI、CAMEL、Agno、Mastra 偏 multi-agent framework；Mattermost、Rocket.Chat、Matrix、Zulip 偏通用 IM；Plane、OpenProject、AppFlowy、Taiga、Wekan 偏项目管理；MCP、Composio、Dify、n8n、Flowise 偏工具/集成/工作流。**机会在于把这些能力用一个统一的任务与协作控制平面连接起来。**

## 2. artoo 的问题定义

artoo 面向的是一个越来越常见但目前还没有被很好产品化的场景：

1. 一个团队或个人拥有多台机器：本机、工作站、云主机、CI runner、浏览器沙箱、macOS/Windows 桌面、GPU 节点。
2. 每台机器上可以运行多类 agent：Claude Code、Codex、OpenHands、Hermes、OpenClaw、browser-use、aider、Cline/Roo Code、自研 agent。
3. 每类 agent 可以有多个实例：不同模型、不同权限、不同 workspace、不同任务队列、不同成本/速度偏好。
4. 用户希望用 IM 和 Dashboard 管理这些 agent，而不是在很多终端、Web UI、Slack bot、GitHub issue、project board 之间来回切换。
5. Agent 之间需要协作：拆任务、分派、互相 review、共享上下文、请求帮助、交接、升级给人类。
6. 系统需要知道“谁能做什么、在哪台机器上做、用了什么权限、产出了什么、什么时候需要用户审批”。

因此，artoo 的核心抽象不是单个 agent，而是：

- **Actor**：User 或 Agent。
- **Computer**：可连接、可调度、可观测的计算节点。
- **Agent runtime**：某一类 agent 的适配器与运行环境。
- **Agent instance**：在某台 Computer 上运行的一个具体 agent 实例。
- **Task**：可进入 Scrum 流程、可分配给 User/Agent、可追踪产物和状态的工作单元。
- **Room**：围绕人、agent、task、sprint、project 建立的 IM 协作空间。
- **Skill**：可声明能力、权限、输入输出、兼容 runtime 和评测方式的能力包。
- **Run**：一次 agent 执行过程，包含日志、消息、工具调用、资源消耗、审批点和 artifact。

## 3. Open-source landscape

本节只列与 artoo 直接相关、可作为设计参照或集成候选的开源项目。成熟度综合考虑 GitHub 活跃度、star/fork、产品完整性、社区采用度和与 artoo 目标的贴合度；star 仅作为参考，不能单独代表技术质量。

### 3.1 用户点名的参照项目

| Project | 方向 | 与 artoo 的关系 | 局限 / 给 artoo 的机会 |
| --- | --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | Local-first personal AI assistant、computer-use、Telegram/Web UI | 与“连接 Computer、让 agent 替用户操作电脑”的方向高度接近；很适合作为 Computer node 与 personal assistant 体验的参照 | 更偏单人 personal assistant；artoo 可以向多 Computer、多 agent、多实例、团队协作、任务调度扩展 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Agentic gateway / data access / tool gateway | 可以作为“agent 访问本地数据或结构化资源”的参考 | 不是完整的 team operating system；artoo 可以把 gateway 能力纳入 skill/tool 层，而不是把它当作核心产品 |
| [Slock](https://gogo.build/) | Agent collaboration / AI team workspace 概念 | 概念上接近“人类和 AI agents 在频道、DM、状态中协作” | 公开开源基座有限；artoo 的机会是做一个真正开源、可自托管、可连接本地 Computer 和各类 agent 的实现 |
| [Clawith](https://github.com/dataelement/Clawith) | Multi-agent / computer-use 相关平台 | 与 OpenClaw 同类，可观察其任务界面、agent 调度和本地能力边界 | 仍需验证生态与扩展性；artoo 可以在协议、IM 和 dashboard 一体化上拉开差异 |
| [Multica](https://github.com/multica-ai/multica) | AI agent / automation platform | 可作为 agent automation 产品形态参考 | 若偏封闭 workflow，artoo 应强化跨 agent runtime 的开放适配 |
| [HiClaw](https://github.com/agentscope-ai/HiClaw) | AgentScope 生态下的人机协作/agent UI | 对多 agent 可视化和人机协同有参考价值 | artoo 需要更重视 Computer 资源、IM 协议、Scrum 任务和技能生命周期 |

### 3.2 Computer-use、desktop/browser agent 与 agent runtime

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [browser-use](https://github.com/browser-use/browser-use) | 高 | 让 AI agent 操作浏览器、执行网页任务 | 可作为 browser runtime adapter 或 browser task executor | 不负责多机器调度、IM、Scrum、技能治理 |
| [Agent-S](https://github.com/simular-ai/Agent-S) | 中高 | 图形界面/OS 操作 agent，强调 GUI automation | 可用于 desktop computer-use benchmark 和 runtime 适配 | 更像单 agent 能力，不是团队控制平面 |
| [Cua](https://github.com/trycua/cua) | 中高 | Computer-use agent、sandbox/virtual computer 方向 | 可作为安全执行环境或远程 Computer 抽象的参考 | 需要与 artoo 的任务、权限、消息和调度系统整合 |
| [Bytebot](https://github.com/bytebot-ai/bytebot) | 中 | Self-hosted desktop agent / remote computer automation | 与“连接 Computer 并控制桌面”高度相关 | 项目活跃度和长期生态需验证；artoo 应做成多 runtime 编排层 |
| [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) | 高 | 本地自然语言执行代码和系统操作 | 可作为本地执行 agent 或 shell/code runtime | 权限、审计、团队协作和多节点调度不是核心 |
| [Daytona](https://github.com/daytonaio/daytona) | 高 | 开发环境、workspace、sandbox 管理 | 可作为 dev workspace provider 或 Computer sandbox provider | 不负责 agent-native IM 与多 agent 协作 |
| [E2B](https://github.com/e2b-dev/E2B) | 中高 | AI agent sandbox、代码执行环境 | 可作为 cloud sandbox provider | 与本地 Computer、iOS 控制、IM 协作需要上层产品连接 |

**结论**：computer-use 生态正在成熟，但大多数项目是“让一个 agent 操作一个环境”。artoo 应该做“很多 agent 在很多 Computer 上被统一发现、授权、调度、观察和协作”。

### 3.3 Coding agent、software engineering agent

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 高 | 端到端软件开发 agent、任务执行、浏览器/终端/编辑器环境 | 可作为首批 managed agent runtime；学习其 workspace、event stream、任务 UI | 自身是一个 agent 平台，不是跨 OpenHands/Codex/Claude/aider 的统一调度器 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) / [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 高 | GitHub issue/bug 修复、benchmark 驱动的软件工程 agent | 可作为 benchmark、coding task runtime 和评测参考 | 协作、IM、iOS、资源调度不是重点 |
| [Codex CLI](https://github.com/openai/codex) | 高 | 终端 coding agent、repo 内开发、patch/test 工作流 | artoo 可做 Codex adapter：创建实例、注入任务、读取状态、接管 approval | CLI 原生不提供团队 dashboard 和多实例调度 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 高 | 开源 terminal AI agent | 可作为多模型、多 vendor coding runtime 的代表 | 与其他 agent 的统一身份、消息和调度需外层实现 |
| [Cline](https://github.com/cline/cline) | 高 | VS Code 内 autonomous coding agent | 适合作为 IDE-side agent runtime 或用户本机 agent | 与服务器侧调度、IM 和 Scrum 状态需要桥接 |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | 高 | VS Code agent、模式/角色化 coding workflow | 适合研究 agent mode、权限审批和 IDE UX | 多 Computer、多 agent 实例管理需要 artoo 补齐 |
| [aider](https://github.com/Aider-AI/aider) | 高 | Git-native pair programming agent | 可作为轻量 coding runtime；适合快速 patch/review 类型任务 | 缺少原生 team operating system 形态 |

**结论**：coding agent 足够多，artoo 不应该从零做“最聪明的 coding agent”。更好的入口是把成熟 coding agents 接入同一个任务、消息、权限和调度系统。

### 3.4 Multi-agent framework 与 agent app framework

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [AutoGen](https://github.com/microsoft/autogen) | 高 | 多 agent 对话、agent app、distributed runtime | 可作为 agent collaboration protocol 的参考，也可适配部分 runtime | 更偏开发框架；用户级 IM/Dashboard/Computer fleet 管理需另做 |
| [AG2](https://github.com/ag2ai/ag2) | 中高 | AutoGen 社区延续/多 agent framework | 可观察 community-driven multi-agent API | 与 artoo 的产品控制平面不同层 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 高 | 有状态 agent workflow、graph、durability | 可作为复杂 task orchestration engine 或 inspiration | 不是 IM，也不负责多机器资源调度 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 高 | Role-based multi-agent crew、任务拆分 | 可借鉴 role、crew、task delegation | Agent 协作偏代码配置，不是实时 IM/team workspace |
| [CAMEL](https://github.com/camel-ai/camel) | 中高 | 多 agent 研究与协作框架 | 可作为 agent society、role-play、benchmark 参考 | 产品化控制台和 Computer 管理不足 |
| [Agno](https://github.com/agno-agi/agno) | 高 | Agent framework、tools、memory、multimodal | 可作为 agent runtime SDK 或 skill/tool 设计参考 | artoo 仍需做跨框架适配和团队操作层 |
| [Mastra](https://github.com/mastra-ai/mastra) | 中高 | TypeScript agent framework、workflow、memory/evals | 对 Node/TS 技术栈很友好，可借鉴 workflow/eval 结构 | 不替代 IM、Computer 和 Scrum control plane |
| [VoltAgent](https://github.com/VoltAgent/voltagent) | 中高 | TypeScript agent framework、observability、workflow | 可借鉴 dev experience、agent observability | 仍是 framework，不是 agent team OS |

**结论**：artoo 应该把这些项目视为“agent runtime/framework adapter”的对象，而不是竞争着再造一套底层多 agent 框架。核心价值在跨框架互操作、可视化协作和任务治理。

### 3.5 IM、协作与人机消息系统

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [Mattermost](https://github.com/mattermost/mattermost) | 高 | 开源团队聊天、频道、用户、通知、集成 | 可作为通用 IM 参照；也可做早期 bridge/plugin | Agent 不是一等 actor；task/run/skill/approval 需要深度定制 |
| [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat) | 高 | 开源团队沟通、omnichannel、应用集成 | 可参考 server/client 架构、bot/app ecosystem | 若直接复用，artoo 容易变成“聊天工具插件” |
| [Matrix Synapse](https://github.com/element-hq/synapse) + [Element Web](https://github.com/element-hq/element-web) | 高 | 去中心化 IM 协议、房间、端到端加密、丰富客户端 | 适合研究协议、presence、room event、bridge | Matrix 复杂度高；Agent task state 与 Computer state 仍需上层 schema |
| [Zulip](https://github.com/zulip/zulip) | 高 | topic-based team chat，适合结构化讨论 | topic 模式很适合 task room / sprint room | Agent runtime 与 Computer 管理不是其目标 |
| [Tinode](https://github.com/tinode/chat) | 中高 | 轻量 self-hosted chat server/client | 可作为轻量 IM 技术参照 | 需要补 agent-native task/run/approval/skill model |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 高 | Omnichannel customer messaging | 可借鉴 inbox、assignment、conversation lifecycle | 面向客服，不是 agent team collaboration |
| [agent-slack](https://github.com/stablyai/agent-slack) | 中 | AI agents 与 Slack 风格协作 | 可作为 bridge/agent room 参考 | 更像某个 IM 的 agent 接入层，不是完整自托管系统 |

**结论**：IM 是 artoo 的核心入口，但不应只克隆 Slack。artoo 的 IM 应该是 **event bus + conversation UI + task control surface**：消息既是沟通记录，也是任务状态、审批、产物、handoff、agent event 的统一载体。

### 3.6 Dashboard、Scrum、项目管理

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [Plane](https://github.com/makeplane/plane) | 高 | 开源 issue/project/sprint/roadmap 平台 | Scrum dashboard、issue model、workspace UX 的强参照 | Agent 不是原生 assignee；没有 Computer/agent runtime 调度 |
| [OpenProject](https://github.com/opf/openproject) | 高 | 项目管理、roadmap、work package、enterprise process | 权限、项目结构、审计、portfolio 管理值得学习 | 复杂且传统；需要 agent-native 简化路径 |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) | 高 | 开源 Notion-like workspace、database、kanban | 可借鉴 workspace、block/database、跨端体验 | 任务和 agent run 的强关联需要 artoo 自己定义 |
| [Taiga](https://github.com/taigaio/taiga-back) | 中高 | Agile/Scrum/Kanban | backlog/sprint/kanban 的经典参考 | 传统人类团队项目管理，缺 agent 调度 |
| [Wekan](https://github.com/wekan/wekan) | 中高 | Trello-like Kanban | 简洁 kanban 模式参考 | 不覆盖 agent、IM、Computer |
| [Kanboard](https://github.com/kanboard/kanboard) | 中 | 简洁任务看板 | 可参考 lightweight task board | 现代协作和 mobile 体验有限 |
| [Vikunja](https://github.com/go-vikunja/vikunja) | 中 | Todo/project management | 轻量任务与列表组织参考 | Agent 协作不是目标 |
| [Leantime](https://github.com/Leantime/leantime) | 中 | 项目管理、战略/执行连接 | 可参考 project planning 层 | 不具备 agent-native runtime 管理 |
| [Huly](https://github.com/hcengineering/platform) | 中高 | All-in-one team platform | 可观察 issue、chat、documents 一体化趋势 | 通用协作平台，不以 Computer agent fleet 为核心 |

**结论**：Scrum 工具很成熟，但“任务 assignee 可以是一个 agent 实例或 agent team”“任务状态由 agent run 自动推进”“iOS 上能发起、审批、暂停、验收 agent 工作”仍是明显机会。

### 3.7 Tool、skill、workflow、LLM app platform

| Project | 成熟度 | 能力重点 | artoo 可借鉴 / 集成点 | 空白 |
| --- | --- | --- | --- | --- |
| [Model Context Protocol servers](https://github.com/modelcontextprotocol/servers) | 高 | 标准化 tools/resources/prompts 连接 | artoo skill/tool 层应优先兼容 MCP | MCP 解决工具连接，不解决任务、IM、调度、协作治理 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) / [Python SDK](https://github.com/modelcontextprotocol/python-sdk) | 高 | MCP server/client SDK | 适合作为 skill adapter 的标准接口 | 需要 artoo 定义上层 skill lifecycle |
| [Composio](https://github.com/ComposioHQ/composio) | 高 | 大量 SaaS/API tool integrations for agents | 可作为外部工具集成或 inspiration | 不是 Computer/IM/Scrum control plane |
| [Dify](https://github.com/langgenius/dify) | 高 | LLM app platform、workflow、RAG、agent | 可借鉴 app/workflow marketplace、dataset、运营后台 | 更偏 LLM 应用构建；多 Computer 和 agent-native IM 不是核心 |
| [n8n](https://github.com/n8n-io/n8n) | 高 | Workflow automation、integrations | 可作为 automation backend 或 bridge | Workflow 节点不是 agent team OS |
| [Flowise](https://github.com/FlowiseAI/Flowise) | 高 | Low-code LLM workflow | 可借鉴可视化 agent flow | 缺少多 Computer 资源治理 |
| [Langflow](https://github.com/langflow-ai/langflow) | 高 | Visual agent/workflow builder | 可作为 skill/workflow authoring 参考 | 与 IM、Scrum、Computer 调度割裂 |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 高 | Self-hosted AI workspace、RAG、agents | 可参考 workspace、documents、chat UX | 不是多 agent fleet management |
| [Open WebUI](https://github.com/open-webui/open-webui) | 高 | Self-hosted LLM chat UI、tools、pipelines | 可参考 chat/workspace/provider 管理 | Agent 与 task/dashboard/Computer 的统一较弱 |
| [AGENTS.lock](https://github.com/luml-ai/AGENTS.lock) | 早期 | Agent dependency / lockfile idea | 可作为 skill/version/compatibility lock 的灵感 | 生态早期；artoo 可定义更完整的 skill manifest |
| [Agent Vault](https://github.com/botiverse/agent-vault) | 早期 | Agent/skill registry 概念 | 可参考 registry/marketplace 思路 | 需要更强权限、评测、兼容性和审计模型 |

**结论**：MCP 和工具平台解决的是“agent 能调用什么”。artoo 还需要回答“谁被允许调用、在什么任务中调用、在哪台机器上调用、结果如何进入 IM 与 Dashboard、失败如何交接给其他 agent 或人类”。

### 3.8 Capability coverage matrix

| 项目类型 | 多 Computer 管理 | 多 agent 实例 | Agent-native IM | Scrum/task dashboard | Skill governance | iOS 控制 | artoo 机会 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Personal computer-use assistant | Partial | Partial | Partial | No | Partial | Partial | 从个人助手升级为团队级控制平面 |
| Coding agent | No | Partial | No | Partial | Partial | No | 作为 runtime 接入，统一任务、权限、日志和调度 |
| Browser/desktop agent | Partial | Partial | No | No | Partial | No | 作为 Computer capability，纳入 scheduler |
| Multi-agent framework | No | Yes | Partial | No | Partial | No | 把代码内协作变成团队可见协作协议 |
| 通用 IM | No | Bot-only | Yes | Partial | No | Yes | 让 Agent 成为一等 actor，而不是 bot 插件 |
| Scrum/project management | No | No | Partial | Yes | No | Partial | 让 task assignee 可以是 agent/team，并接入 run event |
| MCP/tool platform | No | Partial | No | No | Partial | No | 把 tool 提升为有权限、评测、版本的 skill |
| Workflow builder | No | Partial | No | Partial | Partial | No | 作为 skill/workflow authoring 参考，而不是核心入口 |

**矩阵结论**：没有一类项目同时覆盖 artoo 的关键组合：多 Computer、多 agent 实例、agent-native IM、Scrum task、skill governance、iOS control。artoo 的机会来自组合创新，而不是单点能力领先。

## 4. 业界格局判断

### 4.1 已经很拥挤的区域

- **单 agent coding 能力**：OpenHands、Codex CLI、Gemini CLI、Cline、Roo Code、aider、SWE-agent 都很强。artoo 不宜把核心差异化押在“再写一个 coding agent”。
- **底层 multi-agent framework**：AutoGen、LangGraph、CrewAI、CAMEL、Agno、Mastra、VoltAgent 已经覆盖大量开发者场景。artoo 不应早期重写一套复杂 framework。
- **通用 IM**：Mattermost、Rocket.Chat、Matrix、Zulip 已有长期积累。artoo 也不应试图先成为通用 Slack/Discord 替代品。
- **传统 Scrum board**：Plane、OpenProject、AppFlowy、Taiga、Wekan 已经足够成熟。artoo 不应把设计重心放在传统 issue tracker 的功能堆叠。
- **工具集成市场**：MCP、Composio、Dify、n8n、Flowise、Langflow 已经很丰富。artoo 应优先兼容，不应重新造所有 connector。

### 4.2 仍然明显缺失的区域

1. **跨 Computer 的 agent fleet control plane**  
   多台机器、多 agent runtime、多实例、多模型、多权限、多 workspace 的统一发现、启动、停止、健康检查、分配和回收。

2. **Agent-native IM，而不是 IM bot**  
   现有方案多是“把 agent 接进 Slack/Telegram/Discord”。artoo 可以让 agent 原生拥有身份、状态、能力、任务、消息、权限和审计轨迹。

3. **任务、聊天、运行日志和产物的一体化**  
   当前很多 agent 工具的 run log 留在自己的 UI/terminal；项目管理工具只看到 issue 状态；IM 里只有讨论。artoo 可以把这些变成同一个事件模型。

4. **Agent skill lifecycle**  
   MCP 解决 tool 连接，但缺少“技能作为可安装、可审核、可版本化、可评测、可授权、可绑定 agent/runtime 的能力包”。

5. **Agent-to-agent collaboration protocol**  
   多 agent 框架常用代码内的对话/graph，而不是面向团队可见的协作协议。artoo 可以定义 agent 在群聊、任务房间、review、handoff 中的可读行为规范。

6. **iOS-first task control**  
   大多数 agent 工具面向桌面开发者。用户真正需要的是在手机上创建任务、看状态、审批权限、语音补充上下文、接收阻塞通知、快速验收。

7. **资源与能力调度**  
   任务分给哪个 agent、哪台 Computer、哪个实例，应该基于能力、成本、速度、队列、数据位置、权限、历史成功率和用户偏好，而不是手动选择一个终端。

## 5. artoo 的机会地图

| Opportunity | Priority | 差异化强度 | MVP 可行性 | 设计复杂度 | 建议 |
| --- | --- | --- | --- | --- | --- |
| Agent fleet control plane | P0 | Very high | Medium | High | 必须作为主线 |
| Agent-native IM | P0 | Very high | Medium | High | 先做 minimal core |
| Scrum dashboard for agent work | P0 | High | High | Medium | 围绕 task/run/approval 做薄 |
| Skill registry and governance | P1 | High | Medium | Medium | 先定义 manifest，再逐步实现 |
| Collaboration protocol | P1 | High | Medium | Medium | 先事件化，再产品化 |
| Observability/replay/audit | P1 | High | Medium | Medium | 从 event store 开始 |
| iOS control surface | P1 | Medium-high | Medium | Medium | 优先 approval/task creation |

P0 的判断标准是：没有它，artoo 会退化成普通 agent UI 或普通 Dashboard。P1 的判断标准是：它会显著提高可信度和长期护城河，但可以在 MVP 闭环跑通后加深。

### Opportunity A：Agent fleet control plane

**优先级：P0**

artoo 可以先定义一套 `artood` node agent：

- 运行在每台 Computer 上，向 control plane 注册。
- 上报 OS、CPU、GPU、RAM、磁盘、网络、workspace、已安装 agent runtime、可用模型、权限状态。
- 支持心跳、远程启动/停止 agent instance、日志流、artifact 上传、资源配额。
- 支持本地权限边界：可读目录、可写目录、可执行命令、可访问浏览器/桌面、可用 secrets。

**潜在差异化**：

- 把 Claude Code、Codex、OpenHands、aider、browser-use、OpenClaw 等看成 adapter，而不是竞品。
- 对用户承诺“把任务交给 artoo，它会找到最合适的 agent 和机器”。
- 资源调度可以从简单规则开始，逐步加入 scoring。

**MVP 建议**：

- 先支持 1 个 control plane + N 个 node。
- 先接 2 类 runtime：terminal coding agent 与 browser/desktop agent。
- 每个 runtime 只需要 `discover / start / stop / status / stream_events / send_input / collect_artifacts`。

### Opportunity B：Agent-native IM server/client

**优先级：P0**

artoo 的 IM 不应只是聊天，而是系统的协作骨架。

核心能力：

- 私聊：User-Agent、Agent-Agent、User-User。
- 群聊：project room、task room、sprint room、agent team room。
- presence：online、busy、running、blocked、awaiting approval、offline。
- message types：text、command、task_update、run_event、artifact、approval_request、approval_result、handoff、incident、system_notice。
- 线程和引用：每个 task/run/artifact 可以被消息引用。
- 审计：所有关键 agent action 都能回到消息和 run trace。

**Build vs reuse 判断**：

- 直接复用 Mattermost/Matrix 能快速拿到通用 IM，但 agent/task/run 的核心模型会被迫做成插件或 bot 消息。
- 从零做完整通用 IM 成本过大。
- 推荐路线：**构建 artoo-native minimal IM core**，只做 agent 协作必需能力；同时预留 Matrix/Mattermost/Slack bridge。

**MVP 建议**：

- WebSocket + Postgres 事件流。
- 1:1、channel、message、presence、typing 可后置。
- iOS push 和 Web push 作为任务阻塞/审批的第一优先级。

### Opportunity C：Scrum dashboard for agent work

**优先级：P0**

artoo 的 Dashboard 应该围绕 agent work 重新解释 Scrum：

- `Project`：项目或产品线。
- `Epic`：大目标。
- `Story/Task`：可分配给 User、Agent、Agent team。
- `Sprint`：时间盒。
- `Board column`：Backlog、Ready、Assigned、Running、Review、Blocked、Done。
- `Acceptance criteria`：Agent 执行前必须理解的验收条件。
- `Run`：任务的一次执行尝试。
- `Artifact`：PR、patch、截图、日志、报告、文件、链接。
- `Approval`：权限、计划、外部操作、merge、发布等需要人确认的节点。

**潜在差异化**：

- 看板状态由 agent events 自动推进。
- 每个 task 默认创建 task room。
- iOS 上创建任务后，scheduler 自动选择 agent/computer。
- 用户在 dashboard 上看到的是“谁正在做、卡在哪里、需要我批准什么、产物能否验收”。

**MVP 建议**：

- 不要先做复杂报表。
- 先做 Project、Task、Board、Task room、Run timeline、Approval inbox。

### Opportunity D：Skill registry and governance

**优先级：P1**

artoo 的 skill 应高于 tool：

- Tool：可调用接口，例如 MCP server、HTTP API、CLI、browser action。
- Skill：面向任务的能力包，包含说明、输入输出、权限、示例、评测、兼容 runtime、策略和回滚。

建议的 `skill.yaml`：

```yaml
id: github.pr-review
name: GitHub PR Review
version: 0.1.0
owner: artoo
capabilities:
  - code.review
  - github.comment
compatible_runtimes:
  - codex
  - openhands
  - aider
inputs:
  schema: ./schemas/input.json
outputs:
  schema: ./schemas/output.json
permissions:
  filesystem:
    read: ["workspace"]
    write: ["workspace"]
  network:
    allow: ["github.com"]
  secrets:
    required: ["GITHUB_TOKEN"]
approval:
  required_for:
    - post_comment
    - push_branch
evals:
  - ./evals/pr-review-smoke.yaml
examples:
  - ./examples/basic.md
```

**潜在差异化**：

- 同一个 skill 可以绑定不同 agent runtime。
- skill 有启用范围：organization、project、agent、computer。
- skill 有能力标签，可被 scheduler 用于任务匹配。
- skill 有权限声明，可被 policy engine 审核。

### Opportunity E：Collaboration protocol

**优先级：P1**

artoo 需要让 agent 协作可读、可控、可审计。

建议定义以下协作事件：

- `task.claimed`：某 actor 接受任务。
- `task.decomposed`：拆分子任务。
- `agent.question`：agent 向用户或其他 agent 提问。
- `agent.proposal`：agent 提交计划。
- `approval.requested`：请求授权。
- `run.started / run.paused / run.failed / run.completed`。
- `handoff.requested / handoff.accepted`。
- `review.requested / review.completed`。
- `artifact.produced`。

协作原则：

- Agent 之间可以私聊，但与任务相关的关键决策必须同步到 task room。
- Agent 可以调用其他 agent，但应留下 handoff 或 delegation event。
- 用户应能在 iOS/Web 上看到“为什么这个 agent 被选中、它做了什么、什么时候卡住”。

### Opportunity F：Observability, replay and audit

**优先级：P1**

Agent 系统的失败通常不是“没有日志”，而是日志分散在 CLI、browser、server、IM、issue tracker。artoo 可以统一：

- run timeline。
- tool call trace。
- message trace。
- resource usage。
- cost estimate。
- artifact diff。
- approval history。
- failure reason。
- replay bundle。

这会直接支撑团队信任和企业采用。

### Opportunity G：iOS control surface

**优先级：P1**

iOS 客户端不是附属 chat client，而是 agent work 的遥控器：

- 快速创建任务：文字、语音、截图、链接、文件。
- 选择项目/sprint/优先级。
- 选择“自动分配”或指定 agent/team。
- 接收 approval/blocker push。
- 查看 task room 和 run timeline。
- 一键批准、拒绝、暂停、重试、转交。
- 验收 artifact。

早期 iOS 可以很薄，但 approval inbox 和 task creation 应该一开始就设计进去。

## 6. 推荐产品定位

### 一句话

**artoo is an open-source control plane where humans and AI agents collaborate through chat, tasks, skills and managed computers.**

### 中文定位

artoo 是一个开源 AI Agent 团队操作系统：它连接多台 Computer，管理多类 Agent 与多个实例，用 IM 和 Scrum Dashboard 组织人和 Agent 的协作，并通过技能、权限、调度和审计让任务更快、更可靠地完成。

### 不建议的定位

- 不要定位成“最强 AI coding agent”。
- 不要定位成“开源 Slack”。
- 不要定位成“低代码 AI workflow builder”。
- 不要定位成“另一个 MCP server 列表”。
- 不要定位成“只能给个人用的本地 assistant”。

### 建议的开源叙事

- 开发者可以把现有 agent 接入 artoo，而不是替换它们。
- 团队可以自托管，不把源码、桌面、secrets 和 agent logs 交给封闭 SaaS。
- 用户可以在手机上控制长时间运行的 agent 工作流。
- Agent 协作是可见、可审计、可回放的。

## 7. 设计含义：后续 design.md 应展开的核心模块

### 7.1 Control plane

职责：

- Organization、Project、User、Agent identity。
- Computer registry。
- Agent runtime registry。
- Agent instance lifecycle。
- Task scheduler。
- Policy/permission。
- Event store。

关键 API：

- `RegisterComputer`
- `Heartbeat`
- `ListCapabilities`
- `StartAgentInstance`
- `StopAgentInstance`
- `AssignTask`
- `StreamRunEvents`
- `RequestApproval`

### 7.2 Node agent (`artood`)

职责：

- 运行在每台 Computer 上。
- 收集资源和 runtime 信息。
- 执行 control plane 下发的启动/停止/输入/文件收集命令。
- 在本地执行权限边界。
- 把 run event、stdout/stderr、screenshots、artifacts 回传。

需要重点设计：

- 安全握手和 node token。
- workspace sandbox。
- secrets 注入。
- command allowlist/denylist。
- crash recovery。
- offline queue。

### 7.3 Runtime adapter

每个 agent runtime 应实现统一接口：

- `detect()`
- `install_status()`
- `start(instance_config)`
- `send(message_or_task)`
- `stream_events()`
- `pause()`
- `resume()`
- `stop()`
- `collect_artifacts()`

首批 adapter 建议：

- `codex`
- `claude-code`
- `openhands`
- `aider`
- `browser-use`
- `openclaw`

### 7.4 IM service

核心表/对象：

- `actor`
- `room`
- `room_member`
- `message`
- `message_event`
- `presence`
- `attachment`
- `mention`
- `approval`

消息协议要能表达：

- 普通文字。
- Task state update。
- Run event。
- Approval request/result。
- Artifact。
- Handoff。
- System notice。

### 7.5 Task and Scrum service

核心表/对象：

- `project`
- `epic`
- `sprint`
- `task`
- `task_dependency`
- `task_assignment`
- `task_status_history`
- `acceptance_criteria`
- `run`
- `artifact`

关键设计：

- task assignee 可以是 User、Agent、Agent team。
- task 与 room 一一或多对一关联。
- task state 由人工操作和 run event 共同驱动。
- 每个 run 都能回到 scheduler decision 和 Computer/Agent instance。

### 7.6 Skill registry

核心对象：

- `skill`
- `skill_version`
- `skill_capability`
- `skill_runtime_compatibility`
- `skill_permission`
- `skill_eval`
- `skill_installation`
- `skill_policy`

关键设计：

- 兼容 MCP，但不止于 MCP。
- skill 与 agent/runtime/computer/project/org 绑定。
- 权限与 approval policy 是 skill 的一部分。
- skill 可被 scheduler 用来匹配任务。

### 7.7 Scheduler

最初可以是 rule-based：

```text
score = capability_match
      + runtime_availability
      + computer_health
      + queue_depth
      + data_locality
      + user_preference
      + historical_success
      - estimated_cost
      - permission_risk
```

MVP 只需实现：

- capability match。
- idle instance 优先。
- project preferred computer。
- 手动 override。

后续再加入：

- warm pool。
- model routing。
- cost-aware routing。
- retry/hedging。
- multi-agent decomposition。

## 8. MVP 路线建议

### Phase 0：协议和骨架

目标：让 artoo 的核心对象站起来。

- Control plane API。
- `artood` node 注册和心跳。
- Computer 列表。
- Agent runtime registry。
- 简单 task model。
- 简单 event store。

成功标准：

- 能看到一台 Computer 在线。
- 能看到它支持哪些 agent runtime。
- 能创建一个 task 并进入队列。

### Phase 1：第一个可用 agent loop

目标：从 Dashboard/IM 创建任务，并让一个 agent 在一台 Computer 上执行。

- 接入一个 terminal coding agent runtime。
- task room 自动创建。
- run timeline。
- stdout/stderr/event streaming。
- artifact 收集。
- 用户可暂停/取消。

成功标准：

- 用户在 Web 上创建任务。
- artoo 分配到某个 agent instance。
- agent 执行并回传结果。
- task room 中可看到关键事件。

### Phase 2：Agent-native IM

目标：让 IM 成为协作入口。

- User/Agent actor model。
- DM/channel/task room。
- presence。
- message types。
- approval request/result。
- notification。

成功标准：

- 用户可以在 task room 中和 agent 对话。
- agent 可以在房间里提问、汇报、请求审批。
- Agent-Agent 消息可被审计。

### Phase 3：Scrum dashboard

目标：把任务组织成 Scrum 工作流。

- Project、Sprint、Backlog、Board。
- Task status automation。
- assignee 支持 agent。
- run/artifact/approval 与 task 关联。

成功标准：

- 从 Backlog 到 Done 的任务流完整。
- agent run 能自动推进状态。
- 用户能从 board 进入 task room 和 run timeline。

### Phase 4：Skill registry

目标：让 agent 能力可治理。

- `skill.yaml`。
- skill install/enable/disable。
- permission declaration。
- MCP tool adapter。
- compatibility matrix。

成功标准：

- task 可以声明需要某些 capability。
- scheduler 能根据 capability 选择 agent/runtime。
- 高风险 skill action 会触发 approval。

### Phase 5：iOS control

目标：移动端成为真正的 agent work remote control。

- 创建任务。
- 查看 dashboard。
- task room。
- approval inbox。
- push notification。
- 语音/截图输入。

成功标准：

- 用户可以只用 iPhone 创建、分配、审批和验收一个 agent task。

## 9. 技术路线建议

### Backend

推荐优先考虑：

- TypeScript/Node：适合 IM/WebSocket、agent adapters、MCP TS SDK、前后端共享类型。
- Postgres：任务、消息、事件、权限、状态的主存储。
- Redis：presence、queue、pub/sub、ephemeral state。
- Object storage：artifacts、screenshots、logs bundle。
- gRPC 或 WebSocket：control plane 与 node agent 的双向通信。

如果团队更偏 Go/Rust：

- Node agent 可以用 Go/Rust 做，稳定、易分发、资源占用低。
- Control plane 仍可用 TS 快速迭代。

### Frontend

- Web：Dashboard + IM + Computer/Agent 管理。
- iOS：SwiftUI，聚焦 task creation、approval inbox、task room、run status。
- 不建议第一版做复杂低代码 workflow canvas。

### Protocol

建议所有核心状态都先进入 event store：

- `message.created`
- `task.created`
- `task.assigned`
- `run.started`
- `run.event`
- `approval.requested`
- `artifact.created`
- `presence.updated`

这样 IM、Dashboard、scheduler、audit 都消费同一条事实流。

## 10. 风险与缓解

| Risk | 说明 | 缓解 |
| --- | --- | --- |
| 范围过大 | Computer、IM、Dashboard、Skill、iOS 都很重 | MVP 严格围绕“一个任务从创建到 agent 执行再到验收”闭环 |
| 变成低质量 agent 大杂烩 | 支持很多 runtime 但体验不一致 | 先定义 adapter contract 和 run event schema；每个 runtime 做到可观测、可暂停、可收产物 |
| IM 复杂度失控 | 通用 IM 功能无穷无尽 | 只做 agent work 必需能力；保留 bridge，不追求替代 Slack |
| 安全和权限被低估 | Agent 可操作电脑、代码、secrets | 从第一版引入 permission、approval、workspace sandbox、audit |
| iOS 沦为通知壳 | 只是看消息，不控制任务 | 把 task creation 和 approval inbox 作为 iOS P1，而不是后置 |
| Scheduler 过早复杂 | 一开始就做智能调度会拖慢 | 先 rule-based，保留 scoring 字段 |
| Skill 生态冷启动 | 没有足够技能，平台价值不足 | 先内置 5-10 个高频技能：repo setup、PR review、bugfix、browser research、report writing、screenshot QA |
| 与既有项目竞争叙事不清 | 用户问“为什么不用 OpenHands/Mattermost/Plane” | 明确 artoo 是控制平面，集成这些工具，而不是替代所有工具 |

## 11. 近期最值得做的 10 个设计决策

1. **Actor model**：User 和 Agent 是否完全共享 identity/message/presence 模型。建议共享。
2. **Room model**：task room 是否是一等对象。建议是，并与 task 强关联。
3. **Node protocol**：control plane 与 `artood` 用 WebSocket 还是 gRPC。建议先 WebSocket，方便穿透和事件流。
4. **Runtime adapter contract**：如何统一 CLI agent、Web agent、desktop agent、server agent。建议先定义最小生命周期接口。
5. **Event schema**：IM、task、run、approval 是否共享 event store。建议共享。
6. **Permission model**：权限绑定 User、Agent、Computer、Skill 还是 Task。建议四者共同决定。
7. **Scheduler MVP**：自动调度还是手动分配。建议自动为默认，用户可 override。
8. **IM build/reuse**：是否基于 Matrix/Mattermost。建议 artoo-native minimal core + bridge。
9. **Skill format**：是否从第一版定义 `skill.yaml`。建议定义，但实现可薄。
10. **iOS scope**：第一版做什么。建议 task creation、approval、task room、run status。

## 12. 后续 design.md 建议目录

```text
1. Product vision
2. Core use cases
   2.1 Create task from iOS
   2.2 Assign task to best agent/computer
   2.3 Agent asks for approval in task room
   2.4 Agent-to-agent handoff
   2.5 Review artifact and mark done
3. System architecture
   3.1 Control plane
   3.2 Node agent
   3.3 Runtime adapters
   3.4 IM service
   3.5 Task/Scrum service
   3.6 Skill registry
   3.7 Scheduler
   3.8 Observability and audit
4. Data model
5. Event model
6. Permission and security model
7. Runtime adapter contract
8. Skill manifest
9. API design
10. Web dashboard UX
11. iOS UX
12. MVP implementation plan
13. Open questions
```

## 13. 推荐的首批集成候选

### Agent runtime

- Codex CLI：terminal coding workflow。
- Claude Code：terminal coding workflow。
- OpenHands：完整 software agent platform。
- aider：轻量 Git-based coding agent。
- browser-use：browser automation。
- OpenClaw：local-first computer-use assistant。

### Infrastructure provider

- Daytona：开发环境/workspace 管理。
- E2B：cloud sandbox/code execution。
- Cua：virtual computer / computer-use sandbox。

### Tool ecosystem

- MCP servers：标准 tool/resource/prompt 接入。
- Composio：外部 SaaS/API 集成。
- n8n：workflow bridge。

### Collaboration bridge

- Mattermost：team chat bridge。
- Matrix：federated room/event bridge。
- Slack/Discord/Telegram：只做 bridge，不作为核心依赖。

### Project management import/export

- Plane：issue/project/sprint 模型参考和潜在导入。
- GitHub Issues：开发任务入口。
- Linear/Jira：后续商业团队导入。

## 14. 结论

artoo 最清晰的机会是成为 **Agent 协作的开源控制平面**：

- 向下连接 Computer、runtime、tool、skill。
- 向上提供 IM、Dashboard、iOS。
- 横向打通 User-Agent、Agent-Agent、Task-Agent、Computer-Agent 的关系。
- 用事件、权限、审批、审计和调度把 agent 工作变得可靠。

如果第一版能完成“用户在 iOS/Web 创建任务 -> artoo 自动选择 Computer 和 Agent -> Agent 在 task room 中执行并汇报 -> 用户审批关键操作 -> artifact 可验收 -> task 进入 Done”的闭环，artoo 就已经和多数单点 agent 工具拉开了定位差异。

## 15. Open questions for design.md

这些问题建议在 `design.md` 中显式回答：

1. 第一版是否必须支持自托管多用户，还是先支持单组织单租户。
2. `artood` 是否要求常驻后台服务，还是先允许用户手动启动。
3. Agent runtime adapter 是否运行在 node 侧，还是 control plane 侧。
4. Task room 是否强制创建，还是只在需要讨论时创建。
5. Approval policy 的默认值：偏安全还是偏自动化。
6. Skill manifest 是否从第一版冻结格式，还是标注为 experimental。
7. iOS 第一版是否需要离线能力。
8. 是否优先支持 GitHub workflow：issue、branch、PR、review、merge。
9. 是否内置 Matrix/Mattermost bridge，还是先只做 artoo-native IM。
10. 是否从第一版采集 cost/token/latency 指标，用于后续 scheduler。

## Appendix A. Research source list

### Named references

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Slock](https://gogo.build/)
- [Clawith](https://github.com/dataelement/Clawith)
- [Multica](https://github.com/multica-ai/multica)
- [HiClaw](https://github.com/agentscope-ai/HiClaw)

### Computer-use and runtime

- [browser-use](https://github.com/browser-use/browser-use)
- [Agent-S](https://github.com/simular-ai/Agent-S)
- [Cua](https://github.com/trycua/cua)
- [Bytebot](https://github.com/bytebot-ai/bytebot)
- [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter)
- [Daytona](https://github.com/daytonaio/daytona)
- [E2B](https://github.com/e2b-dev/E2B)

### Coding agents

- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [SWE-agent](https://github.com/SWE-agent/SWE-agent)
- [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
- [Codex CLI](https://github.com/openai/codex)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Cline](https://github.com/cline/cline)
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)
- [aider](https://github.com/Aider-AI/aider)

### Multi-agent framework

- [AutoGen](https://github.com/microsoft/autogen)
- [AG2](https://github.com/ag2ai/ag2)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [CrewAI](https://github.com/crewAIInc/crewAI)
- [CAMEL](https://github.com/camel-ai/camel)
- [Agno](https://github.com/agno-agi/agno)
- [Mastra](https://github.com/mastra-ai/mastra)
- [VoltAgent](https://github.com/VoltAgent/voltagent)

### IM and collaboration

- [Mattermost](https://github.com/mattermost/mattermost)
- [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat)
- [Matrix Synapse](https://github.com/element-hq/synapse)
- [Element Web](https://github.com/element-hq/element-web)
- [Zulip](https://github.com/zulip/zulip)
- [Tinode](https://github.com/tinode/chat)
- [Chatwoot](https://github.com/chatwoot/chatwoot)
- [agent-slack](https://github.com/stablyai/agent-slack)

### Dashboard and project management

- [Plane](https://github.com/makeplane/plane)
- [OpenProject](https://github.com/opf/openproject)
- [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)
- [Taiga](https://github.com/taigaio/taiga-back)
- [Wekan](https://github.com/wekan/wekan)
- [Kanboard](https://github.com/kanboard/kanboard)
- [Vikunja](https://github.com/go-vikunja/vikunja)
- [Leantime](https://github.com/Leantime/leantime)
- [Huly](https://github.com/hcengineering/platform)

### Tool, skill and workflow ecosystem

- [Model Context Protocol servers](https://github.com/modelcontextprotocol/servers)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [Composio](https://github.com/ComposioHQ/composio)
- [Dify](https://github.com/langgenius/dify)
- [n8n](https://github.com/n8n-io/n8n)
- [Flowise](https://github.com/FlowiseAI/Flowise)
- [Langflow](https://github.com/langflow-ai/langflow)
- [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)
- [Open WebUI](https://github.com/open-webui/open-webui)
- [AGENTS.lock](https://github.com/luml-ai/AGENTS.lock)
- [Agent Vault](https://github.com/botiverse/agent-vault)

## Appendix B. 20-round polish checklist

本清单用于约束本文档已满足“可直接推导 design.md”的质量要求。

1. 明确 artoo 不是单 agent，而是 agent team operating system。
2. 覆盖用户点名的 OpenClaw、Hermes、Slock。
3. 单独区分 computer-use、coding agent、multi-agent framework。
4. 单独区分 IM 与 agent-native IM。
5. 单独区分 Dashboard/Scrum 与 agent work dashboard。
6. 单独区分 MCP/tool 与 artoo skill。
7. 给出成熟项目列表，而不是只列趋势词。
8. 每类项目都写出 artoo 的可借鉴点与空白。
9. 把机会按 P0/P1 排序。
10. 明确不建议投入的拥挤区域。
11. 给出 control plane、node agent、runtime adapter 的设计含义。
12. 给出 IM service 的核心对象。
13. 给出 Task/Scrum service 的核心对象。
14. 给出 Skill registry 的 manifest 方向。
15. 给出 Scheduler 的最小 scoring 思路。
16. 给出 iOS 的真实控制场景，而不是只做通知。
17. 给出 MVP phase 路线。
18. 给出风险与缓解策略。
19. 给出后续 `design.md` 目录。
20. 保留 source list，方便后续继续逐项深挖和 license 核验。
