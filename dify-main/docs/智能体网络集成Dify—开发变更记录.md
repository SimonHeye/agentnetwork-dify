# 智能体网络集成 Dify：开发变更记录

## 文档用途

本文档用于持续记录“智能体网络集成 Dify”项目在原始计划之后的实际工程变更，包括：

- 本次需求的目标、范围与明确不做的内容；
- 新增或修改的源码位置；
- 数据结构和数据流变化；
- 测试、验收和已知问题；
- 本地开发环境的启动方式与排障结论；
- 后续开发者继续追加记录时需要保留的上下文。

原始设计和前期实现背景仍参考：

- `docs/python-pseudocode-workflow-graph-reactflow-plan.md`
- `docs/智能体网络集成Dify —_ 正向初步实现.md`

本记录描述实际落地结果。后续实现可以根据项目演进调整，不要求机械遵循最初计划。

---

## 2026-07-20：为 LLM 节点增加 Skills 多选配置

### 状态

- 前端实现：已完成
- 自动化测试：已完成
- 类型检查：已通过
- 本地开发前端启动：已通过 Vinext 路线验证
- 浏览器手工验收：需要在 Studio 中完成最终选择、保存、刷新检查

### 需求目标

在工作流画布中单击 LLM 节点时，在右侧配置面板的“模型”下方、“上下文”上方增加 Skills 配置项。

首批固定 Skill：

- `browser-control`
- `download_attachments`
- `gimp-blur-region`
- `gimp-remove-background`

交互要求：

- 支持输入名称进行不区分大小写的筛选；
- 支持点击添加多个 Skill；
- 已选 Skill 以标签形式显示；
- 支持通过标签删除按钮移除；
- 按用户添加顺序保存；
- 避免重复添加；
- 没有匹配项时显示空结果提示；
- 只读画布展示已有选择，但不能添加或删除。

### 本次范围

本次只实现：

- LLM 节点右侧面板中的 Skills 选择界面；
- `workflow.graph` 中 `data.skills` 的前端持久化；
- 新节点默认值和旧节点兼容；
- 前端国际化文案；
- 相关组件、Hook 和面板测试。

本次明确不实现：

- 不读取 Skill 元数据；
- 不检查 Skill 是否实际安装；
- 不把 Skill 注入 Prompt；
- 不把 Skill 传入模型调用；
- 不改变 LLM 节点运行逻辑；
- 不修改后端、AgentNetwork、T1、T2 或其他节点；
- 不处理页面中 DeepSeek 模型显示“不兼容”的问题，该提示与 Skills 配置相互独立。

### 数据结构

在 `LLMNodeType` 中增加向后兼容字段：

```ts
skills?: string[]
```

新建 LLM 节点时默认包含：

```ts
skills: []
```

保存后的工作流节点示例：

```json
{
  "data": {
    "type": "llm",
    "skills": [
      "browser-control",
      "gimp-blur-region"
    ]
  }
}
```

兼容约定：

- 旧工作流没有 `skills` 字段时，通过 `inputs.skills ?? []` 按空数组展示；
- 不执行历史数据迁移；
- 数组顺序即用户添加顺序；
- 更新 Skills 时保留模型、Prompt、上下文等其他节点数据。

### 数据更新链路

```text
SkillsSelector.onChange
  -> handleSkillsChange
  -> produce(inputRef.current)
  -> draft.skills = skills
  -> setInputs(nextInputs)
  -> useNodeCrud 现有节点更新和 draft 保存流程
  -> workflow.graph 中对应 LLM 节点的 data.skills
```

没有增加新的全局状态、API 或后端存储接口。

### 新增文件

#### Skills 选择组件

`web/app/components/workflow/nodes/llm/components/skills-selector/index.tsx`

- 使用 `@langgenius/dify-ui/combobox`；
- 使用 Combobox 多选和 chips 模式；
- 固定维护四个 Skill 选项；
- 使用组件自带过滤能力完成不区分大小写的搜索；
- 将已选字符串按原顺序映射为 Combobox 选项；
- 只读状态隐藏移除按钮，并禁止修改；
- 使用 Combobox 自带 Portal 和层级，没有增加自定义 `z-index`。

