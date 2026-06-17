import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const testVault = {
  name: 'Folder Trash Test Vault',
  importedAt: '2026-06-18T00:00:00.000Z',
  folders: ['Root', 'Root/Target', 'Root/Target/Nested', 'Root/Keep'],
  notes: [
    {
      id: 'root/target/a.md',
      title: 'A',
      path: 'Root/Target/A.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# A',
      links: [],
    },
    {
      id: 'root/target/nested/b.md',
      title: 'B',
      path: 'Root/Target/Nested/B.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# B',
      links: [],
    },
    {
      id: 'root/keep/c.md',
      title: 'C',
      path: 'Root/Keep/C.md',
      updatedAt: '2026-06-18T00:00:00.000Z',
      content: '# C',
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

test('folder context menu can move all child markdown files to trash', async ({ page }) => {
  await seedVault(page)

  await page.locator('.folder-row', { hasText: 'Root' }).click()
  await page.locator('.folder-row', { hasText: 'Target' }).click({ button: 'right' })
  await page.locator('.context-menu').getByText('Move folder to trash').click()

  await expect(page.locator('.folder-row', { hasText: 'Target' })).toBeHidden()
  await expect(page.locator('.folder-row', { hasText: 'Keep' })).toBeVisible()

  await page.getByRole('button', { name: /Trash 2/ }).click()
  await expect(page.locator('.trash-list')).toContainText('Root/Target/A.md')
  await expect(page.locator('.trash-list')).toContainText('Root/Target/Nested/B.md')
})
