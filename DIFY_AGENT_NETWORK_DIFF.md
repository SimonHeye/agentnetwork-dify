# Dify 与 Agent Network 变更说明

本文件对应 Git 分支 `final_demo1`。本次提交只包含 Dify 代码和本说明文件。

## Dify 代码变更

### 1. 意图识别接口与前端展示

- `dify-main/web/app/internal/agent-network/intent/route.ts`：新增 `POST /internal/agent-network/intent`，接收原始 `task`，返回 `normalizedTask` 与 `extraInstructions`。
- `dify-main/web/features/agent-network-workflow/request-intent.ts`：新增请求类型和响应校验：

  ```ts
  type AgentNetworkIntentResult = {
    normalizedTask: string
    extraInstructions: string
  }
  ```

- `dify-main/web/features/agent-network-workflow/intent-result.tsx`：新增“正在识别任务意图……”/“意图识别完成”卡片，只展示 `normalizedTask`。
- `dify-main/web/features/agent-network-workflow/chat-panel.tsx`：发送原始消息后先调用 `requestAgentNetworkIntent({ task })`，再把下面两个字段传给规划接口：

  ```ts
  task: intentResult.normalizedTask,
  extraInstructions: intentResult.extraInstructions,
  ```

  意图结果写入 `meta.agent_network_intent`，刷新页面后仍可显示。对话面板固定使用 `z-60`，切换页面回来时重新加载历史。

### 2. Agent Network 规划接口

- `dify-main/web/app/internal/agent-network/plan/route.ts`：规划请求默认/最大超时提高到 `3600000ms`，并直接透传前端约束：

  ```ts
  ...(input.data.extraInstructions
    ? { extra_instructions: input.data.extraInstructions }
    : {}),
  ```

  删除前端额外拼接的固定 Dify 兼容约束。
- `dify-main/web/app/internal/agent-network/pseudocode/route.ts`：反向伪代码接口最大/默认超时提高到 `3600000ms`。
- `dify-main/api/services/agent_network_conversation_service.py`：应用规划时优先保存意图识别后的任务：

  ```python
  normalized_task = intent_result.get("normalizedTask")
  conversation.applied_task = str(
      normalized_task or task_message.content
  ).strip()
  ```

### 3. 伪代码 → 画布 → 伪代码一致性

- `dify-main/web/features/agent-network-workflow/compiler.ts`：Start 节点保存 `agent_network_bindings`；扫描 `result['file_url']` 等字段访问并推断结构化输出；保留原始参数表达式和字段选择器。
- `dify-main/web/features/agent-network-workflow/graph-to-pseudocode.ts`：从 Start 节点恢复变量声明，输出 `${binding.target} = ${binding.expression}`，并保留 `agent_network_bindings`。
- `dify-main/web/features/agent-network-workflow/python-syntax.ts`：增加括号表达式、成员/下标访问和模板字段访问解析，支持：

  ```python
  f"PPTX: {ppt_result['file_url']}"
  ```

  用于恢复 PPTX/Word 链接及邮件主题、正文依赖。
- `dify-main/web/features/agent-network-workflow/export-trigger.tsx`：导出时使用当前画布反向生成的伪代码，不再读取旧的本地缓存代码。

### 4. 持久化、配置与测试

- `dify-main/web/features/agent-network-workflow/conversation-service.ts`：持久化/读取意图元数据和执行结果。
- `dify-main/docker/docker-compose.agentnetwork.yaml`、`dify-main/web/.env.example`：更新 Agent Network 容器配置和环境变量示例。
- 测试文件：
  - `dify-main/web/app/internal/agent-network/intent/__tests__/route.spec.ts`
  - `dify-main/web/app/internal/agent-network/plan/__tests__/route.spec.ts`
  - `dify-main/web/features/agent-network-workflow/__tests__/chat-panel.spec.tsx`
  - `dify-main/web/features/agent-network-workflow/__tests__/compiler.spec.ts`
  - `dify-main/web/features/agent-network-workflow/__tests__/reverse-compiler.spec.ts`

  覆盖意图请求、超时、入口绑定、字段访问和邮件字段引用。

## Agent Network（未随本次分支上传）

工作区中的 `agent-network/` 是独立仓库，包含 LLM 路由、Agent/Skill 配置、smoke_test、邮件与线程生命周期修改；本次按要求只上传 Dify 仓库，未纳入 `final_demo1`。

## 上传范围

已提交到 `final_demo1` 的内容为 `dify-main/` 下上述文件及本文件。未提交 `agent-network/`、`backups/`、`patent-work/`、`tmp/`、`vmware_vm_data/`。