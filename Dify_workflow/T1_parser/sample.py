# 命名空间已注入：各 vertex 函数、task（用户任务字符串）、final_result（输出约定）
# 语义：先让入口节点判定任务类型，再按判定结果走不同的单一下游。
# 函数中的变量都会从上下文中获取或者放入上下文

# ① 入口：决策节点
probe = ReasoningGroup(
    task=f"判断下面的用户需求属于「事实查询」还是「数值计算」，"
         f"只返回 JSON：{{\"kind\": \"search\"}} 或 {{\"kind\": \"calc\"}}。\n需求：{task}"
)

# ② 分支：唯一的控制流
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task) 

# ③ 输出约定
final_result = answer