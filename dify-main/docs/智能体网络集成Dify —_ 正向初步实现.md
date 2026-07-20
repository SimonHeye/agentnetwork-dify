# 智能体网络集成Dify —\> 正向初步实现

# 任务划分

|**任务 T**|**覆盖子步骤**|**输入**|**输出**|**Dify 复用策略**|**负责人**|
|---|---|---|---|---|---|
|T1 Python 解析|A1 \-\> A3|Python 伪代码文本|流程语义对象\(或只到A2\)|不使用 Dify，流程清晰，自研|罗阳|
|T2 Dify graph 生成|A3 \-\> A6|流程语义对象\(或A2输出\)|`workflow.graph`|修改使用默认节点配置接口，半自研|杨天旺|
|T3 画布加载集成|B1 \-\> B3|`workflow.graph`|hydrate 后的 graph \(大致\)|使用Dify源码，流程自己规划|王志轩|
|T4 画布加载集成|B3 \-\> B5|hydrate 后的 graph \(大致\)|ReactFlow 画布显示|使用Dify源码，流程自己规划|姚骏|
|T5 画布保存集成|C1 \-\> C4|ReactFlow 画布|更新后的 `Workflow.graph`|使用Dify源码，流程自己规划|罗金璐|
|T6 串联代码|A B C|把大家写的代码合并整理串行|\-|\-|张浩震|

# Python代码、Dify workflow\.graph 与 ReactFlow 画布双向转换方案

核心链路：

![image\.png](图片和附件/image.png)

|对象|职责|是否 Dify 原生|
|---|---|---|
|Python 伪代码流程|AgentNetwork 给出的流程编排结果，函数名代表任务/节点，`if/else/for` 代表控制流|否，自研格式|
|Dify `workflow.graph`|Dify Studio 画布和后端 draft workflow 共同使用的 graph JSON|是，Dify 核心结构|
|前端 ReactFlow 画布|Dify Studio 中用户看到和编辑的画布|是，Dify 前端已实现|



# 智能体网络集成Dify —\> 正向初步实现

## **1\. 整体流程**

整体流程：把智能体网络输出的 Python 伪代码转换成 Dify`workflow.graph`，再写入本地 Dify 的 draft workflow，最终显示为 Studio 画布。

\[原始设计文档把 graph 加载、hydrate 和 ReactFlow 渲染拆成了 T3、T4。当前实现没有合并那两部分的

独立代码，而是选择以 Dify draft API 为边界：负责生成并安全写入符合 Dify 数据契约`workflow.graph`，随后复用 Dify 原生的读取、hydrate 和 ReactFlow 渲染流程，把节点显示到画布上。\]     

\# 姚俊同学和志轩同学的工作\(我个人觉得\)更需要考虑在反向转换里面，例如可以帮助确认：

```Bash
1. 哪些字段是 draft 中真实保存的字段。
2. 哪些 _xxx 字段只是 hydrate 后的临时字段。
3. 用户拖动、删节点、改连线后，ReactFlow 如何序列化并保存。
4. 反向转换应该读取画布内存状态，还是读取保存后的 draft graph。
```

但是在正向实现的时候更推荐我们可以复用原有的渲染过程;

```Plain Text
flowchart LR
    A["智能体网络 Python 伪代码"] --> B["T1：解析为 Flow Semantics"]  #罗阳
    B --> C["T2：生成 workflow.graph"]                              #天旺
    C --> D["Pipeline：写入并回读校验 JSON"]                         #T1和T2合并+校验
    
    D --> E["导入器：GET 当前 draft 并备份"]         #备份方便debug并且测试，或者为后期设计需要回调
    E --> F["POST 新 graph 到 Dify draft API"]     
    F --> G["Dify 前端读取并 hydrate graph"]
    G --> H["ReactFlow 渲染 Studio 画布"]
```

主链路不经过 DSL。DSL 仍可用于 Dify 应用导入导出，但不是本项目正向转换的中间格式。



## **2\. Github **

**https://github\.com/Sanqine/Dify\_workflow**

1）当前的`Pipeline/dify_import_config.json` 是我本机的token配置，大家自行更换，下面有教程说明；

大家git clone之后需要创建自己的本地配置：Pipeline\\dify\_import\_config\.json，然后填写自己的 `app_id` 和 `access_token`，我上传的是没有的；

2）我们的代码是与 Dify 分离部署的，当前代码不读取 `dify/` 目录，只通过 HTTP 访问：

