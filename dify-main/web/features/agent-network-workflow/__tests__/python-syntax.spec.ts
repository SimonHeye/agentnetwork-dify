import { AgentNetworkSyntaxError, parseAgentNetworkPseudocode } from '../python-syntax'

describe('parseAgentNetworkPseudocode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Supported workflow syntax', () => {
    it('should parse calls, templates, branches, and the output binding', () => {
      const statements = parseAgentNetworkPseudocode(`
probe = ReasoningGroup(
    task=f"判断任务类型。JSON：{{\\"kind\\": \\"calc\\"}}。"
         f"需求：{task}"
)
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
`)

      expect(statements).toHaveLength(3)
      expect(statements[0]).toMatchObject({
        kind: 'assign-call',
        target: 'probe',
        call: { functionName: 'ReasoningGroup' },
      })
      if (statements[0]?.kind !== 'assign-call')
        throw new Error('Expected an assigned call')
      expect(statements[0].call.kwargs.task).toMatchObject({
        expr: 'template',
        refs: ['task'],
      })
      expect(statements[0].call.kwargs.task).toHaveProperty('parts', [
        { text: '判断任务类型。JSON：{"kind": "calc"}。需求：' },
        { var: 'task' },
      ])
      expect(statements[1]).toMatchObject({
        kind: 'if',
        cases: [{
          condition: {
            parsed: true,
            logical: 'and',
            comparisons: [{
              variable: 'probe',
              key: 'kind',
              operator: '==',
              value: { expr: 'const', value: 'calc' },
            }],
          },
          body: [{ kind: 'assign-call', target: 'answer' }],
        }],
        elseBody: [{ kind: 'assign-call', target: 'answer' }],
      })
      expect(statements[2]).toMatchObject({ kind: 'assign', target: 'final_result' })
    })

    it('should flatten elif and preserve numeric and logical conditions', () => {
      const statements = parseAgentNetworkPseudocode(`
probe = ReasoningGroup(task=task)
if probe.get("score") >= 0.8 and enabled:
    answer = HighGroup(task=task)
elif not enabled:
    answer = DisabledGroup(task=task)
else:
    answer = LowGroup(task=task)
return answer
`)

      const branch = statements[1]
      if (branch?.kind !== 'if')
        throw new Error('Expected a branch')
      expect(branch.cases).toHaveLength(2)
      expect(branch.cases[0]?.condition).toMatchObject({
        parsed: true,
        logical: 'and',
        comparisons: [
          { variable: 'probe', key: 'score', operator: '>=', value: { value: 0.8, valueType: 'float' } },
          { variable: 'enabled', key: null, operator: 'truthy', value: null },
        ],
      })
      expect(branch.cases[1]?.condition.comparisons[0]).toMatchObject({
        variable: 'enabled',
        operator: 'falsy',
      })
      expect(statements[2]).toMatchObject({ kind: 'return', value: { expr: 'var', name: 'answer' } })
    })

    it('should retain references when an expression is outside the structured subset', () => {
      const statements = parseAgentNetworkPseudocode('result = WorkGroup(value=helper(task.strip()))\nfinal_result = result')
      const call = statements[0]
      if (call?.kind !== 'assign-call')
        throw new Error('Expected an assigned call')
      expect(call.call.kwargs.value).toEqual({
        expr: 'raw',
        raw: 'helper(task.strip())',
        refs: ['task'],
      })
    })

    it('should parse standalone terminal calls and empty returns', () => {
      const statements = parseAgentNetworkPseudocode('reply(task)\nreturn')

      expect(statements).toEqual([
        {
          kind: 'call',
          call: {
            functionName: 'reply',
            args: [{ expr: 'var', name: 'task', raw: 'task', refs: ['task'] }],
            kwargs: {},
          },
          line: 1,
        },
        { kind: 'return', value: null, line: 2 },
      ])
    })
  })

  describe('Unsupported syntax', () => {
    it.each([
      ['for item in items:\n    WorkGroup(task=item)', 'ForStatement'],
      ['while enabled:\n    WorkGroup(task=task)', 'WhileStatement'],
      ['class Flow:\n    pass', 'ClassDefinition'],
    ])('should reject %s', (source, statementType) => {
      expect(() => parseAgentNetworkPseudocode(source)).toThrow(
        new RegExp(`Unsupported statement type ${statementType}`),
      )
    })

    it('should reject chained assignments', () => {
      expect(() => parseAgentNetworkPseudocode('a = b = WorkGroup(task=task)')).toThrow(
        /Only one assignment target/,
      )
    })

    it('should reject member calls as workflow steps', () => {
      expect(() => parseAgentNetworkPseudocode('client.run(task)')).toThrow(
        /Only direct function calls/,
      )
    })

    it('should report invalid syntax with a line number', () => {
      expect(() => parseAgentNetworkPseudocode('if probe.get( ==')).toThrow(AgentNetworkSyntaxError)
      expect(() => parseAgentNetworkPseudocode('if probe.get( ==')).toThrow(/Line 1/)
    })

    it('should reject empty pseudocode', () => {
      expect(() => parseAgentNetworkPseudocode('  # comment only')).toThrow(/Pseudocode is empty/)
    })
  })
})
