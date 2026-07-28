import type { Node } from '@/app/components/workflow/types'
import { compileAgentNetworkPseudocode } from '../compiler'
import { AgentNetworkCompileError } from '../types'

const model = {
  provider: 'test-provider',
  name: 'test-model',
  mode: 'chat',
  completion_params: {},
}

const source = `
probe = ReasoningGroup(
    task=f"判断下面的用户需求属于事实查询还是数值计算，"
         f"只返回 JSON：{{\\"kind\\": \\"search\\"}} 或 {{\\"kind\\": \\"calc\\"}}。\\n需求：{task}"
)
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
`

type GeneratedNodeData = {
  variables: Array<Record<string, unknown>>
  prompt_template: Array<{ text: string }>
  cases: Array<{ conditions: Array<Record<string, unknown>> }>
  structured_output_enabled: boolean
  structured_output: {
    schema: {
      properties: Record<string, Record<string, unknown>>
    }
  }
  outputs: Array<{
    variable: string
    value_selector: string[]
    value_type: string
  }>
  model: Record<string, unknown>
  custom_default?: unknown
}

function nodesById(result: ReturnType<typeof compileAgentNetworkPseudocode>): Record<string, Node<GeneratedNodeData>> {
  return Object.fromEntries(result.graph.nodes.map(node => [node.id, node])) as Record<string, Node<GeneratedNodeData>>
}

function edgeKeys(result: ReturnType<typeof compileAgentNetworkPseudocode>) {
  return new Set(result.graph.edges.map(edge => (
    `${edge.source}:${edge.sourceHandle}->${edge.target}:${edge.targetHandle}`
  )))
}