```Plain Text
http://localhost/console/api/apps/{app_id}/workflows/draft
```

因此 Dify的本地部署文件 可以：放在其他文件夹，其他磁盘，甚至运行在另一台服务器。



## **3\. 文件说明**

### **3\.1 T1\_parser ：伪代码解析**

|文件|职责|
|---|---|
|`T1_parser/pseudocode_parser.py`|T1 核心实现。解析 Python 伪代码，检查语法和变量关系，生成 Flow Semantics。|
|`T1_parser/sample.py`|当前分支流程的输入示例，也是端到端演示使用的伪代码。|
|`T1_parser/test_pseudocode_parser.py`|T1 单元测试，覆盖赋值、调用、分支、终点、错误和 warning。|

### **3\.2 T2\_workflowgraph：workflow\.graph 生成**

|文件|职责|
|---|---|
|`T2_workflowgraph/workflow_graph_builder.py`|T2 核心实现。把 Flow Semantics 转换为 Dify 节点、边、结构化输出、布局和 end 节点。|
|`T2_workflowgraph/build_sample_graph.py`|不经过完整 Pipeline，单独调用 T1/T2 生成示例 graph，便于调试 T2。|
|`T2_workflowgraph/test_workflow_graph_builder.py`|T2 单元测试，检查节点映射、分支 handle、变量 selector、布局和非法流程。|

### **3\.3 Pipeline：正向流程串联**

|文件|职责|
|---|---|
|`Pipeline/pipeline.py`|在内存中依次调用 T1 和 T2，输出并回读校验 `workflow.graph` JSON。|
|`Pipeline/test_pipeline.py`|端到端测试“伪代码 → Flow Semantics → workflow\.graph”。|
|`Pipeline/test_import_graph_to_dify.py`|测试 graph 校验、draft payload、备份、dry\-run 和保存后回读验证。|

### **3\.4 Dify 导入配置与画布接入**

|文件|职责|
|---|---|
|`Pipeline/dify_import_config.json`|本机私有配置，保存 Dify 地址、App ID、graph 路径、备份路径、token 和自动确认选项。|
|`Pipeline/dify_import_config.example.json`|可共享的配置模板，不保存真实 token。|
|`import_graph_to_dify.py`|校验 graph，GET 当前 draft，备份旧画布，POST 新 graph，并再次 GET 验证。|
|`Chatbot.yml`|从 Dify 导出的 DSL 参考文件，只用于核对模型和节点字段，不进入正向主链路。|

### **3\.5 生成结果与备份**

|路径|内容|
|---|---|
|`workflow_graphs/sample_graph.json`|Pipeline 生成的纯 graph，顶层是 `nodes`、`edges`、`viewport`，可直接交给导入器。|
|`workflow_graphs/backups/*.draft.json`|每次导入前保存的完整 draft，包含 `graph`、`features`、变量、hash 等信息。|

注意：完整 draft 的节点位于 `graph.nodes`，而纯 graph 的节点位于顶层 `nodes`。因此不能把整个`.draft.json` 直接复制成 `sample_graph.json`；如果只恢复画布，需要提取其中的 `graph`。



## **4\. 各部分实现**

### **4\.1 T1：Python 伪代码解析\[罗阳\]**



核心文件：`T1_parser/pseudocode_parser.py`

\[ T1 使用 Python 标准库 `ast` 解析受控的 Python 伪代码，不执行伪代码\] 当前主要支持：

```Bash
- 单变量赋值和函数调用；
- if / elif / else；
- f-string、常量和变量引用；
- return、final_result 以及可配置终点函数；
- 输入变量、变量生产者、分支和多终点推断。
```

入口函数是 `compile_to_semantics()`。输出的 Flow Semantics 包含 `inputs`、`steps`、`body`、

`bindings`、`terminals`、`variables` 和 `warnings`。它只作为编译器内部接口，在 Pipeline 中

直接传给 T2，不要求最终落盘。



### **4\.2 T2：生成 Dify workflow\.graph\[天旺\]**



核心文件：`T2_workflowgraph/workflow_graph_builder.py`

\[ 入口函数是 `build_workflow_graph()`。当前映射规则基于本项目约定：所有名称以 `Group` 结尾的

智能体组都生成 Dify LLM 节点，包括 `CalculatorGroup`，不映射成 code 节点 \] 主要转换规则如下：

