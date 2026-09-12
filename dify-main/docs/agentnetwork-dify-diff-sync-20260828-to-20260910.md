# AgentNetwork–Dify 版本变更记录

## 1. 比较范围

本文比较以下两个版本：

| 版本 | Git 标识 | 日期 | 说明 |
| --- | --- | --- | --- |
| 上一版 | `sync-20260828` / `c7443ea511e3f2ed9069759a2868b1fec1fa2b61` | 2026-08-28 | GitHub 分支：`https://github.com/SimonHeye/agentnetwork-dify/tree/sync-20260828` |
| 当前最新版 | `deploy-20260910-final-demo1` / `f0ce8407c99c2dee3747508f916f17b4b9cfbcf9` | 2026-09-10 | 本地当前分支 HEAD |

HEAD 之间实际包含两个提交：

1. `730d716`：`feat: sync AgentNetwork workflow updates`（2026-09-06）；
2. `f0ce840`：`feat: finalize Dify Agent Network workflow integration`（2026-09-10）。

提交范围为 Dify 集成仓库 `agentnetwork-dify`。旁边的 `agent-network` 是独立目录/仓库，不在上述 GitHub 分支的文件差异中；本文只记录 Dify 侧与它对接所需的协议和配置变化。

> 本文生成时，本地工作树还有若干未提交变化。已提交版本差异与工作树附加变化分开记录，避免把未部署代码误认为 GitHub 分支内容。

## 2. 变更总览

从 `sync-20260828` 到当前 HEAD：

- 24 个文件发生变化；
- 新增约 662 行，删除约 74 行；
- 新增“意图识别”同源接口及前端展示卡片；
- 规划链路改为“原始任务 → 意图识别 → 规范化任务/附加约束 → AgentNetwork 规划”；
- 规划和执行继续沿用会话 `id`，并完善当前画布来源任务的持久化；
- AgentNetwork 规划/执行默认超时提高到 1 小时，以适应文件生成、联网检索等长任务；
- 补全伪代码与 Dify 画布之间的变量绑定、字段访问、邮件/PPTX/Word 参数恢复；
- 保存 draft 成功后派发前端事件，改善对话面板和工作流面板之间的同步；
- 对话面板层级提高到 `z-60`，工作流右侧面板层级提高到 `z-50`；
- 新增/扩展针对意图、编译器、反向编译器、聊天面板和代理接口的测试。

## 3. 新增的核心业务链路：意图识别

### 3.1 新增接口

文件：

`dify-main/web/app/internal/agent-network/intent/route.ts`

新增同源接口：

```http
POST /internal/agent-network/intent
Content-Type: application/json
```

请求只接收：

```json
{
  "task": "用户原始输入"
}
```

使用 Zod 严格校验：

- `task` 必填；
- 自动去除首尾空格；
- 长度限制为 1–100,000；
- 拒绝额外未知字段；
- 保留同源请求校验。

响应结构：

```json
{
  "normalizedTask": "规范化后的任务描述",
  "extraInstructions": "给规划器的附加约束"
}
```

当前实现是演示用的固定意图结果，内容针对企业投资尽调任务，要求规划依次调用企业查询、搜索、推理、总结、PPTX、Word 和邮件 Group。它不是独立的 AgentNetwork HTTP 服务。

后续接入真实意图识别服务时，应保持这两个字段的契约，替换 `route.ts` 内的固定常量和返回逻辑即可，不需要重写聊天面板的后续规划流程。

### 3.2 前端请求和展示

文件：

- `dify-main/web/features/agent-network-workflow/request-intent.ts`
- `dify-main/web/features/agent-network-workflow/intent-result.tsx`
- `dify-main/web/features/agent-network-workflow/chat-panel.tsx`

`request-intent.ts` 定义：

```ts
type AgentNetworkIntentResult = {
  normalizedTask: string
  extraInstructions: string
}
```

发送流程现在是：