describe('compileAgentNetworkPseudocode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Graph generation', () => {
    it('should compile the AgentNetwork example into a Dify workflow graph', () => {
      const result = compileAgentNetworkPseudocode(source, { model })
      const nodes = nodesById(result)

      expect(Object.keys(nodes)).toEqual([
        'start',
        'reasoninggroup',
        'branch_1',
        'calculatorgroup',
        'searchgroup',
        'terminal_1_calculatorgroup',
        'terminal_1_searchgroup',
      ])
      expect(result.graph.viewport).toEqual({ x: 0, y: 0, zoom: 0.7 })
      expect(nodes.start?.data.variables).toEqual([
        { variable: 'task', label: 'task', type: 'text-input', required: true, max_length: null, options: [] },
      ])
      expect(nodes.reasoninggroup?.data.prompt_template[0]?.text).toContain('{{#start.task#}}')
      expect(nodes.calculatorgroup?.data.type).toBe('llm')
      expect(nodes.branch_1?.data.type).toBe('if-else')
      expect(result.warnings).toEqual([])
    })

    it('should generate structured output and branch selectors', () => {
      const result = compileAgentNetworkPseudocode(source, { model })
      const nodes = nodesById(result)
      const reasoning = nodes.reasoninggroup?.data
      const condition = nodes.branch_1?.data.cases[0]?.conditions[0]

      expect(reasoning?.structured_output_enabled).toBe(true)
      expect(reasoning?.structured_output).toEqual({
        schema: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          required: ['kind'],
          additionalProperties: false,
        },
      })
      expect(condition).toEqual({
        id: 'branch_1_case_1_0',
        varType: 'string',
        variable_selector: ['reasoninggroup', 'structured_output', 'kind'],
        comparison_operator: 'is',
        value: 'calc',
      })
      expect(edgeKeys(result)).toEqual(new Set([
        'start:source->reasoninggroup:target',
        'reasoninggroup:source->branch_1:target',
        'branch_1:case_1->calculatorgroup:target',
        'branch_1:false->searchgroup:target',
        'calculatorgroup:source->terminal_1_calculatorgroup:target',
        'searchgroup:source->terminal_1_searchgroup:target',
      ]))
    })

    it('should generate branch-specific outputs and topological positions', () => {
      const result = compileAgentNetworkPseudocode(source, { model })
      const nodes = nodesById(result)

      expect(nodes.terminal_1_calculatorgroup?.data.outputs[0]).toEqual({
        variable: 'final_result',
        value_selector: ['calculatorgroup', 'text'],
        value_type: 'string',
      })
      expect(nodes.terminal_1_searchgroup?.data.outputs[0]?.value_selector).toEqual(['searchgroup', 'text'])
      expect(nodes.start?.position.x).toBeLessThan(nodes.reasoninggroup!.position.x)
      expect(nodes.reasoninggroup?.position.x).toBeLessThan(nodes.branch_1!.position.x)
      expect(nodes.calculatorgroup?.position.x).toBe(nodes.searchgroup?.position.x)
      expect(nodes.calculatorgroup?.position.y).not.toBe(nodes.searchgroup?.position.y)
    })

    it('should normalize AgentNetwork result.value.get conditions and final outputs', () => {
      const result = compileAgentNetworkPseudocode(`
kind_node = ReasoningGroup(task=task)
kind = kind_node.value.get("kind")
if kind == "calc":
    calc_result = CalculatorGroup(task=task)
    final_result = calc_result.value.get("result")
else:
    search_result = SearchGroup(task=task)
    final_result = search_result.value.get("result")
`, { model })
      const nodes = nodesById(result)

      expect(nodes.reasoninggroup?.data.structured_output.schema.properties.kind).toEqual({ type: 'string' })
      expect(nodes.branch_1?.data.cases[0]?.conditions[0]).toMatchObject({
        variable_selector: ['reasoninggroup', 'structured_output', 'kind'],
        comparison_operator: 'is',
        value: 'calc',
      })
      expect(nodes.calculatorgroup?.data).toMatchObject({ agent_network_group: 'CalculatorGroup' })
      expect(nodes.searchgroup?.data).toMatchObject({ agent_network_group: 'SearchGroup' })
      expect(nodes.terminal_1?.data.outputs[0]?.value_selector).toEqual(['calculatorgroup', 'text'])
      expect(nodes.terminal_2?.data.outputs[0]?.value_selector).toEqual(['searchgroup', 'text'])
    })

    it('should use numeric operators for numeric structured fields', () => {
      const result = compileAgentNetworkPseudocode(`
probe = ReasoningGroup(task=task)
if probe.get("score") >= 0.8:
    answer = HighGroup(task=task)
else:
    answer = LowGroup(task=task)
final_result = answer
`, { model })
      const nodes = nodesById(result)

      expect(nodes.reasoninggroup?.data.structured_output.schema.properties.score).toEqual({ type: 'number' })
      expect(nodes.branch_1?.data.cases[0]?.conditions[0]).toMatchObject({
        varType: 'number',
        comparison_operator: '≥',
        value: '0.8',
      })
    })

    it('should support input conditions and nested branches', () => {
      const result = compileAgentNetworkPseudocode(`
if enabled:
    detail = DetailGroup(task=task)
    if detail.get("ok") == True:
        answer = EnabledGroup(task=task)
    else:
        answer = FallbackGroup(task=task)
else:
    answer = DisabledGroup(task=task)
final_result = answer
`, { model })
      const nodes = nodesById(result)

      expect(nodes.branch_1?.data.cases[0]?.conditions[0]).toMatchObject({
        variable_selector: ['start', 'enabled'],
        comparison_operator: 'not empty',
      })
      expect(edgeKeys(result)).toContain('detailgroup:source->branch_2:target')
      expect(nodes.reasoninggroup).toBeUndefined()
    })

    it('should merge Dify defaults and group overrides without mutating the caller', () => {
      const defaults = {
        type: 'llm',
        config: {
          context: { enabled: false, variable_selector: [] },
          custom_default: 'kept',
        },
      }
      const original = structuredClone(defaults)
      const result = compileAgentNetworkPseudocode(
        'answer = EchoGroup(task=task)\nfinal_result = answer',
        {
          model,
          llmDefaultConfig: defaults,
          groupOverrides: { EchoGroup: { title: 'Echo agent' } },
        },
      )
      const echo = nodesById(result).echogroup

      expect(echo?.data.custom_default).toBe('kept')
      expect(echo?.data.title).toBe('Echo agent')
      expect(defaults).toEqual(original)
    })

    it('should infer a model from the Dify default config', () => {
      const result = compileAgentNetworkPseudocode(
        'answer = EchoGroup(task=task)\nfinal_result = answer',
        { llmDefaultConfig: { model } },
      )

      expect(nodesById(result).echogroup?.data.model).toEqual(model)
    })

    it('should compile the reverse CodeExecution contract back into a Code node', () => {
      const result = compileAgentNetworkPseudocode(`
answer = CodeExecution(
    inputs={"query": task},
    language="python3",
    code="def main(query):\\n    return {\\\"result\\\": query.upper()}",
    outputs={"result": {"type": "string"}},
)
final_result = answer.get("result")
`)
      const nodes = nodesById(result)

      expect(nodes.codeexecution?.data).toMatchObject({
        type: 'code',
        code_language: 'python3',
        variables: [{ variable: 'query', value_selector: ['start', 'task'] }],
        outputs: { result: { type: 'string', children: null } },
      })
      expect(nodes.terminal_1?.data.outputs[0]).toEqual({
        variable: 'final_result',
        value_selector: ['codeexecution', 'result'],
        value_type: 'string',
      })
    })

    it('should compile reply into an Answer node instead of an End node', () => {
      const result = compileAgentNetworkPseudocode(`
answer = EchoGroup(task=task)
reply(f"Result: {answer}")
`, { model })
      const nodes = nodesById(result)

      expect(nodes.terminal_1?.data).toMatchObject({
        type: 'answer',
        answer: 'Result: {{#echogroup.text#}}',
      })
      expect(nodes.terminal_1?.data.outputs).toBeUndefined()
    })

    it('should compile canonical enumerate syntax into an Iteration container', () => {
      const result = compileAgentNetworkPseudocode(`
results = []
for iteration_index, iteration_item in enumerate(items):
    answer = EchoGroup(task=iteration_item)
    results.append(answer)
final_result = results
`, { model, inputTypes: { items: 'paragraph' } })
      const nodes = nodesById(result)
      const iteration = nodes.iteration_1
      const child = nodes.echogroup

      expect(iteration?.data).toMatchObject({
        type: 'iteration',
        iterator_selector: ['start', 'items'],
        output_selector: ['echogroup', 'text'],
        start_node_id: 'iteration_1_start',
        is_parallel: false,
      })
      expect(nodes.iteration_1_start?.type).toBe('custom-iteration-start')
      expect(nodes.iteration_1_start?.parentId).toBe('iteration_1')
      expect(child?.parentId).toBe('iteration_1')
      expect(child?.data.prompt_template[0]?.text).toBe('{{#iteration_1.item#}}')
      expect(edgeKeys(result)).toEqual(new Set([
        'start:source->iteration_1:target',
        'iteration_1_start:source->echogroup:target',
        'iteration_1:source->terminal_1:target',
      ]))
      expect(nodes.terminal_1?.data.outputs[0]?.value_selector).toEqual(['iteration_1', 'output'])
    })

    it('should compile bounded range and break into a Loop container', () => {
      const result = compileAgentNetworkPseudocode(`
counter = 0
for loop_index in range(5):
    EchoGroup(task=task)
    if counter >= 3:
        break
final_result = counter
`, { model })
      const nodes = nodesById(result)

      expect(nodes.loop_1?.data).toMatchObject({
        type: 'loop',
        loop_count: 5,
        start_node_id: 'loop_1_start',
        loop_variables: [{
          id: 'counter',
          label: 'counter',
          var_type: 'number',
          value_type: 'constant',
          value: 0,
        }],
        break_conditions: [{
          variable_selector: ['loop_1', 'counter'],
          value: '3',
        }],
      })
      expect(nodes.loop_1_start?.type).toBe('custom-loop-start')
      expect(nodes.echogroup?.parentId).toBe('loop_1')
      expect(edgeKeys(result)).toContain('loop_1_start:source->echogroup:target')
      expect(nodes.terminal_1?.data.outputs[0]?.value_selector).toEqual(['loop_1', 'counter'])
    })

    it('should map while to a bounded Loop with the inverse stop condition', () => {
      const result = compileAgentNetworkPseudocode(`
while enabled:
    EchoGroup(task=task)
final_result = task
`, { model })
      const nodes = nodesById(result)

      expect(nodes.loop_1?.data).toMatchObject({
        type: 'loop',
        loop_count: 100,
        break_conditions: [{
          variable_selector: ['start', 'enabled'],
          comparison_operator: 'empty',
        }],
      })
      expect(result.warnings).toContain('Line 2: while was mapped to a Dify Loop with a safety limit of 100 iterations')
    })

    it('should compile the comprehensive mock plan using only supported AgentNetwork Groups', () => {
      const result = compileAgentNetworkPseudocode(`
kind = ReasoningGroup(task=f"Classify the request: {task}")
if kind == "calc":
    for calc_check_index in range(1):
        calc_check = ReasoningGroup(task=f"Verify calculation: {task}")
    while kind == "calc":
        calc_confirmation = ReasoningGroup(task=f"Confirm calculation: {task}")
        break
    answer = CalculatorGroup(task=task)
else:
    for search_check_index in range(1):
        search_check = ReasoningGroup(task=f"Verify search: {task}")
    while kind == "search":
        search_confirmation = ReasoningGroup(task=f"Confirm search: {task}")
        break
    answer = SearchGroup(task=task)
final_result = answer
`, { model })
      const groupNames = result.graph.nodes.flatMap((node) => {
        const group = (node.data as Record<string, unknown>).agent_network_group
        return typeof group === 'string' ? [group] : []
      })

      expect(result.graph.nodes.filter(node => node.data.type === 'loop')).toHaveLength(4)
      expect(new Set(groupNames)).toEqual(new Set([
        'ReasoningGroup',
        'CalculatorGroup',
        'SearchGroup',
      ]))
      expect(result.graph.nodes.filter(node => node.data.type === 'end')).toHaveLength(2)
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('one-iteration Dify Loop'),
      ]))
    })

    it('should resolve input aliases and local constants in prompts', () => {
      const result = compileAgentNetworkPseudocode(`
task_alias = task
instruction = "Summarize"
answer = EchoGroup(instruction=instruction, task=task_alias)
final_result = answer
`, { model })
      const prompt = nodesById(result).echogroup?.data.prompt_template[0]?.text

      expect(prompt).toBe('instruction: Summarize\ntask: {{#start.task#}}')
    })

    it('should resolve input aliases used by branch conditions', () => {
      const result = compileAgentNetworkPseudocode(`
enabled_alias = enabled
if enabled_alias:
    answer = EnabledGroup(task=task)
else:
    answer = DisabledGroup(task=task)
final_result = answer
`, { model })

      expect(nodesById(result).branch_1?.data.cases[0]?.conditions[0]).toMatchObject({
        variable_selector: ['start', 'enabled'],
        comparison_operator: 'not empty',
      })
    })
  })

  describe('Validation', () => {
    it('should reject workflow calls that do not end with Group', () => {
      expect(() => compileAgentNetworkPseudocode(
        'answer = helper(task=task)\nfinal_result = answer',
        { model },
      )).toThrow(/must end with Group/)
    })

    it('should reject raw expressions instead of guessing their runtime meaning', () => {
      expect(() => compileAgentNetworkPseudocode(
        'answer = EchoGroup(task=task.strip())\nfinal_result = answer',
        { model },
      )).toThrow(/Unsupported argument expression/)
    })

    it('should reject terminal branches without else', () => {
      expect(() => compileAgentNetworkPseudocode(`
if enabled:
    answer = EchoGroup(task=task)
`, { model })).toThrow(/must include else/)
    })

    it('should reject reassignment on the same execution path', () => {
      expect(() => compileAgentNetworkPseudocode(`
answer = FirstGroup(task=task)
answer = SecondGroup(task=task)
final_result = answer
`, { model })).toThrow(/assigned more than once/)
    })

    it('should reject variables that are not defined on every branch', () => {
      expect(() => compileAgentNetworkPseudocode(`
if enabled:
    partial = FirstGroup(task=task)
answer = SecondGroup(task=partial)
final_result = answer
`, { model })).toThrow(/not defined on every path/)
    })

    it('should require a configured Dify model', () => {
      expect(() => compileAgentNetworkPseudocode(
        'answer = EchoGroup(task=task)\nfinal_result = answer',
      )).toThrow(/Dify model/)
    })

    it('should reject local constant outputs that have no Dify selector', () => {
      expect(() => compileAgentNetworkPseudocode('final_result = "static"', { model }))
        .toThrow(/must reference exactly one variable/)

      expect(() => compileAgentNetworkPseudocode('value = "static"\nfinal_result = value', { model }))
        .toThrow(/cannot be represented as a Dify value selector/)
    })

    it('should expose compiler errors as AgentNetworkCompileError', () => {
      expect(() => compileAgentNetworkPseudocode('for item in items:\n    WorkGroup(task=item)', { model }))
        .toThrow(AgentNetworkCompileError)
    })
  })

  describe('Warnings', () => {
    it('should return non-fatal dead-variable warnings with the graph', () => {
      const result = compileAgentNetworkPseudocode(`
unused = FirstGroup(task=task)
answer = SecondGroup(task=task)
final_result = answer
`, { model })

      expect(result.warnings).toContain('Variable unused is assigned but never used')
    })
  })
})
