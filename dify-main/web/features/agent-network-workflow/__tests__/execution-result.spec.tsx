import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentNetworkExecutionResult } from '../execution-result'

describe('AgentNetworkExecutionResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    happyDOMSettings().disableIframePageLoading = false
    vi.restoreAllMocks()
  })

  // Scalar results remain readable instead of being presented as source code.
  describe('Scalar results', () => {
    it('should display text and numeric values', () => {
      const { rerender } = render(<AgentNetworkExecutionResult result="Workflow completed." />)

      expect(screen.getByText('Workflow completed.')).toBeInTheDocument()

      rerender(<AgentNetworkExecutionResult result={42} />)

      expect(screen.getByText('42')).toBeInTheDocument()
    })
  })

  // Media links expose an accessible preview without navigating away from the workflow.
  describe('Resource preview', () => {
    it('should render and open an image result in a dialog', async () => {
      const user = userEvent.setup()
      render(<AgentNetworkExecutionResult result="https://cdn.example.com/results/chart.png" />)

      expect(screen.getByRole('img', { name: 'chart.png' })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /operation\.view chart\.png$/ }))

      const dialog = screen.getByRole('dialog', { name: 'chart.png' })
      expect(within(dialog).getByRole('img', { name: 'chart.png' })).toBeInTheDocument()
      expect(within(dialog).getByRole('link', { name: /operation\.openInNewTab$/ }))
        .toHaveAttribute('href', 'https://cdn.example.com/results/chart.png')
    })

    it('should preview a file result inside the dialog', async () => {
      happyDOMSettings().disableIframePageLoading = true
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const user = userEvent.setup()
      render(<AgentNetworkExecutionResult result="https://cdn.example.com/files/report.pdf" />)

      await user.click(screen.getByRole('button', { name: /operation\.view report\.pdf$/ }))

      const dialog = screen.getByRole('dialog', { name: 'report.pdf' })
      expect(within(dialog).getByTitle('report.pdf'))
        .toHaveAttribute('src', 'https://cdn.example.com/files/report.pdf')
      expect(within(dialog).getByRole('link', { name: /operation\.download$/ }))
        .toHaveAttribute('href', 'https://cdn.example.com/files/report.pdf')
    })
  })

  // Unknown structured results still have a stable, legible fallback.
  describe('Fallback result', () => {
    it('should display structured data as formatted JSON', () => {
      render(<AgentNetworkExecutionResult result={{ answer: 42 }} />)

      expect(screen.getByText(/"answer": 42/)).toBeInTheDocument()
    })
  })
})

function happyDOMSettings() {
  return (window as unknown as {
    happyDOM: {
      settings: {
        disableIframePageLoading: boolean
      }
    }
  }).happyDOM.settings
}
