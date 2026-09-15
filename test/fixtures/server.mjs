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
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': `fixture=${url.searchParams.get('v') ?? '1'}; Path=/`,
      })
      response.end('<!doctype html><title>cookie set</title><h1>cookie set</h1>')
      return
    }
    // A page that commits early and finishes late: the address is the final one
    // from the first byte, and the part a scenario reads arrives half a second
    // later. That gap is what a wait for a URL has to cover and a wait for the
    // address alone does not.
    if (url.pathname === '/drip.html') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<!doctype html><title>Drip</title><h1>still arriving</h1>')
      setTimeout(() => response.end('<p id="where">arrived</p>'), 400)
      return
    }
    // A file the server hands over as an attachment, which is what makes a
    // navigation a download rather than a page.
    if (url.pathname === '/report.csv') {
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="report.csv"',
      })
      response.end('name,count\nfixture,7\n')
      return
    }
    // The same attachment, written a beat after the headers. A download that is
    // already on disk by the time the click returns proves nothing about a wait;
    // this one is still arriving.
    if (url.pathname === '/slow.csv') {
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="slow.csv"',
      })
      setTimeout(() => response.end('name,count\nslow,1\n'), 400)
      return
    }
    if (url.pathname === '/dialog') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        "<!doctype html><title>dialog</title><button id=\"ask\" onclick=\"document.title = confirm('ok?') ? 'accepted' : 'dismissed'\">ask</button>",
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