1. 保存用户原始消息；
2. 调用 `/internal/agent-network/intent`；
3. 在对话气泡中显示“正在识别任务意图……”；
4. 显示意图识别后的 `normalizedTask`；
5. 将 `normalizedTask` 和 `extraInstructions` 交给规划接口；
6. 将意图结果保存到 assistant 消息的 `meta.agent_network_intent`。

刷新页面后，`chat-panel.tsx` 会从持久化消息的 `meta` 恢复意图结果。

### 3.3 规划接口的变化

文件：

`dify-main/web/app/internal/agent-network/plan/route.ts`

变化：

- 默认超时从 60 秒提高到 3,600 秒；
- 最大超时从 120 秒提高到 3,600 秒；
- `extraInstructions` 现在直接透传为 AgentNetwork 的 `extra_instructions`；
- 删除该代理中原先硬编码的 Dify 兼容约束拼接。

这意味着当前规划约束的主要来源变为意图识别结果。若以后更换意图服务，必须保证它返回的 `extraInstructions` 包含编译器实际支持的伪代码约束。

规划请求仍包含会话字段：

```json
{
  "appId": "Dify App UUID",
  "id": "conversation UUID",
  "task": "normalizedTask",
  "includeAgents": false,
  "model": "deepseek-chat",
  "extraInstructions": "extraInstructions",
  "existCode": "可选的上一轮伪代码"
}
```

代理转发给 AgentNetwork 时使用：

```json
{
  "id": "conversation UUID",
  "task": "normalizedTask",
  "include_agents": false,
  "model": "deepseek-chat",
  "extra_instructions": "extraInstructions",
  "exist_code": "上一轮伪代码（追问时才有）"
}
```

## 4. Dify 后端持久化变化

### 4.1 应用规划时保存规范化任务

文件：

`dify-main/api/services/agent_network_conversation_service.py`

`mark_message_applied()` 的 `applied_task` 保存逻辑发生变化：

1. 优先从当前 assistant 消息的 `meta.agent_network_intent.normalizedTask` 读取规范化任务；
2. 如果没有意图元数据，则退回原始 user 消息内容；
3. 结果继续写入 `conversation.applied_task`。

这样执行当前画布时，使用的是当初真正交给规划器的规范化任务，而不是可能包含口语化表达的原始输入。

### 4.2 新增“更新消息伪代码”接口

文件：

`dify-main/api/controllers/console/app/agent_network_conversation.py`

新增控制器：`AgentNetworkMessagePseudocodeApi`。

路径：

```http
POST /console/api/apps/{app_id}/agent-network/conversation/messages/{message_id}/pseudocode
```

请求：

```json
{
  "pseudocode": "修改后的伪代码"
}
```

行为：

- 要求登录、初始化和 App 编辑权限；
- 拒绝空伪代码；
- 调用 service 更新指定 assistant 消息；
- 找不到合法消息时返回 `INVALID_AGENT_NETWORK_MESSAGE`。

该接口为后续“在界面直接编辑某轮伪代码后保存”提供后端入口。

### 4.3 对话与画布状态

已有的 conversation/message 表和 `applied_message_id` 机制继续使用，没有新增数据库迁移。

当前语义仍是：

- 一个 tenant + app 对应一个 AgentNetwork conversation；
- 消息历史可以有多轮；
- 当前画布只对应一条 `applied` assistant 消息；
- 新一轮应用成功后，旧 applied 消息改为 `not_applied`；
- 执行结果保存到当前 applied 消息的 `meta.agent_network_execution`。

## 5. 前端对话面板和工作流画布变化

主要文件：

`dify-main/web/features/agent-network-workflow/chat-panel.tsx`

### 5.1 意图识别阶段

assistant 临时消息不再直接只显示“正在规划”，而是先创建 `intentPending` 状态，然后：

- 意图识别完成后显示 `AgentNetworkIntentResultCard`；
- 规划阶段继续显示规划状态；
- 识别结果和规划结果都可以在历史消息中恢复。

### 5.2 历史伪代码查找

原先使用 `findLast()` 查找最近伪代码；当前改为对消息副本倒序查找，避免在目标运行环境中依赖较新的数组 API：

```ts
const previousPseudocode = [...messages].reverse().find(message => ...)
```

