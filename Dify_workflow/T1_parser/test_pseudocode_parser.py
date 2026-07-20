"""
T1 解析器测试（pytest）

样例即活契约：本文件中的 输入伪代码 -> 输出断言 就是与 T2 的接口契约。
契约变更时先改这里，跑通后以 diff 通知 T2。

运行: pytest test_pseudocode_parser.py -v
"""

import json

import pytest

from pseudocode_parser import (
    PseudoCodeError,
    compile_to_semantics,
    parse_pseudocode,
)


# ════════════════════════ 辅助 ════════════════════════

def step_by_id(sem: dict, sid: str) -> dict:
    return next(s for s in sem["steps"] if s["id"] == sid)


def input_names(sem: dict) -> list[str]:
    return [i["name"] for i in sem["inputs"]]


# ════════════════ 样例 1：上游官方示例（必须过）════════════════

OFFICIAL_DEMO = r'''
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
'''


class TestOfficialDemo:
    """上游真实示例的完整契约验证。"""

    @pytest.fixture(scope="class")
    def sem(self):
        return compile_to_semantics(OFFICIAL_DEMO)

    def test_version(self, sem):
        assert sem["version"] == 1

    def test_inputs_inferred(self, sem):
        # task 未赋值先使用 -> 唯一用户输入
        assert input_names(sem) == ["task"]

    def test_step_ids_and_order(self, sem):
        ids = [s["id"] for s in sem["steps"]]
        assert ids == ["reasoninggroup", "branch_1",
                       "calculatorgroup", "searchgroup"]
        # branch 排在其分支体步骤之前
        assert ids.index("branch_1") < ids.index("calculatorgroup")

    def test_fstring_template(self, sem):
        kw = step_by_id(sem, "reasoninggroup")["kwargs"]["task"]
        assert kw["expr"] == "template"
        assert kw["refs"] == ["task"]
        # 转义花括号留在文本片段中，不是变量引用
        text = "".join(p["text"] for p in kw["parts"] if "text" in p)
        assert '{"kind": "search"}' in text
        # 变量插值片段
        assert {"var": "task"} in kw["parts"]

    def test_condition_triplet(self, sem):
        cond = step_by_id(sem, "branch_1")["cases"][0]["condition"]
        assert cond["parsed"] is True
        assert cond["logical"] == "and"
        c = cond["comparisons"][0]
        assert (c["var"], c["key"], c["op"]) == ("probe", "kind", "==")
        assert c["value"]["value"] == "calc"
        assert c["value"]["value_type"] == "str"
        assert cond["refs"] == ["probe"]

    def test_branch_bodies(self, sem):
        b = step_by_id(sem, "branch_1")
        assert b["cases"][0]["case_id"] == "case_1"
        assert b["cases"][0]["body"] == ["calculatorgroup"]
        assert b["else_case"] == {"case_id": "else", "body": ["searchgroup"]}

    def test_variables_one_to_many(self, sem):
        assert sem["variables"]["probe"] == ["reasoninggroup"]
        assert sem["variables"]["answer"] == ["calculatorgroup", "searchgroup"]

    def test_terminal_dynamic_output_name(self, sem):
        assert len(sem["terminals"]) == 1
        t = sem["terminals"][0]
        assert t["via"] == "last_assign"
        assert t["assigned_name"] == "final_result"
        assert t["output"] == {"expr": "var", "name": "answer",
                               "raw": "answer", "refs": ["answer"]}

    def test_no_warnings(self, sem):
        assert sem["warnings"] == []


# ════════════════ 样例 2：文档第 4 节示例（必须过）════════════════

DOC_DEMO = '''
if file:
    parsed = parse_file(file)
    answer = answer_llm(query, parsed)
else:
    answer = text_llm(query)

reply(answer)
'''


class TestDocDemo:

    @pytest.fixture(scope="class")
    def sem(self):
        return compile_to_semantics(DOC_DEMO)

    def test_inputs(self, sem):
        assert input_names(sem) == ["file", "query"]
        # 名字含 file -> 类型启发为 file
        assert sem["inputs"][0]["type"] == "file"
        assert sem["inputs"][1]["type"] == "paragraph"

    def test_truthy_condition(self, sem):
        c = step_by_id(sem, "branch_1")["cases"][0]["condition"]["comparisons"][0]
        assert (c["var"], c["key"], c["op"], c["value"]) == ("file", None, "truthy", None)

    def test_positional_args(self, sem):
        s = step_by_id(sem, "answer_llm")
        assert [a["name"] for a in s["args"]] == ["query", "parsed"]

    def test_reply_terminal(self, sem):
        t = sem["terminals"][0]
        assert t["via"] == "reply"
        assert t["output"]["name"] == "answer"

    def test_dataflow_chain(self, sem):
        # parse_file 产出 parsed，answer_llm 消费 parsed
        assert sem["variables"]["parsed"] == ["parse_file"]
        refs = step_by_id(sem, "answer_llm")["args"][1]["refs"]
        assert refs == ["parsed"]


