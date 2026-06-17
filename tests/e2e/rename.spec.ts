import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const testVault = {
  name: 'Rename Test Vault',
  importedAt: '2026-06-17T00:00:00.000Z',
  folders: ['Recon', 'Recon/Tools'],
  notes: [
    {
      id: 'recon/tools/tool-design.md',
      title: 'tool-design',
      path: 'Recon/Tools/tool-design.md',
      updatedAt: '2026-06-17T00:00:00.000Z',
      content: '# tool-design',
      links: [],
    },
  ],
}

async function seedVault(page: Page) {
  await page.addInitScript((vault) => {
    window.localStorage.setItem('web-obsidian:vault', JSON.stringify(vault))
  }, testVault)
  await page.goto('/')
  await page.locator('.folder-row', { hasText: 'Recon' }).click()
  await page.locator('.folder-row', { hasText: 'Tools' }).click()
}

test('can rename the same markdown file again after blur cancels the first edit', async ({
  page,
}) => {
  await seedVault(page)

  const noteItem = page.locator('.note-row-wrap').first()
  await expect(noteItem).toBeVisible()
  await expect(noteItem).toContainText('tool-design')
  await noteItem.hover()
  await noteItem.getByTitle('Rename Markdown file').click()

  const firstRenameInput = noteItem.locator('input')
  await expect(firstRenameInput).toBeVisible()
  await page.locator('.live-markdown-block').first().click()
  await expect(firstRenameInput).toBeHidden()

  await noteItem.hover()
  await noteItem.getByTitle('Rename Markdown file').click()

  const secondRenameInput = noteItem.locator('input')
  await expect(secondRenameInput).toBeVisible()
  await secondRenameInput.fill('tool-design-renamed')
  await secondRenameInput.press('Enter')

  await expect(page.locator('.note-row-wrap', { hasText: 'tool-design-renamed' })).toBeVisible()
  await expect(page.locator('.path-edit-button')).toHaveText('Recon/Tools/tool-design-renamed.md')
})

test('markdown context menu rename targets the note, not its parent folder', async ({ page }) => {
  await seedVault(page)

  const noteItem = page.locator('.note-row-wrap').first()
  await expect(noteItem).toContainText('tool-design')
  await noteItem.click()
  await noteItem.click({ button: 'right' })
  await page.locator('.context-menu').getByText('Rename', { exact: true }).click()

  const renameInput = noteItem.locator('input')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('context-renamed')
  await renameInput.press('Enter')

  await expect(page.locator('.note-row-wrap', { hasText: 'context-renamed' })).toBeVisible()
  await expect(page.locator('.folder-row', { hasText: 'Tools' })).toBeVisible()
})
