'use client'

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxItemText,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@langgenius/dify-ui/combobox'
import { useTranslation } from 'react-i18next'
import { AGENT_NETWORK_GROUPS } from '@/features/agent-network-workflow/groups'

type GroupOption = {
  label: string
  value: string
}

const GROUP_OPTIONS: GroupOption[] = AGENT_NETWORK_GROUPS.map(group => ({
  label: group,
  value: group,
}))

const getGroupLabel = (option: GroupOption) => option.label

export function GroupSelector({
  value,
  readOnly,
  onChange,
}: {
  value?: string
  readOnly: boolean
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const selectedOption = GROUP_OPTIONS.find(option => option.value === value) ?? null

  return (
    <Combobox<GroupOption>
      items={GROUP_OPTIONS}
      itemToStringLabel={getGroupLabel}
      value={selectedOption}
      onValueChange={option => option && onChange(option.value)}
    >
      <ComboboxTrigger
        aria-label={t('nodes.llm.agentNetworkGroup', { ns: 'workflow' })}
        icon
        disabled={readOnly}
        className="h-8 w-full justify-between px-2"
      >
        <ComboboxValue>
          {(option: GroupOption | null) => (
            <span className={option ? 'truncate text-text-primary' : 'truncate text-text-tertiary'}>
              {option?.label ?? t('nodes.llm.agentNetworkGroupPlaceholder', { ns: 'workflow' })}
            </span>
          )}
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <div className="p-2 pb-1">
          <ComboboxInputGroup className="h-8 min-h-8 px-2">
            <span aria-hidden className="mr-0.5 i-ri-search-line size-4 shrink-0 text-text-tertiary" />
            <ComboboxInput
              aria-label={t('nodes.llm.agentNetworkGroupSearch', { ns: 'workflow' })}
              placeholder={t('nodes.llm.agentNetworkGroupSearch', { ns: 'workflow' })}
              className="block h-4.5 grow px-1 py-0"
            />
          </ComboboxInputGroup>
        </div>
        <ComboboxList>
          {(option: GroupOption) => (
            <ComboboxItem key={option.value} value={option}>
              <ComboboxItemText>{option.label}</ComboboxItemText>
              <ComboboxItemIndicator />
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{t('noData', { ns: 'common' })}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
