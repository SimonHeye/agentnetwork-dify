import type { AgentNetworkIntentResult } from './request-intent'

type Props = {
  result?: AgentNetworkIntentResult
  pending?: boolean
}

export function AgentNetworkIntentResultCard({ result, pending = false }: Props) {
  return (
    <section className="rounded-xl border border-divider-regular bg-background-section-burn p-3 text-left shadow-xs" aria-label="意图识别">
      <div className="flex items-center gap-2 text-text-secondary">
        <span className={pending ? 'i-ri-loader-4-line size-4 animate-spin' : 'i-ri-sparkling-2-line size-4 text-text-success'} aria-hidden="true" />
        <span className="system-xs-semibold">
          {pending ? '正在识别任务意图……' : '意图识别完成'}
        </span>
      </div>

      {result && (
        <div className="mt-3 max-h-72 overflow-y-auto border-l-2 border-divider-deep pl-3 system-xs-regular leading-5 whitespace-pre-wrap text-text-secondary">
          {result.normalizedTask}
        </div>
      )}
    </section>
  )
}
