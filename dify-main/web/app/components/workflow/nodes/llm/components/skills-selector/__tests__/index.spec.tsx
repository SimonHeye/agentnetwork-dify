import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SkillsSelector } from '../index'

function SkillsSelectorHarness({
  initialValue = [],
  readOnly = false,
  onChange,
}: {
  initialValue?: string[]
  readOnly?: boolean
  onChange?: (value: string[]) => void
}) {
  const [value, setValue] = useState(initialValue)

  const handleChange = (nextValue: string[]) => {
    setValue(nextValue)
    onChange?.(nextValue)
  }

  return (
    <SkillsSelector
      value={value}
      readOnly={readOnly}
      onChange={handleChange}
    />
  )
}

describe('SkillsSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Filtering', () => {
    it('should filter skills by a case-insensitive name query', async () => {
      const user = userEvent.setup()
      render(<SkillsSelectorHarness />)

      await user.type(screen.getByRole('combobox', { name: 'workflow.nodes.llm.skills' }), 'GIMP')

      expect(screen.getByRole('option', { name: 'gimp-blur-region' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'gimp-remove-background' })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'browser-control' })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'download_attachments' })).not.toBeInTheDocument()
    })

    it('should show an empty state when no skill matches', async () => {
      const user = userEvent.setup()
      render(<SkillsSelectorHarness />)

      await user.type(screen.getByRole('combobox', { name: 'workflow.nodes.llm.skills' }), 'missing')

      expect(screen.getByText('common.noData')).toBeInTheDocument()
    })
  })

  describe('Selection', () => {
    it('should preserve the order in which skills are selected', async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()
      render(<SkillsSelectorHarness onChange={handleChange} />)

      const input = screen.getByRole('combobox', { name: 'workflow.nodes.llm.skills' })
      await user.click(input)
      await user.click(screen.getByRole('option', { name: 'download_attachments' }))
      await user.click(input)
      await user.click(screen.getByRole('option', { name: 'browser-control' }))

      expect(handleChange).toHaveBeenLastCalledWith([
        'download_attachments',
        'browser-control',
      ])
    })

    it('should remove a selected skill from its chip', async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()
      render(
        <SkillsSelectorHarness
          initialValue={['browser-control', 'gimp-blur-region']}
          onChange={handleChange}
        />,
      )

      await user.click(screen.getByRole('button', { name: 'common.operation.remove browser-control' }))

      expect(handleChange).toHaveBeenLastCalledWith(['gimp-blur-region'])
    })
  })

  describe('Read-only state', () => {
    it('should display selected skills without allowing changes', () => {
      render(
        <SkillsSelectorHarness
          initialValue={['browser-control']}
          readOnly
        />,
      )

      expect(screen.getByText('browser-control')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'workflow.nodes.llm.skills' })).toHaveAttribute('readonly')
      expect(screen.queryByRole('button', { name: 'common.operation.remove browser-control' })).not.toBeInTheDocument()
    })
  })
})
