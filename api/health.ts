import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_request: VercelRequest, response: VercelResponse) {
  response.status(200).json({
    ok: true,
    service: 'web-obsidian-api',
    storage: process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? 'blob-configured' : 'local-prototype',
    timestamp: new Date().toISOString(),
  })
}
