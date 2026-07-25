import type { AgentNetworkExecuteInput } from '../types'
import { executeAgentNetworkCode } from '../execute-code'

vi.mock('@/utils/var', () => ({ basePath: '/dify' }))

const input: AgentNetworkExecuteInput = {
  task: 'Original task',
  code: 'final_result = task\n',
}

const executeResult = {
  final_result: { value: 'done', raw: 'done' },
  context: { result: 'done' },
  trace: [{
    identifier: 'SearchGroup',
    vertex: 'SearchGroup',
    params: { task: 'Original task' },
    scalar: 'done',
  }],
  calls: 1,
}

describe('executeAgentNetworkCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should send the documented execute_code defaults through the same-origin route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(executeResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeAgentNetworkCode(input)

    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/pseudocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        task: 'Original task',
        code: 'final_result = task\n',
        params: {},
        need_task: false,
        need_match: false,
        include_agents: true,
      }),
    })
    expect(result).toEqual({
      finalResult: executeResult.final_result,
      context: executeResult.context,
      trace: executeResult.trace,
      calls: 1,
    })
  })

  it('should preserve explicitly configured execute_code options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(executeResult), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await executeAgentNetworkCode({
      ...input,
      params: { count: 2, enabled: true },
      need_task: true,
      need_match: true,
      include_agents: false,
    })

    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/pseudocode', expect.objectContaining({
      body: JSON.stringify({
        task: 'Original task',
        code: 'final_result = task\n',
        params: { count: 2, enabled: true },
        need_task: true,
        need_match: true,
        include_agents: false,
      }),
    }))
  })

  it('should surface the execute_code error description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'AGENT_NETWORK_EXECUTION_FAILED',
      message: "NameError: name 'UnknownGroup' is not defined",
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(executeAgentNetworkCode(input))
      .rejects
      .toThrow("NameError: name 'UnknownGroup' is not defined")
  })

  it('should reject an incomplete successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ calls: 0 }), { status: 200 })))

    await expect(executeAgentNetworkCode(input))
      .rejects
      .toThrow('AGENT_NETWORK_INVALID_RESPONSE')
  })
})
