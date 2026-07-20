'use client'

import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxItemText,
  ComboboxList,
  ComboboxValue,
} from '@langgenius/dify-ui/combobox'
import { useTranslation } from 'react-i18next'

type SkillOption = {
  label: string
  value: string
}

const SKILL_OPTIONS: SkillOption[] = [
  { label: 'browser-control', value: 'browser-control' },
  { label: 'download_attachments', value: 'download_attachments' },
  { label: 'gimp-blur-region', value: 'gimp-blur-region' },
  { label: 'gimp-remove-background', value: 'gimp-remove-background' },
]

const getSkillLabel = (option: SkillOption) => option.label

const renderSkillOption = (option: SkillOption) => (
  <ComboboxItem key={option.value} value={option}>
    <ComboboxItemText>{option.label}</ComboboxItemText>
    <ComboboxItemIndicator />
  </ComboboxItem>
)

export function SkillsSelector({
  value,
  readOnly,
  onChange,
}: {
  value: string[]
  readOnly: boolean
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation()
  const selectedOptions = value.flatMap((skillName) => {
    const option = SKILL_OPTIONS.find(item => item.value === skillName)
    return option ? [option] : []
  })

  return (
    <Combobox<SkillOption, true>
      items={SKILL_OPTIONS}
      itemToStringLabel={getSkillLabel}
      multiple
      value={selectedOptions}
      readOnly={readOnly}
      onValueChange={options => onChange(options.map(option => option.value))}
    >
      <ComboboxInputGroup className="h-auto min-h-8 items-start py-1">
        <ComboboxChips>
          <ComboboxValue>
            {(options: SkillOption[]) => (
              <>
                {options.map(option => (
                  <ComboboxChip key={option.value}>
                    <span className="max-w-48 truncate">{option.label}</span>
                    {!readOnly && (
                      <ComboboxChipRemove
                        aria-label={`${t('operation.remove', { ns: 'common' })} ${option.label}`}
                      />
                    )}
                  </ComboboxChip>
                ))}
                <ComboboxInput
                  aria-label={t('nodes.llm.skills', { ns: 'workflow' })}
                  placeholder={options.length ? '' : t('nodes.llm.skillsPlaceholder', { ns: 'workflow' })}
                  className="min-w-24 px-1 py-0.5"
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
      </ComboboxInputGroup>
      <ComboboxContent>
        <ComboboxList>{renderSkillOption}</ComboboxList>
        <ComboboxEmpty>{t('noData', { ns: 'common' })}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
