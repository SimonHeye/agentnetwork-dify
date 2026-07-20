# 流程语义对象规约（Flow Semantics Contract v1）

| 项 | 内容 |
|---|---|
| 版本 | v1 |
| 生产方 | T1 Python 解析（罗阳），定义并维护本规约 |
| 消费方 | T2 Dify graph 生成（杨天旺），评审确认后锁定 |
| 状态 | 待 T2 评审 |
| 活契约 | `test_pseudocode_parser.py` 中的样例断言与本文档共同构成契约，冲突时以测试样例为准 |

## 0. 设计原则

1. 本对象是**纯 Python 语义**的忠实记录，不出现任何 Dify 概念
   （sourceHandle、comparison_operator、BlockEnum 等均不出现）。
2. 所有 Python 语义 → Dify 概念的翻译由 T2 负责，包括：
   操作符对照表、case_id → handle 映射、value_selector 生成、函数注册表查询。
3. 认不出的结构**降级不崩溃**：原文（raw）与变量引用（refs）永不丢失。
4. 控制流必须可重建：顶层和分支体都显式保存有序对象 id，终点不会脱离所属路径。

## 1. 顶层结构

​```json
{
  "version": 1,
  "body":      [],
  "inputs":    [],
  "steps":     [],
  "bindings":  [],
  "terminals": [],
  "variables": {},
  "warnings":  []
}
​```

| 字段 | 类型 | 含义 | T2 典型用途 |
|---|---|---|---|
| version | int | 契约版本，当前恒为 1 | 兼容检查 |
| body | list[str] | 顶层执行序列，引用 step / binding / terminal id | 重建主控制流 |
| inputs | list | 用户输入变量（未赋值先使用推断） | start 节点 variables |
| steps | list | 流程步骤扁平列表 | 生成 nodes / edges |
| bindings | list | 不生成节点的普通赋值 | 常量、模板和别名解析 |
| terminals | list | 流程终点，**恒为列表**（支持多终点） | answer / end 节点 |
| variables | dict | 变量 → 产出 step id 列表，**一对多** | value_selector |
| warnings | list[str] | 降级与推断警告 | 展示 / 日志 |

## 2. Value 对象（所有"值"的统一形态）

出现位置：call 的 args/kwargs、比较值、终点 output。共 4 种，
由 `expr` 区分，**每种必含 `raw`（原文）与 `refs`（引用变量名列表）**。

### 2.1 var — 变量引用
​```json
{ "expr": "var", "name": "answer", "raw": "answer", "refs": ["answer"] }
​```

### 2.2 const — 常量
​```json
{ "expr": "const", "value": 0.8, "value_type": "float", "raw": "0.8", "refs": [] }
​```
`value_type` ∈ `str | int | float | bool | null`。**保留 Python 原始类型，不做字符串化。**

### 2.3 template — 模板（f-string）
​```json
{
  "expr": "template",
  "parts": [
    { "text": "需求：" },
    { "var": "task" },
    { "raw_expr": "task.strip()" }
  ],
  "raw": "f\"需求：{task}\"",
  "refs": ["task"]
}
​```
- `parts` 为顺序数组，元素三选一：`text`（字面文本，转义花括号 `{{}}` 已还原为
  普通花括号并留在文本中）、`var`（变量插值）、`raw_expr`（插值内非简单变量的降级片段）。
- T2 用途：生成 prompt_template，将 `{"var": "task"}` 替换为
  `{{#节点id.字段#}}` 形式的引用。

### 2.4 raw — 降级兜底
​```json
{ "expr": "raw", "raw": "task.strip()[:100]", "refs": ["task"] }
​```
T1 无法结构化的表达式。数据依赖（refs）仍然可靠，可用于连边；
具体值 T2 可降级处理（如塞入节点 desc 供人工补）。

> **演进约定**：未来可能新增 `expr` 枚举值。T2 遇到不认识的 `expr`
> 应按 raw 降级处理（读 `raw` / `refs`），保证向前兼容。

## 3. steps

扁平列表，两种步骤。**branch 步骤总是排在其分支体步骤之前**；
分支体是有序 id 列表，可引用 step、binding 或 terminal。

### 3.1 call 步骤（一次智能体调用）

​```json
{
  "id": "reasoninggroup",
  "kind": "call",
  "function": "ReasoningGroup",
  "assign_to": "probe",
  "args": [],
  "kwargs": { "task": { "...": "Value 对象" } },
  "lineno": 6
}
​```

| 字段 | 说明 |
|---|---|
| id | 步骤唯一 id：函数名小写，重名依次追加 `_2`、`_3` |
| function | Python 原文函数名（保留大小写）→ T2 查函数注册表得节点类型 |
| assign_to | 产出变量名；无赋值时为 null |
| args / kwargs | 位置参数（有序）/ 关键字参数，值均为 Value 对象 |
| lineno | 源码行号（错误定位 / SourceMap） |

### 3.2 branch 步骤（if / elif / else）

​```json
{
  "id": "branch_1",
  "kind": "branch",
  "cases": [
    { "case_id": "case_1", "condition": { "...": "Condition" }, "body": ["calculatorgroup"] }
  ],
  "else_case": { "case_id": "else", "body": ["searchgroup"] },
  "lineno": 10
}
​```

