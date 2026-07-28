import { executeAgentNetworkCode } from '../execute-code'
import { runGeneratedAgentNetworkWorkflow } from '../run-generated-workflow'

vi.mock('../execute-code', () => ({
  executeAgentNetworkCode: vi.fn(),
}))

describe('runGeneratedAgentNetworkWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should execute the generated pseudocode and preserve its wrapped final result', async () => {
    vi.mocked(executeAgentNetworkCode).mockResolvedValue({
      finalResult: {
        value: 'The requested workflow completed.',
        raw: { status: 'done' },
      },
      context: { status: 'done' },
      trace: [],
      calls: 1,
    })

    const result = await runGeneratedAgentNetworkWorkflow({
      task: 'Research the market and summarize it',
      pseudocode: 'answer = ResearchGroup(task=task)\nfinal_result = answer',
    })

    expect(executeAgentNetworkCode).toHaveBeenCalledWith({
      task: 'Research the market and summarize it',
      code: 'answer = ResearchGroup(task=task)\nfinal_result = answer',
      params: {},
      need_task: false,
      need_match: false,
      include_agents: true,
    })
    expect(result.finalResult).toEqual({
      value: 'The requested workflow completed.',
      raw: { status: 'done' },
    })
    expect(result.execution.calls).toBe(1)
  })

  it('should preserve the raw final result for type-aware presentation', async () => {
    vi.mocked(executeAgentNetworkCode).mockResolvedValue({
      finalResult: { answer: 42 },
      context: {},
      trace: [],
      calls: 0,
    })

    const result = await runGeneratedAgentNetworkWorkflow({
      task: 'Calculate the answer',
      pseudocode: 'final_result = 42',
    })

    expect(result.finalResult).toEqual({ answer: 42 })
  })

  it('should propagate execution failures to the chat workflow', async () => {
    vi.mocked(executeAgentNetworkCode).mockRejectedValue(new Error('AGENT_NETWORK_EXECUTION_FAILED'))

    await expect(runGeneratedAgentNetworkWorkflow({
      task: 'Run an invalid workflow',
      pseudocode: 'final_result = UnknownGroup(task=task)',
    })).rejects.toThrow('AGENT_NETWORK_EXECUTION_FAILED')
  })
})
