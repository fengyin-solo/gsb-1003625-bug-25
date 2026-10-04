import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
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

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
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

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 事务改写的结果：ok 为 false 时什么都不写，调用方把 result 原样带回。
export type TransactOutcome<R> =
  | { ok: true; next: Record<string, EntryRow[]>; result: R }
  | { ok: false; result: R }

// 跨模块的事务式改写（队伍撤回要同时动队伍、装备、提醒三张表）：
// 1. 不走缓存，先从 localStorage 读最新态——并发的两次撤回只认先到的那次结果；
// 2. 校验与组装都在 fn 里完成，返回 ok:false 即整体放弃，半个字也不落库；
// 3. 全部改动合并成一份状态一次性写入，写盘失败时缓存也不动，失败一起退回。
export function transact<R>(fn: (rows: Record<string, EntryRow[]>) => TransactOutcome<R>): R {
  const current = readStorage()
  const outcome = fn(current)
  if (!outcome.ok) {
    return outcome.result
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.next))
  }
  cache = outcome.next
  return outcome.result
}

export function storageKey(): string {
  return STORAGE_KEY
}