```SQL
- 推断出的用户输入生成 start 节点变量；
- XXXGroup(...) 生成 llm 节点，函数参数被渲染为 Dify Prompt 模板；
- Python if / elif / else 生成 if-else 节点和不同 sourceHandle 的分支边；
- final_result 或终点输出生成 end 节点；
- .get("field") 条件会让上游 LLM 启用结构化输出，并由分支节点引用
- [node_id, "structured_output", field]；
- 节点和边生成后执行拓扑布局，补齐 Dify 所需的 position、handle、节点类型和 viewport。
```

T2 会检查节点 ID、边引用、起点、终点和有向环。当前 V1 仅覆盖 `start`、`llm`、`if-else`、

`end` 以及无环结构；loop、iteration、tool、HTTP 等节点需要后续扩展。



### **4\.3 Pipeline：串联 T1 和 T2**



核心文件：`Pipeline/pipeline.py` , Pipeline 的调用关系是：

```Plain Text
pseudocode_file_to_workflow_graph()
    -> compile_to_semantics()
    -> build_workflow_graph()
    -> write_workflow_graph()
```

Flow Semantics 始终保留在内存中，调用方最终只获得 graph JSON。写入文件后，Pipeline 会立即

回读并检查 JSON 内容以及 `nodes`、`edges`、`viewport`，因此正常使用时不需要额外执行

`python -m json.tool`。

模型配置由 Pipeline 参数传入。当前本地 Dify 示例使用：

```Plain Text
provider: langgenius/deepseek/deepseek
model: deepseek-chat
mode: chat
```



### **4\.4 workflow\.graph 写入 Dify**



核心文件：`import_graph_to_dify.py`

\[这一部分替代了原计划中单独开发的 graph 加载集成层。程序没有直接操作 ReactFlow，也没有

修改 Dify 前端源码，而是调用 Dify Console 的 draft workflow 接口 \]

```Plain Text
GET/POST /console/api/apps/{app_id}/workflows/draft
```

一次正式导入按以下顺序执行：

1. 从 `Pipeline/dify_import_config.json` 读取 Dify 地址、App ID、graph 路径和 access token。

2. `load_graph()` 读取 graph，并检查 `nodes`、`edges` 和 `viewport`。

3. GET 当前 draft，获得现有 graph、features、变量和最新 hash。

4. 把完整旧 draft 写入 `workflow_graphs/backups/`。

5. `build_sync_payload()` 只替换 graph，保留当前 features、环境变量、会话变量和 hash。

6. POST payload，由 Dify 后端校验并保存 `Workflow.graph`。

7. 再次 GET draft，确认远端保存的 graph 与本地 graph 一致。

hash 用于避免覆盖其他并发编辑。若 POST 后回读结果不一致，导入器会报错，不会把成功提示

误报给用户。



### **4\.5 Dify 原生画布加载与渲染**



导入完成后，刷新 Studio 页面。后续过程由 Dify 自身完成：

```Plain Text
fetchWorkflowDraft()
    -> getWorkflowDraftGraphForCanvas()
    -> initialNodes() / initialEdges()
    -> ReactFlow 渲染
```

相关 Dify 源码入口：

- `dify/web/service/workflow.ts`：读取和保存 draft；

- `dify/web/app/components/workflow-app/hooks/use-workflow-init.ts`：初始化 draft；

- `dify/web/app/components/workflow-app/hooks/use-workflow-draft-graph-for-canvas.ts`：把 draft graph

转为画布初始化数据；

- `dify/web/app/components/workflow/utils/workflow-init.ts`：初始化 ReactFlow nodes 和 edges；

- `dify/web/app/components/workflow-app/hooks/use-nodes-sync-draft.ts`：用户修改画布后的原生保存逻辑。

因此，我们实现的关键不是重新写一套画布，而是让生成结果满足 Dify graph 数据契约，并通过正确的 draft payload 写入 Dify。出现显示问题时，应优先检查 T2 生成字段和导入 payload，而不是先修改 ReactFlow。



## **5\. 示例流程的实际映射**



对于 `T1_parser/sample.py` 中的分支示例，当前会生成：

```Plain Text
Start
  -> ReasoningGroup (LLM，结构化输出 kind)
  -> IF/ELSE
       case_1 -> CalculatorGroup (LLM) -> End
       false  -> SearchGroup (LLM)     -> End
```

生成结果共包含 7 个节点和 6 条边。`ReasoningGroup` 的 `kind` 字段由结构化输出提供，分支节点不解析普通文本，而是直接读取该字段进行条件判断。



## **6\. 运行方式**

### **第一步：生成 workflow\.graph**

在项目根目录运行。