#### Skills 选择组件测试

`web/app/components/workflow/nodes/llm/components/skills-selector/__tests__/index.spec.tsx`

覆盖：

- 输入大写 `GIMP` 时只显示两个 GIMP Skill；
- 无匹配结果时显示空状态；
- 多选结果保持用户添加顺序；
- 标签可以移除；
- 只读状态展示现有值但不能修改。

### 修改文件

#### LLM 节点类型

`web/app/components/workflow/nodes/llm/types.ts`

- 在 `LLMNodeType` 中增加 `skills?: string[]`。

#### LLM 节点默认配置

`web/app/components/workflow/nodes/llm/default.ts`

- 在 LLM 新节点默认值中增加 `skills: []`；
- 没有将 Skills 加入必填校验。

#### LLM 节点配置 Hook

`web/app/components/workflow/nodes/llm/use-config.ts`

- 增加 `handleSkillsChange`；
- 基于 `inputRef.current` 生成完整的下一份节点数据；
- 只更新 `draft.skills`；
- 继续使用原有 `setInputs` 和 `useNodeCrud` 更新流程。

#### LLM 节点右侧面板

`web/app/components/workflow/nodes/llm/panel.tsx`

- 引入 `SkillsSelector`；
- 将 Skills 字段放在“模型”之后、“上下文”之前；
- 传入 `inputs.skills ?? []`、`readOnly` 和 `handleSkillsChange`。

#### 现有测试扩展

- `web/app/components/workflow/nodes/llm/__tests__/default.spec.ts`
  - 验证新 LLM 节点默认 `skills` 为空数组。
- `web/app/components/workflow/nodes/llm/__tests__/use-config.spec.ts`
  - 验证 Skills 写入、选择顺序和其他节点数据保留。
- `web/app/components/workflow/nodes/llm/__tests__/panel.spec.tsx`
  - 使用真实 SkillsSelector 验证 Panel 接入和更新回调。

#### 国际化

修改全部受支持语言的：

`web/i18n/*/workflow.json`

共 23 个语言包，新增：

```text
nodes.llm.skills
nodes.llm.skillsPlaceholder
```

Skill 名称使用原始英文标识，不进行翻译。

### 自动化验证结果

#### LLM 节点测试

执行：

```powershell
pnpm -C web test app/components/workflow/nodes/llm
```

结果：

```text
Test Files  13 passed (13)
Tests       49 passed (49)
```

#### TypeScript 类型检查

执行：

```powershell
pnpm -C web type-check
```

结果：通过。

#### ESLint

对本次修改的 LLM 节点文件执行局部 ESLint：

- `0 error`
- 保留 4 条既有 React warning，包括旧 Hook 依赖提示和旧测试 Context Provider 写法；
- 没有由 SkillsSelector 引入新的 ESLint 错误。

#### 国际化检查

新增的两个 Skills 文案键已在 23 个语言包中对齐。

仓库全量 `i18n:check` 仍会报告既有的 `explore.*` 文案缺口；这些缺口不是本次改动引入，因此本次没有越界修改。

### 浏览器手工验收步骤

1. 打开 `http://localhost:3000/`。
2. 进入 Studio 并打开一个工作流。
3. 单击 LLM 节点。
4. 在右侧“模型”下方确认出现“技能”配置项。
5. 输入 `gimp`，确认只显示：
   - `gimp-blur-region`
   - `gimp-remove-background`
6. 依次添加多个 Skill，确认标签顺序与添加顺序一致。
7. 删除一个标签，确认对应 Skill 被移除。
8. 等待工作流 draft 自动保存。
9. 刷新 Studio 并重新打开该节点，确认选择仍然存在。
10. 打开一个没有 `skills` 字段的旧工作流，确认显示空选择且没有报错。

### 当前功能边界

Skills 当前只是工作流节点配置数据。

即使节点已经保存：

```json
"skills": ["browser-control"]
```

运行 LLM 节点时也不会自动调用该 Skill。后续若要真正执行，需要另行设计 Skill 解析、安装状态、权限、运行时注入和错误处理流程。

