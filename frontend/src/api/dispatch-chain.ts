import { readFresh, saveEntries } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 扑火队伍出动/撤回的联动回写链：队伍、装备、处置提醒三张表同一个 localStorage 键，同次落库。
// 页面不直接引用这里，统一由 local-service.ts 调进来。

// 处置提醒与业务数据同库存放，保证和队伍、装备同次落库。
export const REMINDER_KEY = 'dispatch-reminder'

// 队伍状态机：只能沿这个顺序单向推进，撤回后不能再出动。
// 在营待命 --下达出动--> 已出动 --> 扑救中 --撤回队伍--> 已撤回 --转入休整--> 休整中
const TEAM_FLOW = ['在营待命', '已出动', '扑救中', '已撤回', '休整中']

// 值班面板上的两个展示字段随状态推导：值班状态经过「下达出动」进入处置（火场处置），
// 经过「撤回队伍」退出处置（已归队）；出动状态记录出动/撤回的事实。
const DUTY_PHASE: Record<string, string> = {
  在营待命: '在营待命',
  已出动: '火场处置',
  扑救中: '火场处置',
  已撤回: '已归队',
  休整中: '休整中',
}
const DEPLOY_PHASE: Record<string, string> = {
  在营待命: '未出动',
  已出动: '已出动',
  扑救中: '已出动',
  已撤回: '已撤回',
  休整中: '已撤回',
}

// 只有这两种状态算「处置中」：撤回、休整之后处置即闭环。
const DISPATCHING = ['已出动', '扑救中']

// 每个动作允许的前置状态：值班状态经过哪些动作进入处置，看这张表就够了。
const TEAM_ACTION_FLOW: Record<string, { from: string[]; to: string }> = {
  下达出动: { from: ['在营待命'], to: '已出动' },
  撤回队伍: { from: ['已出动', '扑救中'], to: '已撤回' },
  转入休整: { from: ['已撤回'], to: '休整中' },
}

export const TEAM_CHAIN_ACTIONS = Object.keys(TEAM_ACTION_FLOW)

export type ReconcileResult = {
  ok: boolean
  changed: boolean
  message: string
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function replaceRow(rows: EntryRow[], next: EntryRow): EntryRow[] {
  return rows.map((row) => (Number(row.id) === Number(next.id) ? next : row))
}

function fingerprints(base: Record<string, EntryRow[]>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, JSON.stringify(base[key] ?? [])]))
}

// 同次落库的唯一出口：先到指纹校验 + 单条 setItem，失败整体退回。
function commit(
  base: Record<string, EntryRow[]>,
  changed: Record<string, EntryRow[]>,
  keys: string[],
): ActionResult | null {
  let committed = false
  try {
    committed = saveEntries(changed, fingerprints(base, keys))
  } catch {
    return { ok: false, message: '本地存储写入失败，队伍、装备与处置提醒已整体退回，未落库' }
  }
  if (!committed) {
    return { ok: false, message: '数据已被其他值班操作变更，以先到结果为准，本次未写入' }
  }
  return null
}

function buildReminder(
  existing: EntryRow[],
  team: EntryRow,
  batch: string,
  dispatchTime: string,
  created: string,
  source: string,
): EntryRow {
  const id = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return {
    id,
    status: '待处置',
    pending: true,
    abnormal: false,
    提醒编号: `REM-${String(id).padStart(4, '0')}`,
    队伍编号: String(team['队伍编号'] ?? ''),
    队伍名称: String(team['队伍名称'] ?? ''),
    所属林场: String(team['所属林场'] ?? ''),
    出动批次: batch,
    出动时间: dispatchTime,
    创建来源: source,
    创建时间: created,
  }
}

function openReminderOf(reminders: EntryRow[], teamCode: string): EntryRow | undefined {
  return reminders.find((row) => String(row['队伍编号'] ?? '') === teamCode && row.status === '待处置')
}

