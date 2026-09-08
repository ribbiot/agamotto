'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface ConfiguredRepo {
  id: string
  owner: string
  name: string
  webhook_secret: string | null
  active: boolean
  auto_start: boolean
  created_at: string
}

export function ReposManager({
  initialRepos,
  isAdmin,
}: {
  initialRepos: ConfiguredRepo[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setAdding(true)

    const trimmed = input.trim()
    // Accept "owner/name" shorthand or full github URL
    const body = trimmed.includes('github.com')
      ? { repoUrl: trimmed }
      : (() => {
          const parts = trimmed.split('/')
          return parts.length === 2
            ? { owner: parts[0], name: parts[1] }
            : { repoUrl: trimmed }
        })()

    try {
      const res = await fetch('/api/queue/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to add repo')
        return
      }
      setSuccess(`Added ${data.repo.owner}/${data.repo.name}`)
      setInput('')
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setAdding(false)
    }
  }

  async function handleToggleAutoStart(repo: ConfiguredRepo) {
    setError(null)
    setSuccess(null)
    setTogglingId(repo.id)
    try {
      const res = await fetch(`/api/queue/repos/${repo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_start: !repo.auto_start }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Failed to update auto-start')
        return
      }
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setTogglingId(null)
    }
  }

  async function handleRemove(repo: ConfiguredRepo) {
    if (
      !confirm(
        `Remove ${repo.owner}/${repo.name}?\n\nExisting tracked PRs for this repo will not be deleted.`
      )
    )
      return
    setRemovingId(repo.id)
    try {
      await fetch(`/api/queue/repos/${repo.id}`, { method: 'DELETE' })
      router.refresh()
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <form onSubmit={handleAdd} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="owner/repo or https://github.com/owner/repo"
            required
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={adding}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {adding ? 'Adding…' : '+ Add Repo'}
          </button>
        </form>
      ) : (
        <p className="text-sm text-gray-500">
          Only admins can add or remove configured repos.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-lg border border-green-800 bg-green-950/30 px-3 py-2 text-sm text-green-400">
          ✓ {success}
        </p>
      )}

      {initialRepos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-800 py-8 text-center text-sm text-gray-500">
          No repos configured yet.
        </p>
      ) : (
        <div className="divide-y divide-gray-800 rounded-lg border border-gray-800">
          {initialRepos.map(repo => (
            <div
              key={repo.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <a
                  href={`https://github.com/${repo.owner}/${repo.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-white transition hover:text-indigo-300"
                >
                  {repo.owner}/{repo.name}
                </a>
                <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-500">
                  {repo.webhook_secret ? (
                    <span className="text-green-500">● Webhook configured</span>
                  ) : (
                    <span className="text-gray-600">No webhook</span>
                  )}
                  {!repo.active && (
                    <span className="text-red-400">Inactive</span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="ml-4 flex items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={Boolean(repo.auto_start)}
                      disabled={togglingId === repo.id}
                      onChange={() => handleToggleAutoStart(repo)}
                      className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500"
                    />
                    Auto-start
                  </label>
                  <button
                    onClick={() => handleRemove(repo)}
                    disabled={removingId === repo.id}
                    className="rounded-md border border-gray-800 px-2.5 py-1.5 text-xs text-gray-600 transition hover:border-red-900 hover:text-red-400 disabled:opacity-50"
                  >
                    {removingId === repo.id ? '…' : 'Remove'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
