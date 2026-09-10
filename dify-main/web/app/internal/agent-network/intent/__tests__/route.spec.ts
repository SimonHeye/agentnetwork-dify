import { describe, expect, it } from 'vitest'
import { POST } from '../route'

function request(body: unknown, origin = 'http://localhost') {
  const value = new Request('http://localhost/internal/agent-network/intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  value.headers.set('origin', origin)
  return value
}

describe('POST /internal/agent-network/intent', () => {
  it('returns the stable demo intent independently of the original user wording', async () => {
    const response = await POST(request({ task: 'abcde' }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(Object.keys(result).sort()).toEqual(['extraInstructions', 'normalizedTask'])
    expect(result.normalizedTask).toContain('请严格依次完成以下七个')
    expect(result.normalizedTask).not.toContain('abcde')
    expect(result.extraInstructions).toContain('已完成人工意图识别')
    expect(result.extraInstructions).toContain('source_materials=[enterprise_data, search_result]')
  })

  it('rejects invalid and cross-origin requests', async () => {
    expect((await POST(request({ task: '' }))).status).toBe(400)
    expect((await POST(request({ task: 'task' }, 'https://example.com'))).status).toBe(403)
  })
})