// 装备归还：撤回后装备回到「可用」，批次标记全部清掉，不留出动痕迹。
function releaseEquipment(row: EntryRow, time: string): EntryRow {
  const next: EntryRow = { ...row, status: '可用', pending: false, 装备状态: '可用', 归还时间: time }
  delete next['领用批次']
  delete next['领用队伍']
  delete next['领用时间']
  return next
}

function dispatchTeam(base: Record<string, EntryRow[]>, team: EntryRow): ActionResult {
  const teams = base['fireteam'] ?? []
  const equipment = base['equipment'] ?? []
  const reminders = base[REMINDER_KEY] ?? []
  const teamCode = String(team['队伍编号'] ?? '')
  const farm = String(team['所属林场'] ?? '')
  const time = now()
  // 原出动时间保持原样：只有首次出动才写，之后任何环节都不覆盖。
  const dispatchTime = String(team['出动时间'] ?? '').trim() || time
  const batch = String(team['出动批次'] ?? '').trim() || `OUT-${team.id}-${Date.now()}`
  const nextTeam: EntryRow = {
    ...team,
    status: '已出动',
    pending: true,
    abnormal: false,
    值班状态: '火场处置',
    出动状态: '已出动',
    出动时间: dispatchTime,
    出动批次: batch,
  }
  // 装备链路：本林场可用装备随队领用，记下领用批次与队伍，撤回时按批次归还。
  let checkedOut = 0
  const nextEquipment = equipment.map((row) => {
    if (row.status !== '可用' || String(row['保管林场'] ?? '') !== farm) {
      return row
    }
    checkedOut += 1
    return {
      ...row,
      status: '已领用',
      pending: true,
      装备状态: '已领用',
      领用批次: batch,
      领用队伍: teamCode,
      领用时间: time,
    }
  })
  // 处置提醒：同一队伍同时只留一条待处置提醒，已存在就不重复创建。
  let nextReminders = reminders
  let reminderNote = '处置提醒已存在，未重复创建'
  if (!openReminderOf(reminders, teamCode)) {
    nextReminders = [...reminders, buildReminder(reminders, team, batch, dispatchTime, time, '出动联动')]
    reminderNote = '已生成处置提醒'
  }
  const failure = commit(
    base,
    { fireteam: replaceRow(teams, nextTeam), equipment: nextEquipment, [REMINDER_KEY]: nextReminders },
    ['fireteam', 'equipment', REMINDER_KEY],
  )
  if (failure) {
    return failure
  }
  return {
    ok: true,
    message: `扑火队伍已下达出动，当前状态「已出动」，值班状态进入火场处置，随队领用装备 ${checkedOut} 台，${reminderNote}`,
  }
}

function recallTeam(base: Record<string, EntryRow[]>, team: EntryRow): ActionResult {
  const teams = base['fireteam'] ?? []
  const equipment = base['equipment'] ?? []
  const reminders = base[REMINDER_KEY] ?? []
  const teamCode = String(team['队伍编号'] ?? '')
  const farm = String(team['所属林场'] ?? '')
  const batch = String(team['出动批次'] ?? '').trim()
  const time = now()
  const nextTeam: EntryRow = {
    ...team,
    status: '已撤回',
    // 撤回后处置闭环：待处理、异常标记一并清掉，不在面板上残留。
    pending: false,
    abnormal: false,
    值班状态: '已归队',
    出动状态: '已撤回',
    撤回时间: time,
    // 出动时间、出动批次原样保留，作为历史痕迹。
  }
  // 装备归还：优先按领用批次；历史数据没有批次时按原林场归属兼容归还。
  let returned = 0
  const nextEquipment = equipment.map((row) => {
    if (row.status !== '已领用') {
      return row
    }
    const byBatch = batch !== '' && String(row['领用批次'] ?? '') === batch
    const byFarm = !row['领用批次'] && String(row['保管林场'] ?? '') === farm
    if (!byBatch && !byFarm) {
      return row
    }
    returned += 1
    return releaseEquipment(row, time)
  })
  // 处置提醒与队伍同次闭环；历史数据本就没有提醒时不补建，只保证不留待处置残留。
  let closed = 0
  const nextReminders = reminders.map((row) => {
    if (String(row['队伍编号'] ?? '') !== teamCode || row.status !== '待处置') {
      return row
    }
    closed += 1
    return { ...row, status: '已处置', pending: false, 处置时间: time, 闭环方式: '撤回联动' }
  })
  const failure = commit(
    base,
    { fireteam: replaceRow(teams, nextTeam), equipment: nextEquipment, [REMINDER_KEY]: nextReminders },
    ['fireteam', 'equipment', REMINDER_KEY],
  )
  if (failure) {
    return { ok: false, message: `撤回失败：${failure.message}` }
  }
  return {
    ok: true,
    message: `扑火队伍已撤回，按原林场归属归还装备 ${returned} 台，闭环处置提醒 ${closed} 条`,
  }
}

