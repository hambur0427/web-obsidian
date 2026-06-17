import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import type { Page } from '@playwright/test'

const testVault = {
  name: 'Export Test Vault',
  importedAt: '2026-06-18T00:00:00.000Z',
  folders: ['Recon', 'Recon/Tools', 'Empty Folder'],
  notes: [
    {
      id: 'recon/tools/tool-design.md',
      title: 'tool-design',
      path: 'Recon/Tools/tool-design.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# Tool Design',
      links: [],
    },
    {
      id: 'trash.md',
      title: 'trash',
      path: 'trash.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# Trash',
      links: [],
      deletedAt: '2026-06-18T00:00:00.000Z',
    },
  ],
}

async function seedVault(page: Page) {
  await page.addInitScript((vault) => {
    window.localStorage.setItem('web-obsidian:vault', JSON.stringify(vault))
  }, testVault)
  await page.goto('/')
}

test('exports active vault notes and folders as a zip', async ({ page }) => {
  await seedVault(page)

  const downloadPromise = page.waitForEvent('download')
  await page.getByTitle('Export vault folder ZIP').click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Download path is unavailable')
  const zip = await JSZip.loadAsync(await readFile(downloadPath))
  const entries = Object.keys(zip.files)

  expect(download.suggestedFilename()).toBe('Export Test Vault.zip')
  expect(entries).toContain('Export Test Vault/Recon/')
  expect(entries).toContain('Export Test Vault/Recon/Tools/')
  expect(entries).toContain('Export Test Vault/Empty Folder/')
  expect(entries).toContain('Export Test Vault/Recon/Tools/tool-design.md')
  expect(entries).not.toContain('Export Test Vault/trash.md')
  await expect(zip.file('Export Test Vault/Recon/Tools/tool-design.md')?.async('string')).resolves.toBe(
    '# Tool Design',
  )
})
