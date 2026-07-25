import { formatAgentNetworkFinalResult, unwrapAgentNetworkFinalResult } from '../format-execute-result'

describe('AgentNetwork execute result formatting', () => {
  it('should prefer final_result.value over raw', () => {
    const finalResult = { value: 'scalar result', raw: { answer: 'raw result' } }

    expect(unwrapAgentNetworkFinalResult(finalResult)).toBe('scalar result')
    expect(formatAgentNetworkFinalResult(finalResult)).toBe('scalar result')
  })

  it('should preserve ordinary final_result values', () => {
    expect(formatAgentNetworkFinalResult({ answer: 42 })).toBe(`{
  "answer": 42
}`)
    expect(formatAgentNetworkFinalResult(null)).toBe('null')
  })

  it('should handle missing and non-serializable values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(formatAgentNetworkFinalResult(undefined)).toBe('')
    expect(formatAgentNetworkFinalResult(circular)).toBe('[object Object]')
  })
})
