import { listRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 扑火队伍的回写链路：队伍状态每推进一步，要同步回写三处——
//   1. 队伍行内的「值班状态 / 出动状态」业务字段（列表不再和当前状态打架）；
//   2. 装备台账：撤回时把该队伍原林场下「已领用」的装备归还为「可用」（不留标记残留）；
//   3. 处置提醒：撤回时在值班面板补建一条待核对提醒（幂等，不重复显示）。
//
// 值班状态进入处置的动作链（只能单向推进，不允许倒退）：
//   在营待命 --下达出动--> 已出动 --撤回队伍--> 已撤回 --转入休整--> 休整中
//                          （扑救中）--撤回队伍--> 已撤回
const TEAM_FLOW: Record<string, { from: string[]; to: string }> = {
  下达出动: { from: ['在营待命'], to: '已出动' },
  撤回队伍: { from: ['已出动', '扑救中'], to: '已撤回' },
  转入休整: { from: ['已撤回'], to: '休整中' },
}

// 处置提醒存放在独立的 key 下，不注册成业务模块，只在值班面板上展示核对。
export const REMINDER_KEY = 'reminder'

const REMINDER_TYPE_RECALL = '撤回处置'

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 撤回处置提醒按「队伍 + 类型 + 待核对」幂等：已存在就不再补建，避免处置提醒重复显示。
function findOpenRecallReminder(reminders: EntryRow[], teamCode: string): EntryRow | undefined {
  return reminders.find(
    (row) =>
      String(row['提醒类型']) === REMINDER_TYPE_RECALL &&
      String(row['关联单号']) === teamCode &&
      String(row.status) === '待核对',
  )
}

function buildRecallReminder(reminders: EntryRow[], team: EntryRow, returnedCount: number): EntryRow {
  const id = nextId(reminders)
  const teamName = String(team['队伍名称'] ?? team['队伍编号'] ?? team.id)
  const farm = String(team['所属林场'] ?? '').trim()
  const dispatchAt = String(team['出动时间'] ?? '').trim() || '—'
  return {
    id,
    status: '待核对',
    pending: true,
    abnormal: false,
    提醒编号: `REM-${String(id).padStart(4, '0')}`,
    提醒类型: REMINDER_TYPE_RECALL,
    关联模块: '扑火队伍',
    关联单号: String(team['队伍编号'] ?? team.id),
    所属林场: farm,
    提醒内容: `队伍「${teamName}」已撤回${farm ? `（归属${farm}）` : ''}，归还装备 ${returnedCount} 件；原出动时间 ${dispatchAt}，请核对装备台账与值班记录`,
    生成时间: now(),
    核对时间: '',
  }
}

// 队伍动作的统一入口：校验单向流转，然后在一个事务里回写队伍、装备、提醒。
export function runTeamAction(id: number, action: string): ActionResult {
  const flow = TEAM_FLOW[action]
  if (!flow) {
    return { ok: false, message: `扑火队伍没有登记「${action}」这个动作` }
  }
  // 落库失败（如存储不可用）时 transact 会抛错：此时什么都没写入，缓存也没动，
  // 队伍、装备、提醒一起退回，这里把异常折成失败结果交给页面提示。
  try {
    return transact<ActionResult>((rows) => {
      const teams = rows['fireteam'] ?? []
      const index = teams.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        return { ok: false, result: { ok: false, message: `没有找到编号为 ${id} 的扑火队伍` } }
      }
      const team = teams[index]
      const current = String(team.status)
      if (!flow.from.includes(current)) {
        // 并发撤回：状态已被先到的请求推进到位，后到的直接拒掉，只认先到结果。
        const message =
          current === flow.to
            ? `队伍已${action}（先到结果已生效），本次操作未执行`
            : `队伍当前为「${current}」，不能执行「${action}」，状态只能单向推进`
        return { ok: false, result: { ok: false, message } }
      }

      // 队伍回写：主状态与值班/出动状态字段同步；撤回、休整后清掉 pending 标记，不留残留。
      const updatedTeam: EntryRow = {
        ...team,
        status: flow.to,
        值班状态: flow.to,
        出动状态: flow.to,
        pending: action === '下达出动',
        abnormal: false,
      }
      // 出动时间只在首次出动时记录；撤回、休整一律不动，原出动时间保持原样。
      if (action === '下达出动' && !String(team['出动时间'] ?? '').trim()) {
        updatedTeam['出动时间'] = now()
      }
      // 所属林场保持原值：撤回后队伍仍按原林场归属，装备也归还原林场。
      const nextTeams = [...teams]
      nextTeams[index] = updatedTeam
      const next: Record<string, EntryRow[]> = { ...rows, fireteam: nextTeams }
      let message = `扑火队伍已${action}，当前状态「${flow.to}」`

      if (action === '撤回队伍') {
        // 装备回写：归还该队伍原林场（保管林场匹配）下所有「已领用」装备。
        const farm = String(team['所属林场'] ?? '').trim()
        let returned = 0
        const equipment = rows['equipment'] ?? []
        next['equipment'] = equipment.map((item) => {
          if (farm !== '' && String(item.status) === '已领用' && String(item['保管林场'] ?? '') === farm) {
            returned += 1
            return { ...item, status: '可用', 装备状态: '可用', pending: false, abnormal: false }
          }
          return item
        })
        // 处置提醒：与队伍、装备同次落库；已有待核对提醒则不重复补建。
        const reminders = rows[REMINDER_KEY] ?? []
        const teamCode = String(team['队伍编号'] ?? team.id)
        if (findOpenRecallReminder(reminders, teamCode)) {
          message += `，归还装备 ${returned} 件（处置提醒已存在，未重复补建）`
        } else {
          next[REMINDER_KEY] = [...reminders, buildRecallReminder(reminders, updatedTeam, returned)]
          message += `，归还装备 ${returned} 件，已补建处置提醒`
        }
      }
      return { ok: true, next, result: { ok: true, message } }
    })
  } catch (error) {
    return { ok: false, message: `落库失败，本次${action}已整体退回：${error instanceof Error ? error.message : '未知错误'}` }
  }
}

export function listReminders(): EntryRow[] {
  return listRows(REMINDER_KEY)
}

// 值班面板上的提醒核对：待核对 → 已核对，同样只能单向推进。
export function checkReminder(id: number): ActionResult {
  try {
    return transact<ActionResult>((rows) => {
      const reminders = rows[REMINDER_KEY] ?? []
      const index = reminders.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        return { ok: false, result: { ok: false, message: '没有找到这条处置提醒' } }
      }
      if (String(reminders[index].status) !== '待核对') {
        return { ok: false, result: { ok: false, message: '提醒已核对过，不用重复核对' } }
      }
      const nextReminders = [...reminders]
      nextReminders[index] = { ...reminders[index], status: '已核对', pending: false, 核对时间: now() }
      return {
        ok: true,
        next: { ...rows, [REMINDER_KEY]: nextReminders },
        result: { ok: true, message: '处置提醒已核对' },
      }
    })
  } catch (error) {
    return { ok: false, message: `落库失败，本次核对已退回：${error instanceof Error ? error.message : '未知错误'}` }
  }
}
