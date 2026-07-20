# T1 解析器设计文档（pseudocode_parser.py）

## 1. 定位与边界

| 项 | 内容 |
|---|---|
| 任务 | T1 Python 解析，覆盖 A1 → A3 |
| 输入 | AgentNetwork 输出的 Python 伪代码文本（str） |
| 输出 | 流程语义对象（契约 v1，见 flow_semantics_contract_v1.md） |
| 依赖 | 仅 Python 标准库（3.10+），**不使用任何 Dify 代码** |
| 下游 | T2 Dify graph 生成 |

边界原则：本模块只记录 Python 语义"事实"（谁调谁、谁产出什么、条件是什么），
不做任何 Dify 映射决策（节点类型、操作符翻译、变量聚合均归 T2）。

## 2. 架构：两层流水线

​```
compile_to_semantics(source)
 ├── parse_pseudocode(source)          A1 -> A2
 │     文本 --ast.parse--> AST --_stmt/_value/_condition--> 结构化语句列表
 └── build_flow_semantics(parsed)      A2 -> A3
       语句列表 --SemanticsBuilder--> 流程语义对象
​```

两层可独立测试。A2 层是纯语法结构化；A3 层做需要全局视野的语义工作：
输入推断、终止推断、变量产出追踪、执行序列、普通赋值绑定、id 分配、告警收集。

## 3. 关键实现决策

### 3.1 上游语言模型（已与上游确认）
- 代码里只有两种东西：变量（上下文中的值）和函数（智能体入口，无需定义）。
- 变量名即数据流：谁产出、谁消费 = 数据依赖边。
- 未赋值先使用的变量 = 用户输入。
- 输出变量名动态（final_result / output / ...），需推断。
- 条件固定为「上下文取值 + 比较符 + 值」。

### 3.2 终止推断（_walk 的 tail 参数）
- 末条顶层语句决定输出：末条赋值 → last_assign；return → return；
  末条独立调用 → last_call；reply(...) 任意位置 → reply。
- tail 标志沿末条 if 语句传播进分支体 → 天然支持多终点。
- terminal id 会进入所在顶层/分支 body，T2 可以确定每个终点的控制流归属。
- return/reply 终止当前语句块；其后的不可达代码忽略并告警。
- 推断失败：terminals 为空 + warnings 说明，不静默。
- 辅助校验 _check_dead_vars：死变量告警，兼作输出推断纠错信号。

### 3.3 表达式建模（_value）
4 种 Value：var / const / template / raw。设计要点：
- **template（f-string）保留"文本片段 + 变量插值"交替结构**——它就是未来的
  prompt 模板，压成字符串会使 T2 无法做变量替换。转义花括号 {{}} 由 ast
  还原为普通花括号并留在文本片段中。
- **raw 兜底**：任何认不出的表达式落 raw，refs（排除函数调用名）保证
  数据依赖仍可追踪。这是"降级不崩溃"的实现基础。
- 非 JSON 基础常量以及带 `!r`/format spec 的 f-string 统一降级 raw，保证输出可序列化且不伪造语义。

### 3.4 条件解析（_condition / _atom / _getter）
- _getter 只认两种取值形态：`x` 与 `x.get("k")`（单字符串参数、无默认值）。
- _atom 输出原子比较三元组 {var, key, op, value}；op 保留 Python 原文。
- BoolOp 拆 and/or；混用（嵌套 BoolOp）→ 整体降级 parsed:false。
- 有意排除：多级取值、算术、条件内调函数——第一版语法由我们规定，
  上游按约束生成，不需要兜住任意 Python。