function restTeam(base: Record<string, EntryRow[]>, team: EntryRow): ActionResult {
  const teams = base['fireteam'] ?? []
  const nextTeam: EntryRow = {
    ...team,
    status: '休整中',
    pending: false,
    abnormal: false,
    值班状态: '休整中',
  }
  const failure = commit(base, { fireteam: replaceRow(teams, nextTeam) }, ['fireteam'])
  if (failure) {
    return failure
  }
  return { ok: true, message: '扑火队伍已转入休整，当前状态「休整中」' }
}

// 队伍动作的统一入口：先校验单向推进，再进联动链。
export function runTeamAction(id: number, action: string): ActionResult {
  const flow = TEAM_ACTION_FLOW[action]
  if (!flow) {
    return { ok: false, message: `扑火队伍没有登记「${action}」这个动作` }
  }
  const base = readFresh()
  const team = (base['fireteam'] ?? []).find((row) => Number(row.id) === id)
  if (!team) {
    return { ok: false, message: `没有找到编号为 ${id} 的扑火队伍` }
  }
  const current = String(team.status)
  if (current === flow.to) {
    return { ok: false, message: `扑火队伍已经是「${flow.to}」，不用重复操作` }
  }
  if (!flow.from.includes(current)) {
    return {
      ok: false,
      message: `扑火队伍当前状态「${current}」，状态只能单向推进（${TEAM_FLOW.join(' → ')}），不能执行「${action}」`,
    }
  }
  if (action === '下达出动') {
    return dispatchTeam(base, team)
  }
  if (action === '撤回队伍') {
    return recallTeam(base, team)
  }
  return restTeam(base, team)
}

// 列表展示用的推导：历史记录的值班状态/出动状态字段可能是旧值，一律按权威 status 推导。
export function normalizeTeamRow(row: EntryRow): EntryRow {
  const status = String(row.status)
  return {
    ...row,
    值班状态: DUTY_PHASE[status] ?? String(row['值班状态'] ?? ''),
    出动状态: DEPLOY_PHASE[status] ?? String(row['出动状态'] ?? ''),
  }
}

export function normalizeEquipmentRow(row: EntryRow): EntryRow {
  return { ...row, 装备状态: String(row.status) }
}

// 处置提醒列表：待处置的排前面，其余按编号倒序。
export function listReminders(): EntryRow[] {
  const rows = [...(readFresh()[REMINDER_KEY] ?? [])]
  return rows.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === '待处置' ? -1 : 1
    }
    return Number(b.id) - Number(a.id)
  })
}

