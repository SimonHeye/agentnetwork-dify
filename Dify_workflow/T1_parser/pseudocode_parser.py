"""
T1: Python 伪代码解析器（A1 -> A3）

链路位置:
    Python 伪代码文本 --[A1->A2 parse_pseudocode]--> 结构化语句列表
                      --[A2->A3 build_flow_semantics]--> 流程语义对象(契约 v1)

对外入口:
    compile_to_semantics(source: str) -> dict     A1->A3 一步到位
    parse_pseudocode(source: str) -> dict         仅 A1->A2
    build_flow_semantics(parsed: dict) -> dict    仅 A2->A3

约束:
    - 仅依赖 Python 标准库 (3.10+)，不使用任何 Dify 代码
    - 输出契约见 docs/flow_semantics_contract_v1.md
    - 无法解析: 硬错误抛 PseudoCodeError(带行号)，软问题降级并写入 warnings
"""

import ast

CONTRACT_VERSION = 1

# 默认终点函数只是可配置的解析选项，不属于伪代码语言的固定业务规则。
DEFAULT_TERMINAL_FUNCTIONS = frozenset({"reply"})


# ─────────────────────────── 错误定义 ───────────────────────────

class PseudoCodeError(Exception):
    """硬错误：带行号的明确报错，绝不静默。"""

    def __init__(self, message: str, lineno: int | None = None):
        self.lineno = lineno
        super().__init__(f"第 {lineno} 行: {message}" if lineno else message)


# ─────────────────────────── 通用工具 ───────────────────────────

def _seg(src: str, node: ast.AST) -> str:
    """取表达式在源码中的原文（用于 raw 字段）。"""
    return ast.get_source_segment(src, node) or ast.unparse(node)


def _names(node: ast.AST) -> list[str]:
    """收集表达式中真正作为值使用的变量名，排除函数调用名。"""
    names: set[str] = set()

    class RefCollector(ast.NodeVisitor):
        def visit_Name(self, item: ast.Name):
            if isinstance(item.ctx, ast.Load):
                names.add(item.id)

        def visit_Call(self, item: ast.Call):
            # Foo(x) 中 Foo 是智能体入口，不是数据变量；obj.method() 中 obj 仍是引用。
            if not isinstance(item.func, ast.Name):
                self.visit(item.func)
            for arg in item.args:
                self.visit(arg)
            for keyword in item.keywords:
                self.visit(keyword.value)

    RefCollector().visit(node)
    return sorted(names)


_TYPE_NAME = {"str": "str", "int": "int", "float": "float",
              "bool": "bool", "NoneType": "null"}


# ─────────────────── Value 对象（表达式统一建模）────────────────────

def _value(node: ast.expr, src: str) -> dict:
    """任意表达式 -> Value 对象；认不出的统一降级为 expr: raw。"""
    raw = _seg(src, node)

    if isinstance(node, ast.Name):
        return {"expr": "var", "name": node.id, "raw": raw, "refs": [node.id]}

    if isinstance(node, ast.Constant) and type(node.value).__name__ in _TYPE_NAME:
        tname = _TYPE_NAME[type(node.value).__name__]
        return {"expr": "const", "value": node.value,
                "value_type": tname, "raw": raw, "refs": []}

    if isinstance(node, ast.JoinedStr):  # f-string（相邻字符串已被 ast 合并）
        if any(isinstance(v, ast.FormattedValue)
               and (v.conversion != -1 or v.format_spec is not None)
               for v in node.values):
            return {"expr": "raw", "raw": raw, "refs": _names(node)}
        parts: list[dict] = []
        refs: list[str] = []
        for v in node.values:
            if isinstance(v, ast.Constant):            # 字面文本（含转义花括号）
                parts.append({"text": v.value})
            elif isinstance(v, ast.FormattedValue):    # 变量插值
                if isinstance(v.value, ast.Name):
                    parts.append({"var": v.value.id})
                    refs.append(v.value.id)
                else:                                  # 插值内非简单变量 -> 降级片段
                    parts.append({"raw_expr": _seg(src, v.value)})
                    refs.extend(_names(v.value))
        return {"expr": "template", "parts": parts,
                "raw": raw, "refs": sorted(set(refs))}

    return {"expr": "raw", "raw": raw, "refs": _names(node)}


# ─────────────────── Condition 对象（条件解析）────────────────────

_CMP_OPS = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=",
            ast.Gt: ">", ast.GtE: ">=", ast.In: "in", ast.NotIn: "not in",
            ast.Is: "is", ast.IsNot: "is not"}


