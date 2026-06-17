import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const testVault = {
  name: 'Import Merge Test Vault',
  importedAt: '2026-06-18T00:00:00.000Z',
  folders: ['Imported'],
  notes: [
    {
      id: 'imported/existing.md',
      title: 'Existing',
      path: 'Imported/Existing.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# Original',
      links: [],
    },
  ],
}

async function seedVault(page: Page) {
  await page.addInitScript((vault) => {
    window.localStorage.setItem('web-obsidian:vault', JSON.stringify(vault))
  }, testVault)
  await page.goto('/')
}

test('importing a folder merges notes without overwriting existing paths', async ({ page }) => {
  await seedVault(page)
  await page.locator('input.hidden-input[type="file"]').first().waitFor({ state: 'attached' })

  await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input.hidden-input[type="file"]')
    if (!input) throw new Error('Directory input not found')

    const file = new File(['# Imported'], 'Existing.md', {
      type: 'text/markdown',
      lastModified: Date.parse('2026-06-18T00:00:00.000Z'),
    })
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'Imported/Existing.md',
    })

    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    input.files = dataTransfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await expect(page.locator('.note-row-wrap')).toHaveCount(2)
  await expect(page.locator('.folder-row', { hasText: 'Imported' })).toBeVisible()

  const savedVault = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('web-obsidian:vault') || '{}'),
  )

  expect(savedVault.notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'Imported/Existing.md',
        content: '# Original',
      }),
      expect.objectContaining({
        path: 'Imported/Existing 2.md',
        content: '# Imported',
      }),
    ]),
  )
})