// 核对提醒：撤回后返回面板再核对一遍，幂等，可反复执行。
// 1) 处置中的队伍必须恰好有一条待处置提醒：缺了按历史补建，多了按先到保留、其余闭环；
// 2) 不在处置中的队伍不允许残留待处置提醒；
// 3) 领用队伍已不在处置中的装备，按批次/原林场归属释放回可用；
// 4) 队伍行的值班状态/出动状态字段按权威状态回写收敛，原出动时间不碰。
export function reconcileChain(): ReconcileResult {
  const base = readFresh()
  const teams = base['fireteam'] ?? []
  const equipment = base['equipment'] ?? []
  const reminders = base[REMINDER_KEY] ?? []
  const time = now()
  let synced = 0
  let backfilled = 0
  let closed = 0
  let deduped = 0
  let released = 0

  const nextTeams = teams.map((team) => {
    const status = String(team.status)
    const next: EntryRow = { ...team }
    let touched = false
    const duty = DUTY_PHASE[status]
    const deploy = DEPLOY_PHASE[status]
    if (duty && next['值班状态'] !== duty) {
      next['值班状态'] = duty
      touched = true
    }
    if (deploy && next['出动状态'] !== deploy) {
      next['出动状态'] = deploy
      touched = true
    }
    // 历史出动中的队伍缺出动批次：补上 LEGACY 批次，撤回与提醒核对都认它。
    if (DISPATCHING.includes(status) && !String(next['出动批次'] ?? '').trim()) {
      next['出动批次'] = `LEGACY-${team.id}`
      touched = true
    }
    if (touched) {
      synced += 1
    }
    return touched ? next : team
  })

  const openByTeam = new Map<string, EntryRow[]>()
  for (const rem of reminders) {
    if (rem.status === '待处置') {
      const code = String(rem['队伍编号'] ?? '')
      openByTeam.set(code, [...(openByTeam.get(code) ?? []), rem])
    }
  }
  const overrides = new Map<number, EntryRow>()
  // 去重：同队伍多条待处置提醒，保留最早一条，其余闭环。
  for (const list of openByTeam.values()) {
    if (list.length < 2) {
      continue
    }
    const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id))
    for (const dup of sorted.slice(1)) {
      overrides.set(Number(dup.id), {
        ...dup,
        status: '已处置',
        pending: false,
        处置时间: time,
        闭环方式: '核对去重',
      })
      deduped += 1
    }
  }
  const added: EntryRow[] = []
  for (const team of nextTeams) {
    const code = String(team['队伍编号'] ?? '')
    const open = (openByTeam.get(code) ?? []).filter((rem) => !overrides.has(Number(rem.id)))
    if (DISPATCHING.includes(String(team.status))) {
      if (open.length === 0) {
        const reminder = buildReminder(
          [...reminders, ...added],
          team,
          String(team['出动批次'] ?? ''),
          String(team['出动时间'] ?? ''),
          time,
          '历史补建',
        )
        added.push(reminder)
        backfilled += 1
      }
    } else {
      for (const rem of open) {
        overrides.set(Number(rem.id), {
          ...rem,
          status: '已处置',
          pending: false,
          处置时间: time,
          闭环方式: '核对闭环',
        })
        closed += 1
      }
    }
  }
  const nextReminders = [...reminders.map((rem) => overrides.get(Number(rem.id)) ?? rem), ...added]

  const dispatchingCodes = new Set(
    nextTeams
      .filter((team) => DISPATCHING.includes(String(team.status)))
      .map((team) => String(team['队伍编号'] ?? '')),
  )
  const nextEquipment = equipment.map((row) => {
    if (row.status !== '已领用') {
      return row
    }
    const owner = String(row['领用队伍'] ?? '')
    if (!owner || dispatchingCodes.has(owner)) {
      return row
    }
    released += 1
    return releaseEquipment(row, time)
  })

  const changed = synced + backfilled + closed + deduped + released > 0
  if (!changed) {
    return { ok: true, changed: false, message: '核对完成：队伍、装备与处置提醒一致，无需调整' }
  }
  const failure = commit(
    base,
    { fireteam: nextTeams, equipment: nextEquipment, [REMINDER_KEY]: nextReminders },
    ['fireteam', 'equipment', REMINDER_KEY],
  )
  if (failure) {
    return { ok: false, changed: false, message: `核对失败：${failure.message}` }
  }
  return {
    ok: true,
    changed: true,
    message: `核对完成：回写队伍 ${synced} 支、补建提醒 ${backfilled} 条、闭环提醒 ${closed} 条、去重提醒 ${deduped} 条、归还装备 ${released} 台`,
  }
}