```PowerShell
python Pipeline\pipeline.py T1_parser\sample.py `
  --provider "langgenius/deepseek/deepseek" `
  --model "deepseek-chat" `
  --output workflow_graphs\sample_graph.json
```

Pipeline 会在写入后自动回读并检查 JSON、`nodes`、`edges` 和 `viewport`，生成失败时命令会直接报错，不会进入导入步骤。

### **第二步：自动导入 Dify**

在 `Pipeline/dify_import_config.json` 中配置一次本地 Dify 信息和 access token，注意

```JSON
{
  "base_url": "http://localhost",
  "app_id": "a120896d-0344-48f0-9eda-27439a58d6a2",
  "graph": "workflow_graphs/sample_graph.json",
  "backup_dir": "workflow_graphs/backups",
  "access_token": "在这里粘贴 Cookies 中复制的 access_token，按F12在Application里取cookies",
  "auto_confirm": true
}
```

① 然后执行自动导入：

```PowerShell
python import_graph_to_dify.py
```

② 当 `auto_confirm` 为 `true` 时，一次命令会自动完成备份、导入和回读验证。只想检查连接并备份、不修改画布时，可以使用：

```PowerShell
python import_graph_to_dify.py --dry-run
```

access token 是本地 Dify 登录会话凭据，建议只应保存在被 `.gitignore` 忽略的本机配置中；



## **6\. 测试与接手顺序**

完整测试命令：

```PowerShell
python -m pytest T1_parser\test_pseudocode_parser.py `
  T2_workflowgraph\test_workflow_graph_builder.py `
  Pipeline\test_pipeline.py Pipeline\test_import_graph_to_dify.py `
  -q -p no:cacheprovider
```

\[ 当前测试覆盖 T1 解析、T2 节点与边生成、结构化分支、Pipeline 端到端输出，以及 draft 备份、

payload 保留、dry\-run 和回读验证\]



## 本周工作：

整体流程：把智能体网络输出的 Python 伪代码转换成 Dify`workflow.graph`，再写入本地 Dify 的 draft workflow，最终显示为 Studio 画布。

1）简化流程，把源码的复用再开发留到反向实现的过程，正向的本质是渲染；

\[原始设计文档把 graph 加载、hydrate 和 ReactFlow 渲染拆成了 T3、T4。当前实现没有合并那两部分的

独立代码，而是选择以 Dify draft API 为边界：负责生成并安全写入符合 Dify 数据契约`workflow.graph`，随后复用 Dify 原生的读取、hydrate 和 ReactFlow 渲染流程，把节点显示到画布上。\]     



2）集成pipeline,把之前同学的工作串联成流水线，仅保留workflow\.graph中间产物，作为回退和撤回的功能保留；

```Plain Text
flowchart LR
    A["智能体网络 Python 伪代码"] --> B["T1：解析为 Flow Semantics"]  #罗阳
    B --> C["T2：生成 workflow.graph"]                              #天旺
    C --> D["Pipeline：写入并回读校验 JSON"]                         #T1和T2合并+校验
    
    D --> E["导入器：GET 当前 draft 并备份"]         #备份方便debug并且测试，或者为后期设计需要回调
    E --> F["POST 新 graph 到 Dify draft API"]     
    F --> G["Dify 前端读取并 hydrate graph"]
    G --> H["ReactFlow 渲染 Studio 画布"]
```

## 

## 之后工作：

1）弥补工程上自动化的部分；

① 例如：自动化获取本地部署的base\_url, app\_id，access\_token等等；

② Dify版本的兼容性测试，目前是以我本机的Dify 1\.15的版本为准，\[渲染失败\]



2）反向流程\-信息补漏（Group Registry \+ SourceMap）提高反推python伪代码的质量和准确性；

##### 三个对象的职责

```Plain Text
workflow.graph
    保存当前画布的真实流程结构

Group Registry
    识别用户新增的 LLM 节点对应哪个 Group

SourceMap
    记住原 Python 代码与 graph 节点的对应关系
```

画布修改后，以 graph 为准；SourceMap 不能覆盖用户的新修改，只负责提供原始信息。



3）反向生成伪代码流程的走通；

4）对接皓杰师兄的工作部分（具体还需了解一下）



1）伪代码展示的链路
2）用户编辑反向解析（差最后一步）
3）和agent\-network 接入的执行，



① agent\-network生成的python伪代码需要Dify给出符合输入输出规约的对应规则；
② dify的执行的流程需要对接上agent\-network的执行；