追问时仍会把这段伪代码作为 `existCode` 传给规划接口。

### 5.3 执行入口

执行当前画布时，导出伪代码明确使用：

```ts
exportPseudocode({ workflowName: 'agent-network' })
```

这样下载/传输的文件名和执行边界更稳定。执行流程仍是：

1. 强制保存当前 draft；
2. 从最新 ReactFlow graph 反向编译伪代码；
3. 携带当前 conversation `id` 和 `applied_task` 调用执行代理；
4. 将结果保存到 applied assistant 消息。

### 5.4 层级和布局

对话面板：

```tsx
z-60
```

工作流右侧面板：

`dify-main/web/app/components/workflow/panel/index.tsx`

```tsx
z-50
```

目的是让意图卡片、对话面板和工作流配置面板在切换时不被画布层遮挡。

## 6. Draft 保存同步变化

文件：

`dify-main/web/app/components/workflow/hooks/use-nodes-sync-draft.ts`

同步保存成功后新增浏览器事件：

```ts
window.dispatchEvent(new CustomEvent('agent-network-workflow-saved'))
```

只有显式同步成功的路径派发该事件；普通防抖保存路径保持原有行为。

这个事件用于让 AgentNetwork 相关界面知道“最新画布已经写入 Dify”，避免对话面板仍使用旧 graph。它是浏览器内事件，不是后端 API，也不是跨标签页消息。

## 7. 伪代码与画布编译能力增强

### 7.1 正向编译：伪代码 → Dify graph

文件：

`dify-main/web/features/agent-network-workflow/compiler.ts`

主要增强：

#### Start 节点保存入口绑定

Start 节点现在保存 `agent_network_bindings`，记录入口之前的变量绑定：

```json
{
  "target": "target_company",
  "expression": "苏州威迈芯材半导体有限公司",
  "line": 2
}
```

这样反向编译时可以恢复原始赋值，而不是只保留一个无法解释的输入变量。

#### 自动推断结构化输出字段

编译器会扫描：

- Group 参数中的下标访问；
- f-string 中的字段访问；
- list/dict 中嵌套的字段访问；
- 分支、绑定和终端表达式中的字段访问。

例如：

```python
email_result["subject"]
f"PPTX: {pptx[\"file_url\"]}"
```

会帮助生成节点的结构化输出 schema，使后续节点可以在画布中选择 `subject`、`file_url` 等字段。

#### 保留 Group 参数表达式

LLM/Group 节点保存：

- `agent_network_call_kwargs`：原始参数表达式；
- `agent_network_call_kwarg_selectors`：参数对应的 Dify 变量选择器；
- `agent_network_rendered_prompt`：生成节点时的原始 USER 文本。

这三项共同保证画布来回转换时，`answer=answer`、`content=f"...{pptx['file_url']}..."` 等关系不丢失。

### 7.2 Python 语法解析增强

文件：

`dify-main/web/features/agent-network-workflow/python-syntax.ts`

新增/增强支持：

- 括号表达式；
- 成员访问和下标访问；
- f-string 中的字段访问；
- 例如 `email_result['subject']`、`pptx['file_url']` 的引用解析。

这些语法是邮件发送、Word/PPTX 文件链接和结构化 Group 输出恢复的基础。

### 7.3 反向编译：Dify graph → 伪代码

文件：

`dify-main/web/features/agent-network-workflow/graph-to-pseudocode.ts`

HEAD 提交中继续强化：

- 恢复 Start 绑定；
- 恢复结构化输出访问；
- 为 Group 保留非 task 参数和稳定选择器；
- 只把 LLM 节点的 `data.skills` 输出为 `skills=[...]`；
- 对未支持的 Tool/Agent 节点给出 diagnostics，而不是静默丢弃。

### 7.4 当前工作树附加修复：编辑 USER 同步 Group 参数

这部分尚未包含在 `f0ce840` 提交中，属于当前本地工作树的后续修复：

文件：

- `dify-main/web/features/agent-network-workflow/graph-to-pseudocode.ts`
- `dify-main/web/features/agent-network-workflow/__tests__/reverse-compiler.spec.ts`

