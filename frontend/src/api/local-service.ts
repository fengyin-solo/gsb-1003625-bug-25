import {
  TEAM_CHAIN_ACTIONS,
  listReminders,
  normalizeEquipmentRow,
  normalizeTeamRow,
  reconcileChain,
  runTeamAction,
} from '@/api/dispatch-chain'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 装备台账与队伍出动共用一条单向链：可用 → 已领用 → 待检修 → 已报废，只允许往前走。
// （归还装备不走通用动作，由撤回队伍的联动链按批次写回「可用」。）
const ONE_WAY_FLOWS: Record<string, string[]> = {
  equipment: ['可用', '已领用', '待检修', '已报废'],
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  let rows = listRows(key)
  // 队伍与装备的展示字段按权威状态推导，历史记录里的旧值不会在列表上造成矛盾。
  if (key === 'fireteam') {
    rows = rows.map(normalizeTeamRow)
  }
  if (key === 'equipment') {
    rows = rows.map(normalizeEquipmentRow)
  }
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  // 扑火队伍的出动/撤回/休整走联动回写链：队伍、装备、处置提醒同次落库。
  if (key === 'fireteam' && TEAM_CHAIN_ACTIONS.includes(action)) {
    return runTeamAction(id, action)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const oneWay = ONE_WAY_FLOWS[key]
  if (oneWay) {
    const from = oneWay.indexOf(current)
    const to = oneWay.indexOf(target)
    if (from >= 0 && to >= 0 && to < from) {
      return {
        ok: false,
        message: `${meta.entity}当前状态「${current}」，状态只能单向推进（${oneWay.join(' → ')}），不能执行「${action}」`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  // 回写业务状态字段（每个模块最后一个字段）：列表展示列与当前状态不再互相矛盾。
  const statusField = meta.fields[meta.fields.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    [statusField]: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 处置提醒：随队伍出动生成、随撤回闭环，这里只读；核对入口幂等，可反复点。
export function listDispatchReminders(): EntryRow[] {
  return listReminders()
}

export { reconcileChain as reconcileDispatch }
export type { ReconcileResult } from '@/api/dispatch-chain'

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