### 3.5 分支处理（_add_branch）
- elif 链在 A2 层拍平为 cases 列表。
- branch step 先入 steps 再走分支体 → 保证"branch 排在分支体之前"的契约承诺。
- 作用域：各 case 从同一 assigned/producers 快照出发（互不可见）。
- 分支结束后，assigned 取所有路径交集；只在部分路径赋值的变量不会被误判为确定定义。
- producers 按路径合并为一对多；后续引用部分定义变量会产生明确 warnings。
- 变量一对多：producers[var] 为列表，多分支赋同一变量时依次追加。
- 别名传递：x = y 时 x 继承 y 的产出列表（final_result = answer 即此场景）。

### 3.6 执行序列与普通赋值
- `_walk()` 返回有序对象 id；顶层结果写入 `body`，分支结果写入 case body。
- 调用与 branch 位于 `steps`，普通赋值位于 `bindings`，终点位于 `terminals`。
- binding 保存 Value 和发生赋值时的调用 producer 快照，常量、模板、输入别名不再丢失；
  binding 自身不会被伪装成 step producer。
- 第一版拒绝同一路径重复赋值，避免一个变量在不同 use-site 指向不同生产者。

### 3.7 id 分配
- call step：函数名小写；重名追加 _2、_3（_new_id 计数）。
- branch：branch_1、branch_2 递增。
- terminal：terminal_1 递增。
- binding：binding_1 递增。
- case_id：case_1..case_n 与 else，纯内部标识，与 Dify handle 无绑定。

## 4. 错误处理三档

| 档 | 实现 | 例子 |
|---|---|---|
| 硬错误 | raise PseudoCodeError(msg, lineno) | 不支持语句、语法错误、多目标赋值、**kwargs、同路径重复赋值 |
| 软降级 | 输出 raw / parsed:false + warnings | 复杂表达式、and/or 混用、不可达代码 |
| 推断警告 | warnings | 部分路径未定义、terminals 为空、死变量 |

对应验收标准 11.2："明确错误或降级输出，而不是静默生成错误代码"。

## 5. 已知简化与后续路线

| 项 | 现状 | 后续 |
|---|---|---|
| 注释 | ast 丢弃，节点标题由函数名+注册表出 | 如需注释做标题，评估 libcst |
| 嵌套函数调用 Func(g(x)) | 降级 raw | 如上游确实产生，加 A-normal form 脱糖 pass |
| for / while | 硬错误 | 对应 Dify iteration/loop，第二版 |
| 取值形态 | 仅 x 与 x.get("k") | 按需扩 x["k"]（加一个 _getter 分支即可） |
| 变量重赋值 | 同一路径硬错误；不同分支允许并合并 producers | 如必须支持，引入 SSA 或 use-site reaching definitions |
| 终点函数 | 默认 `{"reply"}`，可通过 `terminal_functions` 覆盖；传空集合可禁用 | 按上游语言约定配置 |
| 输入类型 | 默认按名称推断：含 `file` 为 `file`，否则为 `paragraph` | 可通过 `input_types` 精确覆盖 |

## 6. 测试

见 test_pseudocode_parser.py（pytest）。样例即活契约：
- 官方示例（TestOfficialDemo）与文档示例（TestDocDemo）逐字段断言，必须过；
- 另覆盖 elif / and / or / 全操作符 / truthy / falsy / 三种终止 / 动态输出名 /
  多终点 / 嵌套分支 / bindings / 确定赋值 / 不可达代码 / JSON 安全降级 /
  各类警告与硬错误 / 重名函数 / 别名 / 分层独测。

运行：`python -m pytest test_pseudocode_parser.py -v`

---

## 使用说明

路径 1：正常使用（未来 T2/T6 走这条）

```python
# 任何需要解析功能的代码里
from pseudocode_parser import compile_to_semantics

result = compile_to_semantics(上游给的伪代码文本)
# result 就是那个 JSON，交给下游
```


路径 2：质检（只有你走，改完代码就跑）

```powershell
python -m pytest test_pseudocode_parser.py -v
```

注意路径 2 里你从不 import 测试文件、从不在别的代码里调用它——pytest 会自己找到所有 test_ 开头的函数去执行。测试文件是"终点站"，没有任何代码依赖它。