问题：

- EmailSendingGroup 的 USER 文本同时展示 `send_to`、`subject`、`content`；
- 用户修改 USER 中的邮箱后，旧逻辑只更新 `task`；
- `agent_network_call_kwargs` 仍然保存旧 `send_to`，执行时出现两个邮箱。

修复：

1. Group 的 USER 文本被编辑后，按 `字段名: 值` 解析已知参数；
2. 多行值持续读取到下一个已知字段；
3. 用编辑后的值覆盖对应 Group 参数；
4. `{{#node.field#}}` 变量引用仍转换为 Dify/AgentNetwork 表达式；
5. 未出现在编辑文本中的旧参数仍保持原有选择器逻辑，以兼容只修改 task 的旧工作流。

示例：

```text
send_to: new-recipient@example.com
subject: 苏州威迈芯材半导体有限公司投资尽调材料
content: PPTX：{{#pptx...#}}\nWord：{{#word...#}}
```

会生成新的 `send_to`、`subject` 和 `content` 参数，不再把旧邮箱重新带入执行。

该附加修复已增加回归测试，但当前环境的 Vitest/ESLint 被 Windows 对 `.vite-temp` 和 `.eslintcache` 的权限问题拦截，尚未完成运行时测试。

## 8. 本地浏览器缓存和伪代码存储

文件：

`dify-main/web/features/agent-network-workflow/storage.ts`

新增按 App 隔离的 localStorage 工具：

```ts
getAgentNetworkSavedPseudocode(appId)
setAgentNetworkSavedPseudocode(appId, pseudocode)
```

键格式：

```text
agent-network-saved-pseudocode:{appId}
```

它只用于浏览器本地缓存，不是对话历史的权威来源。可恢复的聊天记录和执行结果仍以 Dify 数据库为准。

## 9. 运行配置变化

### 9.1 Compose

文件：

`dify-main/docker/docker-compose.agentnetwork.yaml`

API 服务新增：

- 使用 `./.env` 作为环境文件；
- 挂载 `./volumes/app/storage:/app/api/storage`，保证 API 容器能访问本地存储。

Web 服务的默认超时调整为：

```text
AGENT_NETWORK_PLAN_TIMEOUT_MS=3600000
AGENT_NETWORK_EXECUTE_TIMEOUT_MS=3600000
```

规划地址和执行地址仍为：

```text
http://host.docker.internal:18080/service/plan_code
http://host.docker.internal:18080/service/execute_code
```

容器访问 Windows 宿主机必须使用 `host.docker.internal`，不能使用容器内的 `127.0.0.1`。

### 9.2 Web 环境变量示例

文件：

`dify-main/web/.env.example`

规划和执行超时从较短值统一提高到 3,600,000ms。真实 `.env` 不应提交密钥。

### 9.3 对长任务的影响

现在规划或执行最长允许等待约 1 小时，适用于：

- 企业信息查询；
- 多源联网搜索；
- PPTX/Word 文件生成；
- 邮件发送；
- AgentNetwork 多步执行。

代价是浏览器和 Web 容器可能长时间保持请求。后续如果需要异步任务，应改为任务 ID + 轮询/WebSocket，而不是继续无限增大 HTTP 超时。

### 9.4 模型配置的变化

- config/agent/email_generator.yaml
- config/agent/email_sender.yaml
- config/agent/rpa_email.yaml
- config/skill/rpa_email_agent.yaml
- config/skill/cua_email_agent.yaml

全部使用deepseek-flash

## 10. 测试变化

新增或扩展测试文件：

