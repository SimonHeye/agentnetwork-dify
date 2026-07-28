import type { AgentNetworkExecuteInput } from '@/features/agent-network-workflow/types'
import { POST } from '../route'

const input: AgentNetworkExecuteInput = {
  task: 'Original task',
  code: 'answer = SearchGroup(task=task)\nfinal_result = answer\n',
  params: {},
  need_task: false,
  need_match: false,
  include_agents: true,
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

function request(body: unknown = input, origin = 'http://localhost') {
  const value = new Request('http://localhost/internal/agent-network/pseudocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  value.headers.set('origin', origin)
  return value
}

describe('POST /internal/agent-network/pseudocode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGENT_NETWORK_EXECUTE_URL', 'http://127.0.0.1:8787/service/execute_code')
    vi.stubEnv('AGENT_NETWORK_EXECUTE_API_KEY', 'local-test-token')
    vi.stubEnv('AGENT_NETWORK_EXECUTE_TIMEOUT_MS', '5000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('should forward the documented execute_code request and return its result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(executeResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(executeResult)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/service/execute_code', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer local-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it('should apply all documented defaults when optional fields are omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(executeResult), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await POST(request({ task: 'Original task', code: 'final_result = task' }))

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(payload).toEqual({
      task: 'Original task',
      code: 'final_result = task',
      params: {},
      need_task: false,
      need_match: false,
      include_agents: true,
    })
  })

  it('should reject invalid browser payloads before contacting Agent Network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request({ ...input, code: '' }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should reject cross-origin execution requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(input, 'https://example.com'))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should report missing execute_code configuration', async () => {
    vi.stubEnv('AGENT_NETWORK_EXECUTE_URL', '')
    vi.stubGlobal('fetch', vi.fn())

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'AGENT_NETWORK_NOT_CONFIGURED' })
  })

  it('should return the Agent Network plaintext error description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'NameError: name \'UnknownGroup\' is not defined',
      { status: 500 },
    )))

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      code: 'AGENT_NETWORK_EXECUTION_FAILED',
      message: 'NameError: name \'UnknownGroup\' is not defined',
    })
  })

  it('should reject an invalid successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ calls: 0 }), { status: 200 })))

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ code: 'AGENT_NETWORK_INVALID_RESPONSE' })
  })

  it('should normalize optional execution metadata from a minimal real backend response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      final_result: 'https://cdn.example.com/results/report.pdf',
    }), { status: 200 })))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      final_result: 'https://cdn.example.com/results/report.pdf',
      context: {},
      trace: [],
      calls: 0,
    })
  })
})
