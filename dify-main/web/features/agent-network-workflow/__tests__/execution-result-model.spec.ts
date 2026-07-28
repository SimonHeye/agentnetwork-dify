import { normalizeAgentNetworkExecutionResult } from '../execution-result-model'

describe('normalizeAgentNetworkExecutionResult', () => {
  it('should preserve text and numeric result types', () => {
    expect(normalizeAgentNetworkExecutionResult('Workflow completed.')).toEqual({
      kind: 'text',
      value: 'Workflow completed.',
    })
    expect(normalizeAgentNetworkExecutionResult({ value: 42, raw: '42' })).toEqual({
      kind: 'number',
      value: 42,
    })
  })

  it('should recognize an image URL returned as a wrapped string', () => {
    expect(normalizeAgentNetworkExecutionResult({
      value: 'https://cdn.example.com/results/chart.png?token=signed',
    })).toEqual({
      kind: 'resource',
      resourceKind: 'image',
      url: 'https://cdn.example.com/results/chart.png?token=signed',
      name: 'chart.png',
      extension: 'png',
      mimeType: undefined,
    })
  })

  it('should recognize a markdown file link and keep its display name', () => {
    expect(normalizeAgentNetworkExecutionResult(
      '[Quarterly report](https://cdn.example.com/files/report.pdf)',
    )).toEqual({
      kind: 'resource',
      resourceKind: 'file',
      url: 'https://cdn.example.com/files/report.pdf',
      name: 'Quarterly report',
      extension: 'pdf',
      mimeType: undefined,
    })
  })

  it('should use structured resource metadata when the real backend provides it', () => {
    expect(normalizeAgentNetworkExecutionResult({
      url: 'https://cdn.example.com/output/asset',
      filename: 'generated-image',
      mime_type: 'image/webp',
    })).toEqual({
      kind: 'resource',
      resourceKind: 'image',
      url: 'https://cdn.example.com/output/asset',
      name: 'generated-image',
      extension: '',
      mimeType: 'image/webp',
    })
  })

  it('should render unsupported protocols as plain text instead of interactive content', () => {
    expect(normalizeAgentNetworkExecutionResult('javascript:alert(1)')).toEqual({
      kind: 'text',
      value: 'javascript:alert(1)',
    })
  })

  it('should format structured non-resource results as JSON', () => {
    expect(normalizeAgentNetworkExecutionResult({ answer: 42 })).toEqual({
      kind: 'json',
      value: `{
  "answer": 42
}`,
    })
  })
})
