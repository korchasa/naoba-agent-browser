import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** A page to drive in tests, served over http so cookies and storage behave normally. */
export async function startFixtureServer(port = 0) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/data.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, at: Date.now() }))
      return
    }
    if (url.pathname === '/set-cookie') {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `fixture=${url.searchParams.get('v') ?? '1'}; Path=/` })
      response.end('<!doctype html><title>cookie set</title><h1>cookie set</h1>')
      return
    }
    if (url.pathname === '/dialog') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        '<!doctype html><title>dialog</title><button id="ask" onclick="document.title = confirm(\'ok?\') ? \'accepted\' : \'dismissed\'">ask</button>',
      )
      return
    }
    const file = url.pathname === '/' ? 'page.html' : url.pathname.slice(1)
    try {
      const body = await readFile(join(here, file))
      response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not here')
    }
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` }
}