- elif 链已拍平为 cases 列表（case_1 .. case_n）。
- `case_id` 是 **T1 内部稳定标识符**，与 Dify handle 无绑定，映射由 T2 负责。
- `body` 为有序对象 id 列表，可含 call、嵌套 branch、binding 和 terminal id。
- 无 else 时 `else_case.body` 为 `[]`。

### 3.3 Condition 对象

条件语义固定为「上下文取值 + 比较符 + 值」的原子比较，可用 and/or 连接。

​```json
{
  "parsed": true,
  "logical": "and",
  "comparisons": [
    {
      "var": "probe",
      "key": "kind",
      "op": "==",
      "value": { "expr": "const", "value": "calc", "value_type": "str", "raw": "\"calc\"", "refs": [] },
      "raw": "probe.get(\"kind\") == \"calc\""
    }
  ],
  "raw": "probe.get(\"kind\") == \"calc\"",
  "refs": ["probe"]
}
​```

| 字段 | 说明 |
|---|---|
| parsed | false 表示无法结构化（comparisons 为空），T2 只能用 raw 降级 |
| logical | "and" / "or"；单条件恒为 "and"；**and/or 混用会降级为 parsed:false** |
| var | 被取值的变量名 |
| key | 取值字段（来自 `.get("key")`）；直接用整个变量时为 null |
| op | **Python 原文操作符**（见下表）；→ Dify 操作符翻译表由 T2 维护 |
| value | Value 对象，保留原始类型；op 为 truthy/falsy 时为 null |

### 3.4 执行序列与 bindings

顶层 `body` 和每个 case 的 `body` 使用相同规则，按执行顺序保存对象 id：

```json
["reasoninggroup", "branch_1", "binding_1", "terminal_1"]
```

普通赋值不对应智能体节点，因此不放入 `steps`，而是记录在 `bindings`：

```json
{
  "id": "binding_1",
  "target": "final_result",
  "value": { "expr": "var", "name": "answer", "raw": "answer", "refs": ["answer"] },
  "sources": { "answer": ["calculatorgroup", "searchgroup"] },
  "lineno": 14
}
```

- `sources` 是赋值发生时各引用变量可达的调用生产者快照。
- 常量、模板和输入别名即使没有调用生产者，也不会丢失，T2 可从 binding 递归解析。
- 第一版禁止同一执行路径重复赋值同一变量，避免 use-site 无法确定生产者。

op 全集：
`==` `!=` `>` `>=` `<` `<=` `in` `not in` `is` `is not` `truthy`（if x:）`falsy`（if not x:）

## 4. terminals

**恒为列表**。推断规则：末条顶层语句决定输出；末条是 if 时每条路径各产生终点；
`reply(...)` 在任意位置出现均视为终点。

terminal id 同时出现在所属 `body` 中。因此分支内的 `reply/return` 可以通过 case body
确定归属，不需要根据行号猜测。终止语句之后的同一语句块内容不可达，会被忽略并告警。

​```json
{
  "id": "terminal_1",
  "via": "last_assign",
  "assigned_name": "final_result",
  "output": { "expr": "var", "name": "answer", "raw": "answer", "refs": ["answer"] },
  "output_step": null,
  "lineno": 14
}
​```

| 字段 | 说明 |
|---|---|
| via | `last_assign`（末条赋值，输出变量名是动态的）/ `return` / `reply` / `last_call` |
| assigned_name | 末条赋值的变量名（如 final_result、output —— 仅作记录，名字无特殊语义）；其他形态为 null |
| output | 输出值（Value 对象）；via=last_call 时为 null |
| output_step | 仅 via=last_call 时指向产生输出的 step id |

⚠️ terminals 可能为空（推断失败），此时 warnings 中必有说明。T2 应报错或提示，勿静默。

## 5. variables

​```json
{ "probe": ["reasoninggroup"], "answer": ["calculatorgroup", "searchgroup"] }
​```

- 变量 → 当前可达的 call step id 列表，按出现顺序，**一对多**。
- 长度 > 1 = 变量在多个分支中被赋值；是否引入变量聚合由 T2 决策。
- 纯别名赋值（x = y）使 x 继承 y 的产出列表。
- 常量、模板和无调用生产者的别名见 `bindings`，不会伪造 step id。
- T2 生成 value_selector 路径：Value.refs → 查本表得节点 id → 查函数注册表 outputs 得字段名。

## 6. inputs

​```json
[ { "name": "task", "type": "paragraph" } ]
​```

推断规则：未赋值先使用的变量。type 为启发式（名字含 file → "file"，否则 "paragraph"），
T2 可按注册表覆盖。

调用 `compile_to_semantics()` 时也可通过 `input_types` 显式指定变量类型；显式配置优先于名称启发式。

## 7. 错误与降级三档

| 档 | 触发 | 行为 |
|---|---|---|
| 硬错误 | 语法错误；for/while/try/class/with/装饰器；多目标赋值；**kwargs | 抛 PseudoCodeError（带行号） |
| 硬错误 | 同一路径重复赋值；覆盖已推断的输入变量 | 抛 PseudoCodeError（带行号） |
| 软降级 | 无法结构化的表达式 / 条件；部分路径未定义；不可达代码；死变量 | 正常输出 + warnings |
| 推断警告 | terminals 推断失败或存疑 | warnings 说明依据 |

## 8. 版本演进

- 顶层八字段结构保持稳定；破坏性变更升 version。
- 新表达式/条件形态通过新增 expr 枚举实现，旧消费方按 raw 降级兼容。
- 契约变更流程：改测试样例 → 跑通 → diff 通知 T2。
