import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { GroupSelector } from '../index'

function GroupSelectorHarness({
  initialValue,
  readOnly = false,
  onChange,
}: {
  initialValue?: string
  readOnly?: boolean
  onChange?: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)

  const handleChange = (nextValue: string) => {
    setValue(nextValue)
    onChange?.(nextValue)
  }

  return (
    <GroupSelector
      value={value}
      readOnly={readOnly}
      onChange={handleChange}
    />
  )
}

describe('GroupSelector', () => {
  it('shows the fixed AgentNetwork Group list', async () => {
    const user = userEvent.setup()
    render(<GroupSelectorHarness />)

    await user.click(screen.getByRole('combobox', { name: 'workflow.nodes.llm.agentNetworkGroup' }))

    expect(screen.getByRole('option', { name: 'ReasoningGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'SearchGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'CalculatorGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'ClassificationGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'PlanningGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'ExtractionGroup' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'SummarizationGroup' })).toBeInTheDocument()
  })

  it('stores the selected Group', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    render(<GroupSelectorHarness onChange={handleChange} />)

    await user.click(screen.getByRole('combobox', { name: 'workflow.nodes.llm.agentNetworkGroup' }))
    await user.click(screen.getByRole('option', { name: 'PlanningGroup' }))

    expect(handleChange).toHaveBeenCalledWith('PlanningGroup')
    expect(screen.getByText('PlanningGroup')).toBeInTheDocument()
  })

  it('cannot be changed in read-only mode', () => {
    render(<GroupSelectorHarness initialValue="SearchGroup" readOnly />)

    expect(screen.getByRole('combobox', { name: 'workflow.nodes.llm.agentNetworkGroup' })).toBeDisabled()
  })
})
