import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 8787)
const expectedToken = process.env.AGENT_NETWORK_PSEUDOCODE_API_KEY || 'local-test-token'
const maxBodyBytes = 1_500_000

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/pseudocode') {
    respond(response, 404, { code: 'NOT_FOUND' })
    return
  }
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    respond(response, 401, { code: 'UNAUTHORIZED' })
    return
  }

  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > maxBodyBytes) {
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (payload.event !== 'dify.workflow.pseudocode.generated' || typeof payload.pseudocode !== 'string') {
        respond(response, 400, { code: 'INVALID_EVENT' })
        return
      }

      console.log(JSON.stringify(payload, null, 2))
      respond(response, 202, {
        delivery_id: payload.delivery_id,
        status: 'accepted',
      })
    }
    catch {
      respond(response, 400, { code: 'INVALID_JSON' })
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock Agent Network receiver: http://127.0.0.1:${port}/pseudocode`)
})

function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