---

## 2026-07-20：本地前端启动方式调整

### 背景

最初的本地启动脚本使用：

```powershell
pnpm start
```

该命令读取已经生成的 `.next` 生产构建。只重启进程或刷新浏览器不会重新加载新修改的 TSX 源码，因此本次 Skills 配置最初无法在页面中显示。

### 本机排障记录

#### Next Turbopack 开发模式

执行：

```powershell
pnpm dev
```

结果：Turbopack 完成部分缓存写入后，Node 进程以退出码 `3221226505`（`0xC0000409`）异常终止。

#### Next Webpack 开发模式

执行：

```powershell
pnpm dev -- --webpack
```

结果：Webpack 无法加载 `loro-crdt` 的 `loro_wasm_bg.wasm`，提示未启用 WebAssembly experiment。

该问题属于前端构建环境，不是 Skills 组件、Dify API 或 Worker 的运行错误。

#### Vinext 开发模式

执行：

```powershell
pnpm run dev:vinext
```

首次依赖优化时曾出现：

```text
transport invoke timed out after 60000ms
GET / 500
```

停止并重新启动 Vinext 后，复用已生成的优化缓存，前端成功启动。

当前 Windows 本地环境建议优先使用 Vinext 开发模式。

### 启动脚本修改

修改：

`scripts/start-local-dify.ps1`

前端命令由：

```powershell
& 'D:\DifyDevTools\npm-global\pnpm.cmd' start
```

改为：

```powershell
& 'D:\DifyDevTools\npm-global\pnpm.cmd' run dev:vinext
```

`scripts/start-local-dify.cmd` 本身仍然只是 PowerShell 启动入口，没有修改。

以后可以继续执行：

```text
scripts\start-local-dify.cmd
```

启动内容：

| 窗口/服务 | 启动内容 | 本次是否改变 |
| --- | --- | --- |
| Dify API | Flask，端口 `5001` | 否 |
| Dify Worker | Celery Worker | 否 |
| Dify Web | `pnpm run dev:vinext`，端口 `3000` | 是 |
| Docker 中间件 | `docker-compose.middleware.yaml` | 否 |

当前 `web/.env.local` 的 API 地址为：

```text
NEXT_PUBLIC_API_PREFIX=http://localhost:5001/console/api
NEXT_PUBLIC_PUBLIC_API_PREFIX=http://localhost:5001/api
```

因此不应同时启动默认占用 `5001` 的 `dev:proxy`，否则会和本地 Dify API 冲突。

### 启动注意事项

- Vinext 首次依赖优化可能较慢；
- 第一次出现 60 秒 optimizer 超时时，可以停止后重试一次以复用缓存；
- 如果重复出现相同错误，应记录完整终端日志，不要反复重启 API、Worker 或 Docker；
- 页面可访问后，开发期间修改 `web/app` 下源码会自动更新；
- 若以后恢复 `pnpm start`，必须先重新执行生产构建，否则会继续加载旧 `.next` 内容。

---

## 后续追加格式

后续开发者请按时间倒序或顺序保持一致地追加，不要覆盖已有记录。推荐使用以下模板：

```markdown
## YYYY-MM-DD：变更标题

### 状态

- 设计：
- 实现：
- 测试：
- 手工验收：

### 目标与范围

说明为什么修改、需要解决什么问题，以及明确不做什么。

### 数据结构或接口变化

记录新增字段、请求、响应、事件或持久化位置。

### 新增文件

- `path/to/file`：用途。

### 修改文件

- `path/to/file`：具体改动。

### 验证结果

记录执行的命令、通过数量和未通过原因。

### 已知问题与后续工作

记录尚未实现的运行时能力、兼容问题和建议的下一步。
```

### 维护要求

- 记录实际实现，不只复制原始计划；
- 明确区分“已实现”“已测试”“已手工验收”和“计划中”；
- 路径尽量写到具体文件；
- 测试失败时记录是否由本次修改引入；
- 不在本文档中保存密码、Token、Cookie 或其他敏感信息；
- 对启动方式、端口、环境变量的改变要单独记录，避免其他开发者重复排障。
