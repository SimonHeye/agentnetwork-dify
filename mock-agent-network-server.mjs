import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 8787)
const expectedToken = process.env.AGENT_NETWORK_API_KEY || 'local-test-token'
const maxBodyBytes = 1_500_000

const pseudocode = `# 命名空间已注入：各 vertex 函数、task（用户任务字符串）、final_result（输出约定）
# 语义：先让入口节点判定任务类型，再按判定结果走不同的单一下游。
# 函数中的变量都会从上下文中获取或者放入上下文

# ① 入口：决策节点
probe = ReasoningGroup(
    task=f"判断下面的用户需求属于「事实查询」还是「数值计算」，"
         f"只返回 JSON：{{\\"kind\\": \\"search\\"}} 或 {{\\"kind\\": \\"calc\\"}}。\\n需求：{task}"
)

# ② 分支：唯一的控制流
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)

# ③ 输出约定
final_result = answer
`

const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    respond(response, 404, { code: 'NOT_FOUND' })
    return
  }
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    respond(response, 401, { code: 'UNAUTHORIZED' })
    return
  }

  const payload = await readJson(request)
  if (!payload) {
    respond(response, 400, { code: 'INVALID_JSON' })
    return
  }

  if (request.url === '/plan') {
    if (typeof payload.task !== 'string' || !payload.task.trim()) {
      respond(response, 400, { code: 'INVALID_TASK' })
      return
    }

    console.log(`[plan] ${payload.request_id || '-'}: ${payload.task}`)
    respond(response, 200, {
      request_id: payload.request_id,
      status: 'completed',
      pseudocode,
    })
    return
  }

  if (request.url === '/pseudocode') {
    if (payload.event !== 'dify.workflow.pseudocode.generated' || typeof payload.pseudocode !== 'string') {
      respond(response, 400, { code: 'INVALID_EVENT' })
      return
    }

    console.log(`[execute] ${payload.delivery_id || '-'}`)
    console.log(JSON.stringify(payload, null, 2))
    respond(response, 202, {
      delivery_id: payload.delivery_id,
      status: 'accepted',
    })
    return
  }

  respond(response, 404, { code: 'NOT_FOUND' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock Agent Network plan endpoint: http://127.0.0.1:${port}/plan`)
  console.log(`Mock Agent Network execute endpoint: http://127.0.0.1:${port}/pseudocode`)
})

async function readJson(request) {
  const chunks = []
  let size = 0

  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > maxBodyBytes)
        return null
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    return null
  }
}

function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
