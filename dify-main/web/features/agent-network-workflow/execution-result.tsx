'use client'

import type { AgentNetworkExecutionResultPresentation } from './execution-result-model'
import { Button } from '@langgenius/dify-ui/button'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@langgenius/dify-ui/dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeAgentNetworkExecutionResult } from './execution-result-model'

type ResourcePresentation = Extract<
  AgentNetworkExecutionResultPresentation,
  { kind: 'resource' }
>

export function AgentNetworkExecutionResult({ result }: { result: unknown }) {
  const presentation = normalizeAgentNetworkExecutionResult(result)

  return (
    <section
      className="mt-2 overflow-hidden rounded-xl border border-divider-regular bg-background-default text-left shadow-xs"
      aria-label="final_result"
    >
      <div className="flex items-center gap-2 border-b border-divider-regular bg-state-success-hover px-3 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-full bg-state-success-solid text-text-primary-on-surface">
          <span className="i-ri-check-line size-3.5" aria-hidden="true" />
        </span>
        <span className="system-xs-semibold text-text-primary">
          final_result
        </span>
      </div>
      <div className="p-3">
        <ResultContent presentation={presentation} />
      </div>
    </section>
  )
}

function ResultContent({
  presentation,
}: {
  presentation: AgentNetworkExecutionResultPresentation
}) {
  if (presentation.kind === 'number') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-background-section px-3 py-3">
        <span className="i-ri-hashtag size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="font-mono text-lg leading-6 font-semibold text-text-primary">
          {presentation.value}
        </span>
      </div>
    )
  }

  if (presentation.kind === 'json') {
    return (
      <pre className="max-h-72 overflow-auto rounded-lg bg-background-section-burn p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-text-primary">
        <code>{presentation.value}</code>
      </pre>
    )
  }

  if (presentation.kind === 'collection') {
    return (
      <div className="space-y-3">
        {presentation.items.map((item, index) => (
          <ResultContent key={`${item.kind}-${index}`} presentation={item} />
        ))}
      </div>
    )
  }

  if (presentation.kind === 'resource')
    return <ResourceResult resource={presentation} />

  return (
    <p className="system-sm-regular wrap-break-word whitespace-pre-wrap text-text-primary">
      {presentation.value}
    </p>
  )
}

function ResourceResult({ resource }: { resource: ResourcePresentation }) {
  const { t } = useTranslation('common')
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewLabel = `${t('operation.view')} ${resource.name}`

  return (
    <>
      {resource.resourceKind === 'image'
        ? (
            <button
              type="button"
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-divider-subtle bg-background-section focus-visible:ring-2 focus-visible:ring-state-accent-solid focus-visible:outline-none"
              aria-label={previewLabel}
              onClick={() => setPreviewOpen(true)}
            >
              <img
                className="max-h-72 w-full object-contain transition-transform duration-200 group-hover:scale-[1.01] motion-reduce:transition-none"
                src={resource.url}
                alt={resource.name}
                width={720}
                height={405}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
              <span className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-lg bg-background-default/90 text-text-secondary shadow-sm">
                <span className="i-ri-zoom-in-line size-4" aria-hidden="true" />
              </span>
            </button>
          )
        : (
            <div className="flex items-center gap-3 rounded-lg border border-divider-subtle bg-background-section p-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background-default text-text-accent shadow-xs">
                <span className="i-ri-file-3-line size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate system-sm-medium text-text-primary" title={resource.name}>
                  {resource.name}
                </div>
                {resource.extension && (
                  <div className="mt-0.5 system-2xs-semibold-uppercase text-text-tertiary">
                    {resource.extension}
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                aria-label={previewLabel}
                onClick={() => setPreviewOpen(true)}
              >
                <span className="mr-1 i-ri-eye-line size-3.5" aria-hidden="true" />
                {t('operation.view')}
              </Button>
            </div>
          )}

      <ResourcePreviewDialog
        open={previewOpen}
        resource={resource}
        onOpenChange={setPreviewOpen}
      />
    </>
  )
}

function ResourcePreviewDialog({
  open,
  resource,
  onOpenChange,
}: {
  open: boolean
  resource: ResourcePresentation
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('common')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(960px,calc(100vw-2rem))] max-w-none! flex-col overflow-hidden! p-0!">
        <div className="relative shrink-0 border-b border-divider-regular px-6 py-4 pr-14">
          <DialogTitle className="truncate system-md-semibold text-text-primary">
            {resource.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            final_result
          </DialogDescription>
          <DialogCloseButton aria-label={t('operation.close')} className="top-4" />
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background-section-burn p-4">
          {resource.resourceKind === 'image'
            ? (
                <img
                  className="max-h-[calc(80dvh-9rem)] w-auto max-w-full object-contain"
                  src={resource.url}
                  alt={resource.name}
                  width={1600}
                  height={1000}
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
              )
            : (
                <iframe
                  className="h-[calc(80dvh-9rem)] min-h-96 w-full rounded-lg border border-divider-regular bg-background-default"
                  src={resource.url}
                  title={resource.name}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  sandbox="allow-downloads allow-forms allow-same-origin"
                />
              )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-divider-regular px-6 py-3">
          <a
            className="inline-flex h-8 items-center justify-center rounded-lg border-[0.5px] border-components-button-secondary-border bg-components-button-secondary-bg px-3.5 text-[13px] font-medium text-components-button-secondary-text shadow-xs hover:border-components-button-secondary-border-hover hover:bg-components-button-secondary-bg-hover focus-visible:ring-2 focus-visible:ring-state-accent-solid focus-visible:outline-none"
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="mr-1 i-ri-external-link-line size-4" aria-hidden="true" />
            {t('operation.openInNewTab')}
          </a>
          {resource.resourceKind === 'file' && (
            <a
              className="inline-flex h-8 items-center justify-center rounded-lg border border-components-button-primary-border bg-components-button-primary-bg px-3.5 text-[13px] font-medium text-components-button-primary-text shadow hover:border-components-button-primary-border-hover hover:bg-components-button-primary-bg-hover focus-visible:ring-2 focus-visible:ring-state-accent-solid focus-visible:outline-none"
              href={resource.url}
              download={resource.name}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="mr-1 i-ri-download-2-line size-4" aria-hidden="true" />
              {t('operation.download')}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