def _getter(node: ast.expr) -> tuple[str, str | None] | None:
    """识别「上下文取值」形态。

    x            -> (x, None)
    x.get("k")   -> (x, "k")
    其余         -> None
    """
    if isinstance(node, ast.Name):
        return (node.id, None)
    if (isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and len(node.args) == 1
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
            and not node.keywords):
        return (node.func.value.id, node.args[0].value)
    return None


def _atom(node: ast.expr, src: str) -> dict | None:
    """单个原子比较 -> comparison dict；认不出返回 None。"""
    raw = _seg(src, node)

    # 取值 <op> 值
    if (isinstance(node, ast.Compare) and len(node.ops) == 1
            and type(node.ops[0]) in _CMP_OPS):
        left = _getter(node.left)
        if left is None:
            return None
        return {"var": left[0], "key": left[1],
                "op": _CMP_OPS[type(node.ops[0])],
                "value": _value(node.comparators[0], src), "raw": raw}

    # if not x:
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        g = _getter(node.operand)
        if g is None:
            return None
        return {"var": g[0], "key": g[1], "op": "falsy", "value": None, "raw": raw}

    # if x: / if x.get("k"):
    g = _getter(node)
    if g is not None:
        return {"var": g[0], "key": g[1], "op": "truthy", "value": None, "raw": raw}

    return None


def _condition(node: ast.expr, src: str,
               warnings: list[str], lineno: int) -> dict:
    """条件表达式 -> Condition 对象；无法结构化时降级为 parsed: False。"""
    raw = _seg(src, node)
    refs = _names(node)

    if isinstance(node, ast.BoolOp):
        logical = "and" if isinstance(node.op, ast.And) else "or"
        items = node.values  # and/or 混用会产生嵌套 BoolOp -> _atom 兜不住 -> 降级
    else:
        logical = "and"
        items = [node]

    comparisons = []
    for it in items:
        a = _atom(it, src)
        if a is None:
            warnings.append(f"第 {lineno} 行: 条件无法结构化，降级保留原文: {raw}")
            return {"parsed": False, "logical": None,
                    "comparisons": [], "raw": raw, "refs": refs}
        comparisons.append(a)

    return {"parsed": True, "logical": logical,
            "comparisons": comparisons, "raw": raw, "refs": refs}


# ─────────────────── A1 -> A2：解析 Python 结构 ────────────────────

def parse_pseudocode(source: str) -> dict:
    """伪代码文本 -> {"body": [语句...], "warnings": [...]}"""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise PseudoCodeError(f"不是合法的 Python 语法: {e.msg}", e.lineno)
    warnings: list[str] = []
    body = [_stmt(s, source, warnings) for s in tree.body]
    return {"body": body, "warnings": warnings}


def _call_parts(call: ast.Call, src: str, lineno: int):
    args = [_value(a, src) for a in call.args]
    kwargs: dict[str, dict] = {}
    for kw in call.keywords:
        if kw.arg is None:
            raise PseudoCodeError("暂不支持 **kwargs 展开", lineno)
        kwargs[kw.arg] = _value(kw.value, src)
    return args, kwargs


def _stmt(node: ast.stmt, src: str, warnings: list[str]) -> dict:
    # x = ...
    if isinstance(node, ast.Assign):
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            raise PseudoCodeError("赋值目标只支持单个变量名", node.lineno)
        target = node.targets[0].id
        v = node.value
        if isinstance(v, ast.Call) and isinstance(v.func, ast.Name):  # x = Func(...)
            args, kwargs = _call_parts(v, src, node.lineno)
            return {"kind": "assign_call", "target": target, "func": v.func.id,
                    "args": args, "kwargs": kwargs, "lineno": node.lineno}
        return {"kind": "assign", "target": target,                   # x = y / 常量 / f"..."
                "value": _value(v, src), "lineno": node.lineno}

    # Func(...) 独立调用
    if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)):
        args, kwargs = _call_parts(node.value, src, node.lineno)
        return {"kind": "call", "func": node.value.func.id,
                "args": args, "kwargs": kwargs, "lineno": node.lineno}

    # if / elif / else —— elif 链拍平为 cases 列表
    if isinstance(node, ast.If):
        cases, cur = [], node
        while True:
            cases.append({
                "condition": _condition(cur.test, src, warnings, cur.lineno),
                "body": [_stmt(s, src, warnings) for s in cur.body],
                "lineno": cur.lineno,
            })
            if len(cur.orelse) == 1 and isinstance(cur.orelse[0], ast.If):
                cur = cur.orelse[0]  # elif
            else:
                break
        orelse = [_stmt(s, src, warnings) for s in cur.orelse]
        return {"kind": "if", "cases": cases, "orelse": orelse,
                "lineno": node.lineno}

    if isinstance(node, ast.Return):
        value = _value(node.value, src) if node.value else None
        return {"kind": "return", "value": value, "lineno": node.lineno}

    raise PseudoCodeError(
        f"暂不支持的语句类型: {type(node).__name__}"
        f"（第一版仅支持 赋值 / 函数调用 / if-elif-else / return）", node.lineno)


