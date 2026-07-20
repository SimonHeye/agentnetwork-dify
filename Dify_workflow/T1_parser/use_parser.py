"""
T1 解析器实验脚本：解析上游伪代码，查看输出 JSON
用法:
    python use_parser.py                     # 解析内置示例
    python use_parser.py sample.py     # 解析指定文件
"""
import json
import sys

from pseudocode_parser import compile_to_semantics, PseudoCodeError

DEFAULT_SOURCE = r'''
probe = ReasoningGroup(
    task=f"判断下面的用户需求属于「事实查询」还是「数值计算」，"
         f"只返回 JSON：{{\"kind\": \"search\"}} 或 {{\"kind\": \"calc\"}}。\n需求：{task}"
)

if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)

final_result = answer
'''
def main():
    if len(sys.argv) > 1:                      # 传了文件路径就读文件
        with open(sys.argv[1], encoding="utf-8") as f:
            source = f.read()
        print(f"── 解析文件: {sys.argv[1]} ──\n")
    else:
        source = DEFAULT_SOURCE
        print("── 解析内置示例 ──\n")

    try:
        result = compile_to_semantics(source)
    except PseudoCodeError as e:
        print(f"❌ 解析失败: {e}")
        return

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result["warnings"]:
        print("\n⚠️ 警告:")
        for w in result["warnings"]:
            print(f"  - {w}")

if __name__ == "__main__":
    main()