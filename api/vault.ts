import type { VercelRequest, VercelResponse } from '@vercel/node'
import { BlobNotFoundError, get, put } from '@vercel/blob'

const VAULT_PATH = 'vaults/default.json'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  try {
    if (request.method === 'GET') {
      return await readVault(response)
    }

    if (request.method === 'PUT') {
      return await writeVault(request, response)
    }

    response.setHeader('Allow', 'GET, PUT')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return response.status(500).json({ ok: false, error: message })
  }
}

async function readVault(response: VercelResponse) {
  try {
    const result = await get(VAULT_PATH, {
      access: 'private',
      useCache: false,
    })

    if (!result) {
      return response.status(404).json({ ok: false, error: 'No cloud vault has been saved yet.' })
    }

    if (result.statusCode !== 200) {
      return response.status(304).end()
    }

    const text = await new Response(result.stream).text()
    response.setHeader('ETag', result.blob.etag)
    return response.status(200).json({
      ok: true,
      vault: JSON.parse(text),
      etag: result.blob.etag,
      updatedAt: result.blob.uploadedAt,
    })
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return response.status(404).json({ ok: false, error: 'No cloud vault has been saved yet.' })
    }

    throw error
  }
}

async function writeVault(request: VercelRequest, response: VercelResponse) {
  const vault = request.body

  if (!isVaultLike(vault)) {
    return response.status(400).json({ ok: false, error: 'Invalid vault payload' })
  }

  const result = await put(VAULT_PATH, JSON.stringify(vault, null, 2), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  })

  return response.status(200).json({
    ok: true,
    pathname: result.pathname,
    url: result.url,
    uploadedAt: new Date().toISOString(),
  })
}

function isVaultLike(value: unknown) {
  if (!value || typeof value !== 'object') return false

  const candidate = value as {
    name?: unknown
    importedAt?: unknown
    notes?: unknown
  }

  return (
    typeof candidate.name === 'string' &&
    typeof candidate.importedAt === 'string' &&
    Array.isArray(candidate.notes)
  )
}