# ─────────────────── A2 -> A3：识别流程语义 ────────────────────

class SemanticsBuilder:
    """把语句列表转换为流程语义对象（契约 v1）。一次性使用。"""

    def __init__(
        self,
        *,
        terminal_functions: set[str] | frozenset[str] | None = None,
        input_types: dict[str, str] | None = None,
    ):
        self.steps: list[dict] = []
        self.producers: dict[str, list[str]] = {}   # 变量 -> 产出 step id 列表（一对多）
        self.assigned: set[str] = set()             # 当前作用域已赋值变量
        self.consumed: set[str] = set()             # 被消费过的变量
        self.inputs: dict[str, None] = {}           # 推断的用户输入（dict 保序去重）
        self.terminals: list[dict] = []
        self.bindings: list[dict] = []              # 不生成节点的普通赋值
        self.warnings: list[str] = []
        self._ever_assigned: set[str] = set()
        self._possibly_undefined_warned: set[str] = set()
        self._terminal_functions = frozenset(
            DEFAULT_TERMINAL_FUNCTIONS
            if terminal_functions is None
            else terminal_functions
        )
        self._input_types = dict(input_types or {})
        self._id_count: dict[str, int] = {}
        self._branch_n = 0
        self._term_n = 0
        self._binding_n = 0

    # ------------------------------ 对外 ------------------------------
    def build(self, parsed: dict) -> dict:
        self.warnings.extend(parsed.get("warnings", []))
        if not parsed["body"]:
            raise PseudoCodeError("输入为空，没有任何语句")
        root_body = self._walk(parsed["body"], tail=True)
        if not self.terminals:
            self.warnings.append(
                "未能推断出流程输出：末条语句不是 赋值 / return / reply，terminals 为空")
        self._check_dead_vars()
        return {
            "version": CONTRACT_VERSION,
            "body": root_body,
            "inputs": [{"name": n, "type": self._guess_type(n)}
                       for n in self.inputs],
            "steps": self.steps,
            "bindings": self.bindings,
            "terminals": self.terminals,
            "variables": self.producers,
            "warnings": self.warnings,
        }

    # --------------------------- 语句块遍历 ---------------------------
    def _walk(self, body: list[dict], tail: bool) -> list[str]:
        """处理一个语句块，返回块内产生的 step id 序列。

        tail=True 表示本块的最后一条语句结束整个流程（终止推断依据）。
        """
        ids: list[str] = []
        n = len(body)
        for i, stmt in enumerate(body):
            last = tail and i == n - 1
            kind = stmt["kind"]

            # reply(...)：任意位置都是终点，不生成 step
            if kind == "call" and stmt["func"] in self._terminal_functions:
                self._register_call_refs(stmt)
                values = [*stmt["args"], *stmt["kwargs"].values()]
                out = values[0] if values else None
                ids.append(self._add_terminal(
                    "reply", output=out, lineno=stmt["lineno"]))
                if i < n - 1:
                    self.warnings.append(
                        f"第 {stmt['lineno']} 行: reply 后的代码不可达，已忽略")
                break

            if kind == "assign_call":
                ids.append(self._add_call(stmt))
                if last:
                    tgt = stmt["target"]
                    ids.append(self._add_terminal(
                        "last_assign", assigned_name=tgt,
                        output={"expr": "var", "name": tgt,
                                "raw": tgt, "refs": [tgt]},
                        lineno=stmt["lineno"]))

            elif kind == "call":
                sid = self._add_call(stmt)
                ids.append(sid)
                if last:
                    ids.append(self._add_terminal(
                        "last_call", output_step=sid,
                        lineno=stmt["lineno"]))

            elif kind == "assign":
                ids.append(self._plain_assign(stmt))
                if last:  # 末条赋值 = 输出约定（输出变量名是动态的）
                    ids.append(self._add_terminal(
                        "last_assign", assigned_name=stmt["target"],
                        output=stmt["value"], lineno=stmt["lineno"]))

            elif kind == "if":
                ids.append(self._add_branch(stmt, tail=last))

            elif kind == "return":
                if stmt["value"]:
                    self._register_refs(stmt["value"]["refs"], stmt["lineno"])
                ids.append(self._add_terminal(
                    "return", output=stmt["value"], lineno=stmt["lineno"]))
                if i < n - 1:
                    self.warnings.append(
                        f"第 {stmt['lineno']} 行: return 后的代码不可达，已忽略")
                break
            else:
                raise PseudoCodeError(f"未知语句 kind: {kind}",
                                      stmt.get("lineno"))
        return ids

    # --------------------------- 各类语句 ---------------------------
    def _add_call(self, stmt: dict) -> str:
        self._register_call_refs(stmt)
        target = stmt.get("target")
        if target:
            self._validate_assignment_target(target, stmt["lineno"])
        for v in [*stmt["args"], *stmt["kwargs"].values()]:
            if v["expr"] == "raw":
                self.warnings.append(
                    f"第 {stmt['lineno']} 行: 参数表达式无法结构化，"
                    f"已降级保留原文: {v['raw']}")
        sid = self._new_id(stmt["func"])
        self.steps.append({
            "id": sid, "kind": "call", "function": stmt["func"],
            "assign_to": stmt.get("target"),
            "args": stmt["args"], "kwargs": stmt["kwargs"],
            "lineno": stmt["lineno"],
        })
        if target:
            # 记录当前 use-site 可达的最新定义；分支合流时再合并为一对多。
            self.producers[target] = [sid]
            self.assigned.add(target)
            self._ever_assigned.add(target)
        return sid

    def _plain_assign(self, stmt: dict) -> str:
        value = stmt["value"]
        self._register_value(value, stmt["lineno"])
        target = stmt["target"]
        self._validate_assignment_target(target, stmt["lineno"])
        if value["expr"] == "raw":
            self.warnings.append(
                f"第 {stmt['lineno']} 行: 赋值表达式无法结构化，"
                f"已降级保留原文: {value['raw']}")
        self._binding_n += 1
        binding_id = f"binding_{self._binding_n}"
        value_sources = self._sources_for_refs(value.get("refs", []))
        self.bindings.append({
            "id": binding_id,
            "target": target,
            "value": value,
            "sources": {name: list(source_ids) for name, source_ids in value_sources.items()},
            "lineno": stmt["lineno"],
        })
        # 普通赋值不生成流程 step，只继承右值引用的调用生产者。
        inherited_producers: list[str] = []
        for producer_ids in value_sources.values():
            for producer_id in producer_ids:
                if producer_id not in inherited_producers:
                    inherited_producers.append(producer_id)
        self.producers[target] = inherited_producers
        self.assigned.add(target)
        self._ever_assigned.add(target)
        return binding_id

    def _add_branch(self, stmt: dict, tail: bool) -> str:
        self._branch_n += 1
        bid = f"branch_{self._branch_n}"
        step = {"id": bid, "kind": "branch", "cases": [],
                "else_case": None, "lineno": stmt["lineno"]}
        self.steps.append(step)  # branch 先入列，保证排在分支体步骤之前

        snapshot = set(self.assigned)  # 各分支作用域互不可见
        producer_snapshot = {k: list(v) for k, v in self.producers.items()}
        path_assigned: list[set[str]] = []
        path_producers: list[dict[str, list[str]]] = []

        for i, case in enumerate(stmt["cases"], 1):
            self.assigned = set(snapshot)
            self.producers = {k: list(v) for k, v in producer_snapshot.items()}
            self._register_condition(case["condition"], case.get("lineno", stmt["lineno"]))
            body_ids = self._walk(case["body"], tail=tail)
            path_assigned.append(set(self.assigned))
            path_producers.append({k: list(v) for k, v in self.producers.items()})
            step["cases"].append({"case_id": f"case_{i}",
                                  "condition": case["condition"],
                                  "body": body_ids})

        self.assigned = set(snapshot)
        self.producers = {k: list(v) for k, v in producer_snapshot.items()}
        else_ids = self._walk(stmt["orelse"], tail=tail)
        path_assigned.append(set(self.assigned))
        path_producers.append({k: list(v) for k, v in self.producers.items()})
        step["else_case"] = {"case_id": "else", "body": else_ids}

        if tail and not stmt["orelse"]:
            self.warnings.append(
                f"第 {stmt['lineno']} 行: 分支位于流程末尾但没有 else，"
                f"存在没有输出的执行路径")

        self.assigned = set.intersection(*path_assigned)
        merged: dict[str, list[str]] = {}
        for mapping in path_producers:
            for name, producer_ids in mapping.items():
                merged.setdefault(name, [])
                for producer_id in producer_ids:
                    if producer_id not in merged[name]:
                        merged[name].append(producer_id)
        self.producers = merged
        return bid

    # ----------------------------- 终点 -----------------------------
    def _add_terminal(self, via: str, output: dict | None = None,
                      assigned_name: str | None = None,
                      output_step: str | None = None,
                      lineno: int | None = None) -> str:
        if output:
            self._register_value(output, lineno)
        self._term_n += 1
        terminal_id = f"terminal_{self._term_n}"
        self.terminals.append({
            "id": terminal_id, "via": via,
            "assigned_name": assigned_name, "output": output,
            "output_step": output_step, "lineno": lineno,
        })
        return terminal_id

    # ------------------------ 变量登记与校验 ------------------------
    def _register_call_refs(self, stmt: dict):
        for v in [*stmt["args"], *stmt["kwargs"].values()]:
            self._register_value(v, stmt["lineno"])

    def _register_value(self, value: dict, lineno: int | None = None):
        refs = value.get("refs", [])
        self._register_refs(refs, lineno)

    def _register_condition(self, condition: dict, lineno: int | None = None):
        refs = condition.get("refs", [])
        self._register_refs(refs, lineno)
        for comparison in condition.get("comparisons", []):
            value = comparison.get("value")
            if isinstance(value, dict):
                self._register_value(value, lineno)

    def _register_refs(self, refs: list[str], lineno: int | None = None):
        for name in refs:
            self.consumed.add(name)
            if name in self.assigned:
                continue
            if name in self.producers or name in self._ever_assigned:
                if name not in self._possibly_undefined_warned:
                    prefix = f"第 {lineno} 行: " if lineno else ""
                    self.warnings.append(
                        f"{prefix}变量 {name} 并非在所有执行路径上都有定义")
                    self._possibly_undefined_warned.add(name)
                continue
            if name not in self.inputs:
                self.inputs[name] = None  # 未赋值先使用 -> 用户输入

    def _validate_assignment_target(self, target: str, lineno: int):
        if target in self.assigned:
            raise PseudoCodeError(f"同一执行路径中重复赋值变量 {target}", lineno)
        if target in self.inputs:
            raise PseudoCodeError(f"不能覆盖已推断的输入变量 {target}", lineno)

    def _sources_for_refs(self, refs: list[str]) -> dict[str, list[str]]:
        return {name: list(self.producers.get(name, [])) for name in refs}

    def _check_dead_vars(self):
        protected: set[str] = set()
        warned: set[str] = set()
        for t in self.terminals:
            if t["assigned_name"]:
                protected.add(t["assigned_name"])
            if t["output"] and t["output"].get("expr") == "var":
                protected.add(t["output"]["name"])
        for var in self.producers:
            if var not in self.consumed and var not in protected:
                self.warnings.append(
                    f"变量 {var} 被赋值但从未被使用（疑似冗余，或输出推断有误）")
                warned.add(var)
        for binding in self.bindings:
            var = binding["target"]
            if (var not in self.consumed and var not in protected
                    and var not in warned):
                self.warnings.append(
                    f"变量 {var} 被赋值但从未被使用（疑似冗余，或输出推断有误）")

    # ----------------------------- 工具 -----------------------------
    def _new_id(self, func_name: str) -> str:
        base = func_name.lower()
        self._id_count[base] = self._id_count.get(base, 0) + 1
        n = self._id_count[base]
        return base if n == 1 else f"{base}_{n}"

    def _guess_type(self, name: str) -> str:
        if name in self._input_types:
            return self._input_types[name]
        return "file" if "file" in name.lower() else "paragraph"


# ─────────────────────────── 对外入口 ───────────────────────────

def build_flow_semantics(
    parsed: dict,
    *,
    terminal_functions: set[str] | frozenset[str] | None = None,
    input_types: dict[str, str] | None = None,
) -> dict:
    """A2 -> A3：语句列表 -> 流程语义对象。"""
    return SemanticsBuilder(
        terminal_functions=terminal_functions,
        input_types=input_types,
    ).build(parsed)


def compile_to_semantics(
    source: str,
    *,
    terminal_functions: set[str] | frozenset[str] | None = None,
    input_types: dict[str, str] | None = None,
) -> dict:
    """A1 -> A3 一步到位：伪代码文本 -> 流程语义对象（契约 v1）。"""
    return build_flow_semantics(
        parse_pseudocode(source),
        terminal_functions=terminal_functions,
        input_types=input_types,
    )