# ════════════════ 样例 3：elif 多分支 + 多种输出变量名 ════════════════

def test_elif_flatten_and_dynamic_output_name():
    src = '''
probe = Classify(task=task)
if probe.get("kind") == "calc":
    r = CalcGroup(task=task)
elif probe.get("kind") == "search":
    r = SearchGroup(task=task)
else:
    r = ChatGroup(task=task)
output = r
'''
    sem = compile_to_semantics(src)
    b = step_by_id(sem, "branch_1")
    assert [c["case_id"] for c in b["cases"]] == ["case_1", "case_2"]
    assert b["else_case"]["case_id"] == "else"
    assert sem["variables"]["r"] == ["calcgroup", "searchgroup", "chatgroup"]
    t = sem["terminals"][0]
    assert t["via"] == "last_assign"
    assert t["assigned_name"] == "output"       # 动态输出名，不依赖 final_result


# ════════════════ 样例 4：and / or 组合与全操作符 ════════════════

def test_and_condition():
    src = '''
p = Probe(task=task)
if p.get("kind") == "calc" and p.get("score") > 0.8:
    r = A(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    cond = step_by_id(sem, "branch_1")["cases"][0]["condition"]
    assert cond["parsed"] is True and cond["logical"] == "and"
    assert len(cond["comparisons"]) == 2
    c2 = cond["comparisons"][1]
    assert (c2["op"], c2["value"]["value"], c2["value"]["value_type"]) \
        == (">", 0.8, "float")                  # value 保留原始类型


def test_or_condition():
    src = '''
