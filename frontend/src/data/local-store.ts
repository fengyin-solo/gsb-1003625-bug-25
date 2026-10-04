import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: Record<string, EntryRow[]> | null = null

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    // 没有浏览器存储（如冒烟脚本）时，内存缓存就是权威数据。
    return cache ?? fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

// 绕过内存缓存，直接读存储里的最新状态：并发核对（先到先得）以它为准。
export function readFresh(): Record<string, EntryRow[]> {
  cache = readStorage()
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 多键同次落库：先拼好整份数据再一次性写入，队伍、装备、提醒要么一起生效，要么一起退回。
// expected 传入「键 -> 指纹」时做先到先得校验：指纹不符说明已有先到结果，整体不写，返回 false。
// 写入本身抛错（如存储超限）时缓存不动，异常抛给调用方，本次改动整体退回。
export function saveEntries(
  changed: Record<string, EntryRow[]>,
  expected?: Record<string, string>,
): boolean {
  const base = readFresh()
  if (expected) {
    for (const [key, fingerprint] of Object.entries(expected)) {
      if (JSON.stringify(base[key] ?? []) !== fingerprint) {
        return false
      }
    }
  }
  const next = { ...base, ...changed }
  const payload = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, payload)
  }
  cache = next
  return true
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
