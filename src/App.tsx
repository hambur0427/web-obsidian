import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  Cloud,
  DownloadCloud,
  FileDown,
  FileText,
  FolderOpen,
  Link2,
  Plus,
  Search,
  UploadCloud,
} from 'lucide-react'
import './App.css'

type Note = {
  id: string
  title: string
  path: string
  content: string
  links: string[]
  updatedAt: string
}

type VaultState = {
  name: string
  notes: Note[]
  importedAt: string
}

type CloudVaultResponse = {
  ok: boolean
  vault?: VaultState
  error?: string
}

const STORAGE_KEY = 'web-obsidian:vault'
const API_HEALTH_ENDPOINT = '/api/health'
const API_VAULT_ENDPOINT = '/api/vault'

const sampleVault: VaultState = {
  name: 'Demo Cloud Vault',
  importedAt: new Date().toISOString(),
  notes: [
    {
      id: 'welcome.md',
      title: 'Welcome',
      path: 'Welcome.md',
      updatedAt: new Date().toISOString(),
      content:
        '# Welcome\n\nThis is a Vercel-ready Obsidian-style vault. Import a local Obsidian folder, edit Markdown, resolve [[wiki links]], then save the vault to Vercel Blob.\n\nOpen [[Projects/Web Obsidian]] to see backlinks.',
      links: ['Projects/Web Obsidian'],
    },
    {
      id: 'projects/web-obsidian.md',
      title: 'Web Obsidian',
      path: 'Projects/Web Obsidian.md',
      updatedAt: new Date().toISOString(),
      content:
        '# Web Obsidian\n\nThe browser imports Markdown files from your local vault. The Vercel API stores the current vault JSON in Vercel Blob, so you do not need Supabase for the first version.\n\nBack to [[Welcome]].',
      links: ['Welcome'],
    },
  ],
}

marked.use({
  gfm: true,
  breaks: true,
})