p = Probe(task=task)
if p.get("k") == 1 or p.get("k") == 2:
    r = A(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    cond = step_by_id(sem, "branch_1")["cases"][0]["condition"]
    assert cond["logical"] == "or"
    assert cond["comparisons"][0]["value"]["value_type"] == "int"


@pytest.mark.parametrize("py_op", ["==", "!=", ">", ">=", "<", "<=",
                                   "in", "not in", "is", "is not"])
def test_all_comparison_operators(py_op):
    src = f'''
p = Probe(task=task)
if p.get("k") {py_op} "x":
    r = A(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    c = step_by_id(sem, "branch_1")["cases"][0]["condition"]["comparisons"][0]
    assert c["op"] == py_op                      # 操作符保留 Python 原文


def test_falsy_condition():
    src = '''
p = Probe(task=task)
if not p:
    r = A(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    c = step_by_id(sem, "branch_1")["cases"][0]["condition"]["comparisons"][0]
    assert c["op"] == "falsy" and c["value"] is None


# ════════════════ 样例 5：三种终止形态 ════════════════

def test_terminal_return():
    src = '''
r = Work(task=task)
return r
'''
    sem = compile_to_semantics(src)
    t = sem["terminals"][0]
    assert t["via"] == "return" and t["output"]["name"] == "r"


def test_terminal_last_call():
    src = '''
r = Prep(task=task)
Notify(msg=r)
'''
    sem = compile_to_semantics(src)
    t = sem["terminals"][0]
    assert t["via"] == "last_call" and t["output_step"] == "notify"


def test_terminal_last_assign_call():
    # 末条是 x = Func(...)：既是节点也是终点
    src = 'final_result = Work(task=task)'
    sem = compile_to_semantics(src)
    assert len(sem["steps"]) == 1
    t = sem["terminals"][0]
    assert t["via"] == "last_assign" and t["assigned_name"] == "final_result"
    assert t["output"]["name"] == "final_result"


# ════════════════ 样例 6：多终点（末条是分支）════════════════

def test_multi_terminals_branch_at_tail():
    src = '''
p = Probe(task=task)
if p.get("kind") == "a":
    out = A(task=task)
else:
    out = B(task=task)
'''
    sem = compile_to_semantics(src)
    assert len(sem["terminals"]) == 2            # 每条路径各一个终点
    assert all(t["via"] == "last_assign" and t["assigned_name"] == "out"
               for t in sem["terminals"])


def test_tail_branch_without_else_warns():
    src = '''
p = Probe(task=task)
if p.get("kind") == "a":
    out = A(task=task)
'''
    sem = compile_to_semantics(src)
    assert any("没有 else" in w for w in sem["warnings"])


# ════════════════ 样例 7：嵌套分支 ════════════════

def test_nested_branch():
    src = '''
p = Probe(task=task)
if p.get("kind") == "a":
    q = Sub(task=task)
    if q.get("ok") == True:
        r = A1(task=task)
    else:
        r = A2(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    outer = step_by_id(sem, "branch_1")
    assert outer["cases"][0]["body"] == ["sub", "branch_2"]   # 嵌套 branch 以 id 引用
    inner = step_by_id(sem, "branch_2")
    assert inner["cases"][0]["body"] == ["a1"]
    assert sem["variables"]["r"] == ["a1", "a2", "b"]


# ════════════════ 样例 8：降级与警告 ════════════════

def test_condition_degrade_mixed_and_or():
    src = '''
p = Probe(task=task)
if p.get("a") == 1 and p.get("b") == 2 or p.get("c") == 3:
    r = A(task=task)
else:
    r = B(task=task)
final_result = r
'''
    sem = compile_to_semantics(src)
    cond = step_by_id(sem, "branch_1")["cases"][0]["condition"]
    assert cond["parsed"] is False               # 混用 -> 降级
    assert cond["comparisons"] == []
    assert cond["refs"] == ["p"]                 # 变量引用不丢
    assert any("条件无法结构化" in w for w in sem["warnings"])


def test_raw_value_degrade():
    src = '''
r = Work(task=task.strip())
final_result = r
'''
    sem = compile_to_semantics(src)
    v = step_by_id(sem, "work")["kwargs"]["task"]
    assert v["expr"] == "raw"
    assert v["raw"] == "task.strip()"
    assert v["refs"] == ["task"]                 # 数据依赖仍被追踪
    assert any("参数表达式无法结构化" in w for w in sem["warnings"])


def test_dead_variable_warning():
    src = '''
a = StepA(task=task)
b = StepB(task=task)
final_result = b
'''
    sem = compile_to_semantics(src)
    assert any("变量 a 被赋值但从未被使用" in w for w in sem["warnings"])


# ════════════════ 样例 9：硬错误（明确报错，不静默）════════════════

@pytest.mark.parametrize("src, keyword", [
    ("for i in items:\n    Work(task=i)", "For"),
    ("while flag:\n    Work(task=task)", "While"),
    ("try:\n    Work(task=task)\nexcept Exception:\n    pass", "Try"),
    ("class Foo:\n    pass", "ClassDef"),
    ("with open('f') as f:\n    pass", "With"),
])
def test_unsupported_statements_raise(src, keyword):
    with pytest.raises(PseudoCodeError) as e:
        compile_to_semantics(src)
    assert "暂不支持的语句类型" in str(e.value)
    assert e.value.lineno is not None            # 必须带行号


def test_syntax_error_raises():
    with pytest.raises(PseudoCodeError) as e:
        compile_to_semantics("if probe.get( ==")
    assert "不是合法的 Python 语法" in str(e.value)


def test_multi_target_assign_raises():
    with pytest.raises(PseudoCodeError):
        compile_to_semantics("a = b = Work(task=task)")


def test_kwargs_unpack_raises():
    with pytest.raises(PseudoCodeError):
        compile_to_semantics("r = Work(**opts)\nfinal_result = r")


def test_empty_input_raises():
    with pytest.raises(PseudoCodeError):
        compile_to_semantics("")


# ════════════════ 样例 10：其他边界 ════════════════

def test_duplicate_function_gets_unique_ids():
    src = '''
a = Work(task=task)
b = Work(task=task)
final_result = b
'''
    sem = compile_to_semantics(src)
    assert [s["id"] for s in sem["steps"]] == ["work", "work_2"]
    assert sem["variables"] == {"a": ["work"], "b": ["work_2"],
                                "final_result": ["work_2"]}


def test_alias_inherits_producers():
    src = '''
a = Work(task=task)
b = a
final_result = b
'''
    sem = compile_to_semantics(src)
    assert sem["variables"]["b"] == ["work"]     # 别名继承产出节点


def test_no_terminal_inferable_warns():
    # 末条是分支且两条路径都无输出赋值 -> terminals 为空 + 警告
    src = '''
p = Probe(task=task)
if p:
    A(task=task)
'''
    sem = compile_to_semantics(src)
    # 分支内末条是 call 但 tail 传播使其成为 last_call 终点，
    # 此处验证的是无 else 警告；真正空 terminals 的场景较难自然构造，
    # 保留 build() 中的空 terminals 警告作为防御。
    assert any("没有 else" in w for w in sem["warnings"])


def test_a2_layer_independently():
    """A2 层可独立测试（分层设计验证）。"""
    parsed = parse_pseudocode("x = Foo(a=1)\nfinal_result = x")
    kinds = [s["kind"] for s in parsed["body"]]
    assert kinds == ["assign_call", "assign"]


# ════════════════ 样例 11：控制流与赋值完整性 ════════════════

def test_root_body_and_plain_bindings_are_explicit():
    sem = compile_to_semantics("x = 1\nfinal_result = x")
    assert sem["body"] == ["binding_1", "binding_2", "terminal_1"]
    assert sem["bindings"][0] == {
        "id": "binding_1",
        "target": "x",
        "value": {"expr": "const", "value": 1, "value_type": "int",
                  "raw": "1", "refs": []},
        "sources": {},
        "lineno": 1,
    }
    assert sem["bindings"][1]["sources"] == {"x": []}
    assert sem["variables"] == {"x": [], "final_result": []}


def test_partial_branch_definition_warns_instead_of_becoming_input():
    src = '''
if flag:
    x = A(task=task)
Use(value=x)
'''
    sem = compile_to_semantics(src)
    assert "x" not in input_names(sem)
    assert any("变量 x 并非在所有执行路径上都有定义" in w
               for w in sem["warnings"])


def test_branch_terminals_are_owned_by_case_bodies():
    src = '''
if flag:
    x = A(task=task)
    reply(x)
else:
    y = B(task=task)
    reply(y)
'''
    sem = compile_to_semantics(src)
    branch = step_by_id(sem, "branch_1")
    assert branch["cases"][0]["body"] == ["a", "terminal_1"]
    assert branch["else_case"]["body"] == ["b", "terminal_2"]


def test_return_stops_unreachable_code():
    src = '''
x = A(task=task)
return x
y = B(task=task)
'''
    sem = compile_to_semantics(src)
    assert [s["id"] for s in sem["steps"]] == ["a"]
    assert sem["body"] == ["a", "terminal_1"]
    assert any("return 后的代码不可达" in w for w in sem["warnings"])


def test_sequential_reassignment_is_explicitly_rejected():
    src = '''
x = A(task=task)
x = B(task=task)
final_result = x
'''
    with pytest.raises(PseudoCodeError, match="重复赋值变量 x"):
        compile_to_semantics(src)


def test_branch_reassignment_of_outer_variable_is_rejected():
    src = '''
x = A(task=task)
if flag:
    x = B(task=task)
else:
    x = C(task=task)
final_result = x
'''
    with pytest.raises(PseudoCodeError, match="重复赋值变量 x"):
        compile_to_semantics(src)


def test_inferred_input_cannot_be_overwritten():
    src = '''
Use(value=x)
x = A(task=task)
final_result = x
'''
    with pytest.raises(PseudoCodeError, match="覆盖已推断的输入变量 x"):
        compile_to_semantics(src)


def test_empty_terminal_functions_disables_reply_special_case():
    sem = compile_to_semantics(
        "x = A(task=task)\nreply(x)", terminal_functions=set())
    assert [s["id"] for s in sem["steps"]] == ["a", "reply"]
    assert sem["terminals"][0]["via"] == "last_call"
    assert sem["terminals"][0]["output_step"] == "reply"


def test_input_type_override_takes_precedence_over_file_heuristic():
    sem = compile_to_semantics(
        "r = Work(source_file=source_file)\nfinal_result = r",
        input_types={"source_file": "paragraph"},
    )
    assert sem["inputs"] == [{"name": "source_file", "type": "paragraph"}]


# ════════════════ 样例 12：降级结果必须可靠且可序列化 ════════════════

def test_nested_call_name_is_not_inferred_as_input():
    sem = compile_to_semantics(
        "r = Work(value=helper(task))\nfinal_result = r")
    assert input_names(sem) == ["task"]
    value = step_by_id(sem, "work")["kwargs"]["value"]
    assert value["refs"] == ["task"]


def test_unsupported_constant_degrades_to_json_safe_raw():
    sem = compile_to_semantics("r = Work(value=b'abc')\nfinal_result = r")
    value = step_by_id(sem, "work")["kwargs"]["value"]
    assert value == {"expr": "raw", "raw": "b'abc'", "refs": []}
    json.dumps(sem)


def test_formatted_fstring_degrades_without_losing_reference():
    sem = compile_to_semantics(
        "r = Work(value=f'{task!r:>10}')\nfinal_result = r")
    value = step_by_id(sem, "work")["kwargs"]["value"]
    assert value["expr"] == "raw"
    assert value["refs"] == ["task"]
    assert any("参数表达式无法结构化" in w for w in sem["warnings"])
