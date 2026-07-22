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
    expect(result.source).toContain('reasoning_result = ReasoningGroup(')
    expect(result.source).toContain('skills=["download_attachments"],')
    expect(result.source).toContain('if reasoning_result.get("kind") == "calc":')
    expect(result.source).toContain('answer = CalculatorGroup(')
    expect(result.source).toContain('skills=["browser-control"],')
    expect(result.source).toContain('skills=["browser-control", "future-skill"],')
    expect(result.source).toContain('final_result = answer')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
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

  it('blocks export and reports unsupported nodes instead of silently removing them', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = ReviewGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'reviewgroup'
      ? { ...node, data: { ...node.data, type: BlockEnum.Code, title: 'Manual code' } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toBeNull()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'UNSUPPORTED_NODE',
      nodeId: 'reviewgroup',
    }))
  })

  it('keeps Group optional and falls back to the node title during export', () => {
    const graph = compileAgentNetworkPseudocode(
      'answer = SearchGroup(task=task)\nfinal_result = answer',
      { model },
    ).graph
    graph.nodes = graph.nodes.map(node => node.id === 'searchgroup'
      ? { ...node, data: { ...node.data, title: 'LLM 3', agent_network_group: '' } }
      : node)

    const result = compileDifyGraphToAgentNetworkPseudocode(graph)

    expect(result.source).toContain('answer = Llm3Group(')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'NORMALIZED_FUNCTION_NAME',
      nodeId: 'searchgroup',
    }))
  })
})