| 文件 | 覆盖内容 |
| --- | --- |
| `web/app/internal/agent-network/intent/__tests__/route.spec.ts` | 意图接口正常请求、非法输入、同源保护 |
| `web/app/internal/agent-network/plan/__tests__/route.spec.ts` | 规范化任务、附加约束、会话 id、exist code 和长超时 |
| `web/features/agent-network-workflow/__tests__/chat-panel.spec.tsx` | 意图阶段、历史追加、自动应用、执行 |
| `web/features/agent-network-workflow/__tests__/compiler.spec.ts` | Start 绑定、字段访问、邮件/PPTX/Word 相关 graph |
| `web/features/agent-network-workflow/__tests__/reverse-compiler.spec.ts` | 结构化输出、Group 参数、Skills 和 round-trip |
| `web/features/agent-network-workflow/__tests__/python-syntax.spec.ts` | 括号、下标、成员和模板字段表达式 |

此前已有的 conversation、execute、export、导航等测试继续覆盖原流程。

## 11. 与上一版本相比的行为变化

### 用户发送一轮规划

旧流程：

```text
用户输入 → 直接请求 plan_code → 保存 pseudocode → 生成画布
```

当前流程：

```text
用户输入
  → 保存原始 user 消息
  → 意图识别
  → 展示 normalizedTask
  → 请求 plan_code
  → 保存意图元数据和 pseudocode
  → 自动生成/覆盖画布
```

### 用户连续追问

- 历史消息仍追加保存，不覆盖旧气泡；
- 最近一轮伪代码作为 `exist_code`；
- 新规划成功后成为唯一 `applied` 版本；
- 当前画布被最新结果替换；
- 旧消息仍可查看和手动重新应用。

### 用户执行画布

- 先保存当前 draft；
- 使用当前画布反向编译结果；
- 使用 `applied_task`，而不是随意取最新聊天输入；
- 结果保存到当前 applied assistant 消息；
- 长任务可等待最长约 1 小时。

## 12. 当前工作树与提交边界

比较时本地工作树还存在以下情况：


- 一些旧文档在工作树中显示删除；
- `dify-main/docker/docker-compose.agentnetwork.yaml` 有未提交差异；
- EmailSendingGroup 参数同步修复修改了 `graph-to-pseudocode.ts` 和 `reverse-compiler.spec.ts`；
- 本文是新增文档，不属于 `f0ce840` 的 Git 提交；
- 这些变化不应被自动归入“GitHub 上已部署的 `f0ce840`”。

整理提交时请先由负责人确认哪些工作树变化属于当前版本，再分别提交；不要使用 `git reset --hard` 或批量删除来清理。

## 13. 已知限制和后续事项

1. 当前意图接口是 Dify Web 内的演示常量，不是真实意图模型服务。
2. 当前一个 tenant + app 仍只有一个 conversation；尚未支持一个 App 内新建和切换多个会话。
3. 规划/执行使用长 HTTP 请求，未来可考虑异步任务。
4. `extraInstructions` 现在由意图接口负责提供，真实服务替换时要维护 Dify 编译器约束。
5. 旧的 `web/features/agent-network-workflow/README.md` 中部分示例可能没有反映最新的意图接口和字段，阅读时应以当前 TypeScript/Zod schema 为准。
6. 当前 Email USER 参数编辑修复尚未进入 `f0ce840`，需要通过 Vitest 后再决定提交。
7. Dify 仓库和 AgentNetwork 仓库仍是两个独立 Git 历史，发布时要分别确认版本。
8. 启动脚本包含机器相关 Docker/Python 路径，换机器时需要检查。

## 14. 推荐验收顺序

1. 运行 `agentnetwork-dify\scripts\start-demo.cmd`；
2. 确认 AgentNetwork 监听 18080；
3. 打开一个 Workflow App；
4. 发送投资尽调任务，确认先出现意图识别卡片；
5. 确认规划结果生成画布并保存；
6. 关闭并重新打开对话面板，确认意图、消息和伪代码仍在；
7. 连续追问，确认请求包含 `exist_code`；
8. 确认新画布覆盖旧画布，不叠加旧节点；
9. 修改 EmailSendingGroup USER 中的 `send_to`、`subject`、`content`，反向查看伪代码确认参数同步；
10. 执行当前画布，确认只发送到新邮箱；
11. 刷新 Studio，确认最新 draft 和消息历史都存在；
12. 换另一个 App 验证 conversation 和 AgentNetwork `Graph.id` 隔离。
