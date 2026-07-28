import { ErrorHandleTypeEnum } from '@/app/components/workflow/nodes/_base/components/error-handle/types'
import { BlockEnum } from '@/app/components/workflow/types'
import { compileAgentNetworkPseudocode } from '../compiler'
import { compileDifyGraphToAgentNetworkPseudocode } from '../reverse-compiler'

const model = {
  provider: 'test-provider',
  name: 'test-model',
  mode: 'chat',
  completion_params: {},
}

const source = `
probe = ReasoningGroup(
    task=f"Classify the request as search or calc and return JSON. Request: {task}"
)
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
`

describe('compileDifyGraphToAgentNetworkPseudocode', () => {
  it('preserves AgentNetwork variable names without exporting Dify model configuration', () => {
    const plan = `
kind = ReasoningGroup(task=task)
if kind == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
`
    const graph = compileAgentNetworkPseudocode(plan, { model }).graph

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('kind = ReasoningGroup(')
    expect(result.source).toContain('if kind == "calc":')
    expect(result.source).toContain('answer = CalculatorGroup(')
    expect(result.source).toContain('answer = SearchGroup(')
    expect(result.source).toContain('final_result = answer')
    expect(result.source).not.toContain('model=')
    expect(result.source).not.toContain('provider=')
    expect(result.source).not.toContain('config=')
  })
  it('exports the current graph topology and LLM skills as canonical pseudocode', () => {
    const graph = compileAgentNetworkPseudocode(source, { model }).graph
    graph.nodes = graph.nodes.map((node) => {
      if (node.id === 'reasoninggroup')
        return { ...node, data: { ...node.data, skills: ['download_attachments'] } }
      if (node.id === 'calculatorgroup')
        return { ...node, data: { ...node.data, skills: ['browser-control'] } }
      if (node.id === 'searchgroup')
        return { ...node, data: { ...node.data, skills: ['browser-control', 'future-skill'] } }
      return node
    })

    const result = compileDifyGraphToAgentNetworkPseudocode(graph, { workflowName: 'Skill demo' })

    expect(result.source).not.toBeNull()
    expect(result.fileName).toBe('Skill demo.agentnetwork.py')
    expect(result.stats).toEqual({ nodes: 7, edges: 6, agents: 3, branches: 1, skills: 4 })
    expect(result.source).toContain('probe = ReasoningGroup(')
    expect(result.source).toContain('skills=["download_attachments"],')
    expect(result.source).toContain('if probe == "calc":')
    expect(result.source).not.toContain('.get("kind")')
    expect(result.source).not.toContain('model=')
    expect(result.source).not.toContain('provider=')
    expect(result.source).not.toContain('config=')
    expect(result.source).toContain('answer = CalculatorGroup(')
    expect(result.source).toContain('skills=["browser-control"],')
    expect(result.source).toContain('skills=["browser-control", "future-skill"],')
    expect(result.source).toContain('final_result = answer')
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'INFERRED_VARIABLE',
      nodeId: 'reasoninggroup',
    }))
  })

  it('uses the selected fixed Group independently of the display title', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = SearchGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'searchgroup'
      ? { ...node, data: { ...node.data, title: 'Result review', skills: ['gimp-blur-region'] } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('answer = SearchGroup(')
    expect(result.source).toContain('skills=["gimp-blur-region"],')
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'NORMALIZED_FUNCTION_NAME',
      nodeId: 'searchgroup',
    }))
  })

  it('keeps future skill identifiers without a hard-coded allowlist', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = SearchGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'searchgroup'
      ? { ...node, data: { ...node.data, skills: ['new-skill-v2', 'new-skill-v2', '', 7] } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('skills=["new-skill-v2"],')
    expect(result.stats.skills).toBe(1)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'NORMALIZED_SKILLS' }))
  })

  it('exports Code nodes instead of silently removing them', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = ReviewGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'reviewgroup'
      ? { ...node, data: { ...node.data, type: BlockEnum.Code, title: 'Manual code' } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('answer = CodeExecution(')
    expect(result.source).toContain('final_result = answer.get("text")')
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      severity: 'error',
      nodeId: 'reviewgroup',
    }))
  })

  it('exports a native LLM when no AgentNetwork Group is selected', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = SearchGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'searchgroup'
      ? { ...node, data: { ...node.data, title: 'LLM 3', agent_network_group: '' } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('answer = LLM(')
    expect(result.source).toContain('model="test-model",')
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'NORMALIZED_FUNCTION_NAME',
      nodeId: 'searchgroup',
    }))
  })

  it('does not send Dify execution controls as AgentNetwork Group arguments', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = SearchGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'searchgroup'
      ? { ...node, data: {
          ...node.data,
          retry_config: { retry_enabled: true, max_retries: 3, retry_interval: 1000 },
          error_strategy: ErrorHandleTypeEnum.defaultValue,
          default_value: [],
        } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).not.toContain('retry=')
    expect(result.source).not.toContain('on_error=')
    expect(result.source).not.toContain('default=')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'GROUP_EXECUTION_CONTROL_OMITTED',
      nodeId: 'searchgroup',
    }))
  })

  it('exports legacy Group field conditions as executable PseudoResult scalar comparisons', () => {
    const graph = compileAgentNetworkPseudocode(`
kind_node = ReasoningGroup(task=task)
kind = kind_node.value.get("kind")
if kind == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
`, { model }).graph
    const branch = graph.nodes.find(node => node.id === 'branch_1')
    const branchData = branch?.data as unknown as {
      cases: Array<{ conditions: Array<Record<string, unknown>> }>
    }
    const condition = branchData.cases[0]?.conditions[0]
    expect(condition).toBeDefined()
    condition!.variable_selector = ['reasoninggroup', 'structured_output']
    condition!.key = 'kind'

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('kind_node = ReasoningGroup(')
    expect(result.source).toContain('if kind_node == "calc":')
    expect(result.source).not.toContain('kind_node.get("kind")')
    expect(result.source).not.toContain('kind_node.value.get("kind")')
  })
})
