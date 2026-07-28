import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentNetworkChatPanel } from '../chat-panel'
import { requestAgentNetworkPlan } from '../request-plan'
import { runGeneratedAgentNetworkWorkflow } from '../run-generated-workflow'

const mockApplyPseudocode = vi.fn()
const mockPush = vi.fn()

const mockSetInitialTasks = vi.fn()
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}))

vi.mock('@/next/navigation', () => ({
  usePathname: () => '/app/app-1/agent-network',
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/app/components/app/store', () => ({
  useStore: (selector: (state: { appDetail: { id: string } }) => unknown) => selector({
    appDetail: { id: 'app-1' },
  }),
}))

vi.mock('@/app/components/workflow/hooks/use-workflow', () => ({
  useNodesReadOnly: () => ({ nodesReadOnly: false }),
}))

vi.mock('../use-agent-network-workflow', () => ({
  useAgentNetworkWorkflow: () => ({ applyPseudocode: mockApplyPseudocode }),
}))

vi.mock('../request-plan', () => ({
  requestAgentNetworkPlan: vi.fn(),
}))

vi.mock('../run-generated-workflow', () => ({
  runGeneratedAgentNetworkWorkflow: vi.fn(),
}))

vi.mock('../storage', () => ({
  useAgentNetworkInitialTasks: () => [{}, mockSetInitialTasks],
}))

describe('AgentNetworkChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requestAgentNetworkPlan).mockResolvedValue({
      pseudocode: 'final_result = task',
    })
    mockApplyPseudocode.mockResolvedValue({
      graph: { nodes: [{ id: 'start' }, { id: 'end' }], edges: [{ id: 'edge' }] },
      warnings: [],
    })
    vi.mocked(runGeneratedAgentNetworkWorkflow).mockResolvedValue({
      finalResult: 'Calculator workflow completed.',
      execution: {
        finalResult: { value: 'Calculator workflow completed.' },
        context: {},
        trace: [],
        calls: 1,
      },
    })
  })

  it('requests a plan, applies it to the canvas, runs it, and displays the final result', async () => {
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)

    await user.type(screen.getByRole('textbox', { name: 'agentNetworkChat.placeholder' }), 'Build a calculator workflow')
    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.send' }))

    await waitFor(() => {
      expect(requestAgentNetworkPlan).toHaveBeenCalledWith({
        appId: 'app-1',
        task: 'Build a calculator workflow',
      })
      expect(mockApplyPseudocode).toHaveBeenCalledWith('final_result = task', {
        preservePositions: false,
        saveDraft: true,
      })
      expect(runGeneratedAgentNetworkWorkflow).toHaveBeenCalledWith({
        task: 'Build a calculator workflow',
        pseudocode: 'final_result = task',
      })
    })
    expect(screen.getByText(/agentNetworkChat\.success/)).toBeInTheDocument()
    expect(screen.getByText('agentNetworkChat.resultTitle')).toBeInTheDocument()
    expect(screen.getByText('Calculator workflow completed.')).toBeInTheDocument()
    expect(mockSetInitialTasks).toHaveBeenCalledTimes(1)
    const update = mockSetInitialTasks.mock.calls[0]![0] as (
      current: Record<string, { initialTask: string }>,
    ) => Record<string, { initialTask: string }>
    expect(update({})).toEqual({ 'app-1': { initialTask: 'Build a calculator workflow' } })
    expect(update({ 'app-1': { initialTask: 'Original task' } })).toEqual({ 'app-1': { initialTask: 'Original task' } })
  })

  it('shows an execution state while the generated workflow is running', async () => {
    vi.mocked(runGeneratedAgentNetworkWorkflow).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)

    await user.type(screen.getByRole('textbox', { name: 'agentNetworkChat.placeholder' }), 'Build a calculator workflow')
    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.send' }))

    expect(await screen.findByText('agentNetworkChat.executing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'agentNetworkChat.send' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('keeps the generated workflow and reports a distinct execution failure', async () => {
    vi.mocked(runGeneratedAgentNetworkWorkflow).mockRejectedValue(new Error('Agent execution timed out'))
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)

    await user.type(screen.getByRole('textbox', { name: 'agentNetworkChat.placeholder' }), 'Build a calculator workflow')
    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.send' }))

    expect(await screen.findByText(/agentNetworkChat\.executionFailed/)).toHaveTextContent('Agent execution timed out')
    expect(screen.queryByText(/agentNetworkChat\.failed/)).not.toBeInTheDocument()
    expect(screen.getByText('agentNetworkChat.sourceTitle')).toBeInTheDocument()
  })

  it('returns to the normal workflow page when closed', async () => {
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)

    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.close' }))

    expect(mockPush).toHaveBeenCalledWith('/app/app-1/workflow')
  })
})