function App() {
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [vault, setVault] = useState<VaultState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : sampleVault
  })
  const [activeId, setActiveId] = useState(vault.notes[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [cloudStatus, setCloudStatus] = useState('Local mode')
  const [isSyncing, setIsSyncing] = useState(false)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault))
  }, [vault])

  useEffect(() => {
    const controller = new AbortController()

    fetch(API_HEALTH_ENDPOINT, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { storage?: string }) => {
        setCloudStatus(data.storage === 'blob-configured' ? 'Vercel Blob ready' : 'Cloud API ready')
      })
      .catch(() => {
        if (!controller.signal.aborted) setCloudStatus('Local mode')
      })

    return () => controller.abort()
  }, [])

  const notesByTitle = useMemo(() => {
    const map = new Map<string, Note>()
    vault.notes.forEach((note) => {
      map.set(normalizeTitle(note.title), note)
      map.set(normalizeTitle(note.path.replace(/\.md$/i, '')), note)
    })
    return map
  }, [vault.notes])

  const activeNote = vault.notes.find((note) => note.id === activeId) ?? vault.notes[0]

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return vault.notes
    return vault.notes.filter((note) =>
      [note.title, note.path, note.content].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    )
  }, [query, vault.notes])

  const backlinks = useMemo(() => {
    if (!activeNote) return []
    const title = normalizeTitle(activeNote.title)
    const pathTitle = normalizeTitle(activeNote.path.replace(/\.md$/i, ''))
    return vault.notes.filter(
      (note) =>
        note.id !== activeNote.id &&
        note.links.some((link) => {
          const normalized = normalizeTitle(link)
          return normalized === title || normalized === pathTitle
        }),
    )
  }, [activeNote, vault.notes])

  const renderedMarkdown = useMemo(() => {
    if (!activeNote) return ''
    const linkedContent = activeNote.content.replace(
      /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (_, target: string, alias: string) => {
        const note = notesByTitle.get(normalizeTitle(target))
        const label = alias || target
        return note ? `[${label}](#note:${note.id})` : `<span class="missing-link">${label}</span>`
      },
    )
    return DOMPurify.sanitize(marked.parse(linkedContent) as string)
  }, [activeNote, notesByTitle])

  function openDirectoryPicker() {
    directoryInputRef.current?.click()
  }

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  async function loadCloudVault() {
    setIsSyncing(true)
    setCloudStatus('Loading cloud vault')

    try {
      const response = await fetch(API_VAULT_ENDPOINT)
      const data = (await response.json()) as CloudVaultResponse

      if (!response.ok || !data.vault) {
        throw new Error(data.error || 'No cloud vault found')
      }

      setVault(data.vault)
      setActiveId(data.vault.notes[0]?.id ?? '')
      setCloudStatus('Loaded from Vercel Blob')
    } catch (error) {
      setCloudStatus(error instanceof Error ? error.message : 'Load failed')
    } finally {
      setIsSyncing(false)
    }
  }

  async function saveCloudVault() {
    setIsSyncing(true)
    setCloudStatus('Saving to Vercel Blob')

    try {
      const response = await fetch(API_VAULT_ENDPOINT, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(vault),
      })
      const data = (await response.json()) as CloudVaultResponse

      if (!response.ok) {
        throw new Error(data.error || 'Save failed')
      }

      setCloudStatus('Saved to Vercel Blob')
    } catch (error) {
      setCloudStatus(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setIsSyncing(false)
    }
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return

    const markdownFiles = files.filter(
      (file) =>
        file.name.toLowerCase().endsWith('.md') &&
        !getRelativePath(file).split('/').includes('.obsidian'),
    )

    const notes = await Promise.all(
      markdownFiles.map(async (file) => {
        const path = getRelativePath(file)
        const content = await file.text()
        const title = path.split('/').pop()?.replace(/\.md$/i, '') || file.name
        return {
          id: path.toLowerCase(),
          title,
          path,
          content,
          links: extractWikiLinks(content),
          updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
        }
      }),
    )

    const importedVault = {
      name: guessVaultName(markdownFiles[0]) || 'Imported Vault',
      notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
      importedAt: new Date().toISOString(),
    }

    setVault(importedVault)
    setActiveId(importedVault.notes[0]?.id ?? '')
    setCloudStatus('Imported locally. Save cloud to persist.')
    event.target.value = ''
  }

  function createNote() {
    const stamp = new Date()
    const title = `Untitled ${vault.notes.length + 1}`
    const note: Note = {
      id: `${title.toLowerCase().replace(/\s+/g, '-')}.md`,
      title,
      path: `${title}.md`,
      content: `# ${title}\n\n`,
      links: [],
      updatedAt: stamp.toISOString(),
    }
    setVault((current) => ({
      ...current,
      notes: [note, ...current.notes],
      importedAt: stamp.toISOString(),
    }))
    setActiveId(note.id)
    setCloudStatus('Unsaved local changes')
  }

  function updateActiveNote(content: string) {
    if (!activeNote) return
    setVault((current) => ({
      ...current,
      notes: current.notes.map((note) =>
        note.id === activeNote.id
          ? {
              ...note,
              content,
              links: extractWikiLinks(content),
              updatedAt: new Date().toISOString(),
            }
          : note,
      ),
    }))
    setCloudStatus('Unsaved local changes')
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(vault, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${vault.name.replace(/\s+/g, '-').toLowerCase()}-vault.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function handlePreviewClick(event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    const href = anchor?.getAttribute('href')
    if (!href?.startsWith('#note:')) return
    event.preventDefault()
    setActiveId(href.replace('#note:', ''))
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Cloud size={28} aria-hidden="true" />
          <div>
            <strong>Cloud Vault</strong>
            <span>{vault.name}</span>
          </div>
        </div>

        <div className="toolbar" aria-label="Vault actions">
          <button type="button" onClick={openDirectoryPicker} title="Import Obsidian folder">
            <FolderOpen size={18} aria-hidden="true" />
            Import folder
          </button>
          <button type="button" onClick={openFilePicker} title="Import Markdown files">
            <UploadCloud size={18} aria-hidden="true" />
            Import files
          </button>
          <button type="button" onClick={loadCloudVault} disabled={isSyncing} title="Load from Vercel Blob">
            <DownloadCloud size={18} aria-hidden="true" />
            Load cloud
          </button>
          <button type="button" onClick={saveCloudVault} disabled={isSyncing} title="Save to Vercel Blob">
            <UploadCloud size={18} aria-hidden="true" />
            Save cloud
          </button>
          <button type="button" onClick={createNote} title="Create note">
            <Plus size={18} aria-hidden="true" />
            New
          </button>
          <button type="button" onClick={downloadJson} title="Export JSON">
            <FileDown size={18} aria-hidden="true" />
            Export
          </button>
        </div>

        <input
          ref={(node) => {
            directoryInputRef.current = node
            node?.setAttribute('webkitdirectory', '')
            node?.setAttribute('directory', '')
          }}
          className="hidden-input"
          type="file"
          multiple
          onChange={importFiles}
          aria-hidden="true"
        />
        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          multiple
          accept=".md,text/markdown,text/plain"
          onChange={importFiles}
          aria-hidden="true"
        />

        <label className="search">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, path, or content"
          />
        </label>

        <div className="stats">
          <span>{vault.notes.length} notes</span>
          <span>{countLinks(vault.notes)} links</span>
          <span>{cloudStatus}</span>
        </div>

        <nav className="note-list" aria-label="Notes">
          {filteredNotes.map((note) => (
            <button
              type="button"
              key={note.id}
              className={note.id === activeNote?.id ? 'active' : ''}
              onClick={() => setActiveId(note.id)}
            >
              <FileText size={16} aria-hidden="true" />
              <span>
                <strong>{note.title}</strong>
                <small>{note.path}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="editor-pane">
        {activeNote ? (
          <>
            <header className="note-header">
              <div>
                <p>{activeNote.path}</p>
                <h1>{activeNote.title}</h1>
              </div>
              <span>{new Date(activeNote.updatedAt).toLocaleString()}</span>
            </header>
            <textarea
              value={activeNote.content}
              onChange={(event) => updateActiveNote(event.target.value)}
              spellCheck="false"
              aria-label="Markdown editor"
            />
          </>
        ) : (
          <div className="empty-state">Import a vault or create the first note.</div>
        )}
      </section>

      <aside className="preview-pane">
        <div className="preview-scroll">
          <section
            className="markdown-preview"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
          />

          <section className="relations">
            <h2>
              <Link2 size={18} aria-hidden="true" />
              Links
            </h2>
            <div className="relation-group">
              <strong>Outgoing</strong>
              {activeNote?.links.length ? (
                activeNote.links.map((link) => (
                  <button
                    type="button"
                    key={link}
                    onClick={() => {
                      const note = notesByTitle.get(normalizeTitle(link))
                      if (note) setActiveId(note.id)
                    }}
                    className={notesByTitle.has(normalizeTitle(link)) ? '' : 'missing'}
                  >
                    {link}
                  </button>
                ))
              ) : (
                <span>No links</span>
              )}
            </div>
            <div className="relation-group">
              <strong>Backlinks</strong>
              {backlinks.length ? (
                backlinks.map((note) => (
                  <button type="button" key={note.id} onClick={() => setActiveId(note.id)}>
                    {note.title}
                  </button>
                ))
              ) : (
                <span>No backlinks</span>
              )}
            </div>
          </section>
        </div>
      </aside>
    </main>
  )
}

function getRelativePath(file: File) {
  return ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(
    /\\/g,
    '/',
  )
}

function guessVaultName(file?: File) {
  if (!file) return ''
  const path = getRelativePath(file)
  return path.includes('/') ? path.split('/')[0] : ''
}

function extractWikiLinks(content: string) {
  return Array.from(content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
    .map((match) => match[1].trim())
    .filter(Boolean)
}

function normalizeTitle(value: string) {
  return value.replace(/\.md$/i, '').trim().toLowerCase()
}

function countLinks(notes: Note[]) {
  return notes.reduce((total, note) => total + note.links.length, 0)
}

export default App
