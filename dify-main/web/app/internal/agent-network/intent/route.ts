import { z } from 'zod'
import { isSameOriginRequest } from '../same-origin'

const requestSchema = z.object({
  task: z.string().trim().min(1).max(100_000),
}).strict()

// Demo-only intent result. Replace this constant with the real intent service response later.
const DEMO_INVESTMENT_INTENT_TASK = `这是一个企业投资尽调与报告撰写任务，不是数值计算任务。目标企业是“苏州威迈芯材半导体有限公司”，
最终需要形成供投资决策会议使用的 PPTX 演示文稿和 Word 投资分析报告。请严格依次完成以下七个
不可省略的子目标：

1. 使用企业工商与风险信息查询能力，以完整企业名称为 keyword、All 为 ctype 查询企业全量底档，
   覆盖工商登记、股权关联、经营融资、知识产权、司法风险、行政处罚及合规信息。
2. 使用多源联网搜索能力，补充最新新闻、融资历史、核心技术产品、竞争对手、市场地位、
   半导体材料行业趋势及公开投资观点；不得用普通联网搜索替代第一步的企业底档查询。
3. 使用 ReasoningGroup 综合企业底档和外部情报进行证据化推理，并选择与科技企业投资尽调最匹配的候选 Skill，
   识别信息缺口并形成 reasoning_result。
4. 使用总结分析能力整理 reasoning_result，形成全面投资报告，包含公司基本情况、技术产品、
   市场竞争、财务融资、法律与经营风险、投资结论（值得投资/谨慎观察/不建议投资）及详细理由。
5. 使用 PPTX 文件生成能力，根据投资报告制作一份中文投资决策演示文稿，重点展示投资结论、
   核心依据、竞争格局和风险提示，并返回可下载的 PPTX 文件。
6. 使用 Word 文件生成能力，根据完整投资报告生成一份正式、专业、结构清晰的中文 Word 文档，
   同时保留上一步 PPTX 文件的生成步骤，并把 Word 文件节点返回值作为最终结果。
7. 发送邮件到 1078825799@qq.com，包含 PPTX 文件和 Word 文档链接。`

// Demo-only planning constraints. A real intent service can later return the
// same two-field contract without changing the planning pipeline.
const DEMO_INVESTMENT_EXTRA_INSTRUCTIONS = `已完成人工意图识别：这是企业投资尽调，不是通用事实查询或数值计算。
规划必须依次调用且不得省略 EnterpriseInformationQueryGroup、SearchGroup、ReasoningGroup、SummarizerGroup、
PPTXGenAgentGroup、WordGenerationAgentGroup。企业查询的 ctype 必须为 All。ReasoningGroup 的
规划必须显式使用 source_materials=[enterprise_data, search_result]。SummarizerGroup 的
source_materials 必须直接接收 ReasoningGroup 的
reasoning_result，不得绕过推理节点直接总结原始材料。总结报告必须作为 PPTX 和 Word 两个文件生成节点的
content。每个节点用单个变量承接返回值，最终结果取邮件发送节点的返回值。`

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return json({ code: 'CROSS_ORIGIN_REQUEST' }, 403)

  const input = requestSchema.safeParse(await readJson(request))
  if (!input.success)
    return json({ code: 'INVALID_REQUEST' }, 400)

  return Response.json({
    normalizedTask: DEMO_INVESTMENT_INTENT_TASK,
    extraInstructions: DEMO_INVESTMENT_EXTRA_INSTRUCTIONS,
  }, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  }
  catch {
    return null
  }
}

function json(body: Record<string, string>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
