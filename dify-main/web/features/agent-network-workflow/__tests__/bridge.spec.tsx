import type { AgentNetworkCompileResult } from '../types'
import type { ApplyAgentNetworkPseudocodeOptions } from '../use-agent-network-workflow'
import { act, render } from '@testing-library/react'
import { AgentNetworkWorkflowBridge } from '../bridge'

const mockApplyPseudocode = vi.hoisted(() => vi.fn())
type AgentNetworkTestWindow = Window & typeof globalThis & {
  difyAgentNetworkWorkflow?: {
    applyPseudocode: typeof mockApplyPseudocode
  }
}
const browserWindow = window as AgentNetworkTestWindow

vi.mock('../use-agent-network-workflow', () => ({
  useAgentNetworkWorkflow: () => ({ applyPseudocode: mockApplyPseudocode }),
}))

describe('AgentNetworkWorkflowBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete browserWindow.difyAgentNetworkWorkflow
  })

  it('exposes the hook through a browser API without rendering UI', () => {
    const { container } = render(<AgentNetworkWorkflowBridge />)

    expect(browserWindow.difyAgentNetworkWorkflow).toBeDefined()
    expect(container).toBeEmptyDOMElement()
  })

  it('forwards source and options and returns the hook result', async () => {
    const expected = { graph: { nodes: [], edges: [] }, warnings: [] } as unknown as AgentNetworkCompileResult
    mockApplyPseudocode.mockResolvedValue(expected)
    render(<AgentNetworkWorkflowBridge />)
    const options: ApplyAgentNetworkPseudocodeOptions = { saveDraft: true }

    let actual: AgentNetworkCompileResult | undefined
    await act(async () => {
      actual = await browserWindow.difyAgentNetworkWorkflow?.applyPseudocode('final_result = task', options)
    })

    expect(mockApplyPseudocode).toHaveBeenCalledWith('final_result = task', options)
    expect(actual).toBe(expected)
  })

  it('removes only the API instance that it registered', () => {
    const { unmount } = render(<AgentNetworkWorkflowBridge />)
    const replacementApi = { applyPseudocode: mockApplyPseudocode }
    browserWindow.difyAgentNetworkWorkflow = replacementApi

    unmount()
    expect(browserWindow.difyAgentNetworkWorkflow).toBe(replacementApi)
  })
})
