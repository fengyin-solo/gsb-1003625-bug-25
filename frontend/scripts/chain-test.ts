// 链路行为验证脚本：模拟 localStorage，跑 出动→撤回→休整 全链路。
import { runTeamAction, checkReminder, listReminders } from '@/api/team-chain'
import { listRows, storageKey, transact } from '@/data/local-store'

// --- localStorage 内存模拟 ---
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if ((globalThis as any).__failWrite) throw new Error('模拟写盘失败')
      store.set(k, v)
    },
    removeItem: (k: string) => store.delete(k),
  },
}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}`, extra ?? '')
  }
}
function team(id: number) {
  return listRows('fireteam').find((r) => Number(r.id) === id)!
}
function equip(id: number) {
  return listRows('equipment').find((r) => Number(r.id) === id)!
}
function remindersOf(code: string) {
  return listReminders().filter((x) => x['关联单号'] === code)
}

console.log('0. 在营待命不能撤回（单向推进）')
let r = runTeamAction(1, '撤回队伍')
check('在营待命撤回被拒绝', !r.ok)
check('拒绝文案提示单向推进', r.message.includes('单向推进'), r.message)

console.log('1. 出动：状态同步回写，出动时间只记一次')
r = runTeamAction(1, '下达出动')
check('下达出动成功', r.ok, r)
check('主状态=已出动', team(1).status === '已出动')
check('值班状态字段同步', team(1)['值班状态'] === '已出动')
check('出动状态字段同步', team(1)['出动状态'] === '已出动')
check('出动时间已记录', String(team(1)['出动时间'] ?? '').length > 0)
const firstDispatchAt = team(1)['出动时间']
r = runTeamAction(1, '下达出动')
check('重复出动被拒绝（单向）', !r.ok)
r = runTeamAction(1, '转入休整')
check('已出动不能直接转入休整', !r.ok)

console.log('2. 撤回：装备归还、提醒补建、出动时间不动、同次落库')
// 把装备2改成队伍1的林场并置为已领用，模拟台账里的领用标记
const all = JSON.parse(store.get(storageKey())!)
all.equipment = all.equipment.map((e: any) =>
  e.id === 2 ? { ...e, status: '已领用', 装备状态: '已领用', 保管林场: '扑火队伍样例1' } : e,
)
store.set(storageKey(), JSON.stringify(all))
r = runTeamAction(1, '撤回队伍')
check('撤回成功', r.ok, r)
check('主状态=已撤回', team(1).status === '已撤回')
check('值班状态字段同步=已撤回', team(1)['值班状态'] === '已撤回')
check('pending 标记已清（无残留）', team(1).pending === false)
check('abnormal 标记已清（无残留）', team(1).abnormal === false)
check('原出动时间保持原样', team(1)['出动时间'] === firstDispatchAt)
check('所属林场未动', team(1)['所属林场'] === '扑火队伍样例1')
check('同林场已领用装备归还为可用', equip(2).status === '可用' && equip(2)['装备状态'] === '可用')
check('装备 pending 残留已清', equip(2).pending === false)
check('其他林场装备不受影响', equip(1).status === '可用' && equip(3).status === '待检修')
check('补建了一条撤回处置提醒', remindersOf('FIRE-0001').length === 1)
check('提醒状态=待核对', remindersOf('FIRE-0001')[0].status === '待核对')

console.log('3. 并发/重复撤回：只认先到结果')
r = runTeamAction(1, '撤回队伍')
check('二次撤回被拒绝', !r.ok)
check('拒绝文案提示先到结果', r.message.includes('先到结果'), r.message)
check('提醒没有重复补建', remindersOf('FIRE-0001').length === 1)

console.log('4. 提醒核对：单向')
r = checkReminder(Number(remindersOf('FIRE-0001')[0].id))
check('核对成功', r.ok, r)
check('提醒状态=已核对', remindersOf('FIRE-0001')[0].status === '已核对')
check('核对时间已记录', String(remindersOf('FIRE-0001')[0]['核对时间'] ?? '').length > 0)
r = checkReminder(Number(remindersOf('FIRE-0001')[0].id))
check('重复核对被拒绝', !r.ok)

console.log('5. 休整：单向推进到终点')
r = runTeamAction(1, '转入休整')
check('已撤回可转入休整', r.ok, r)
check('主状态=休整中', team(1).status === '休整中')
r = runTeamAction(1, '下达出动')
check('休整中不能再出动（不倒退）', !r.ok)

console.log('6. 历史记录兼容：无出动时间的已出动队伍可撤回，不补写出动时间')
check('seed 队伍2是已出动且无出动时间', team(2).status === '已出动' && !team(2)['出动时间'])
r = runTeamAction(2, '撤回队伍')
check('历史队伍撤回成功', r.ok, r)
check('撤回后不补写出动时间', !team(2)['出动时间'])
check('历史队伍也生成了提醒', remindersOf('FIRE-0002').length === 1)

console.log('7. 提醒幂等：已存在待核对提醒时撤回不重复补建')
// 给队伍3手工注入一条待核对提醒，再撤回队伍3
const withRem = JSON.parse(store.get(storageKey())!)
withRem.reminder.push({
  id: 900,
  status: '待核对',
  pending: true,
  abnormal: false,
  提醒编号: 'REM-0900',
  提醒类型: '撤回处置',
  关联模块: '扑火队伍',
  关联单号: 'FIRE-0003',
  所属林场: '扑火队伍样例3',
  提醒内容: '历史遗留提醒',
  生成时间: '2026-09-03 10:00',
  核对时间: '',
})
store.set(storageKey(), JSON.stringify(withRem))
r = runTeamAction(3, '撤回队伍')
check('扑救中可撤回', r.ok, r)
check('返回文案提示未重复补建', r.message.includes('未重复补建'), r.message)
check('队伍3仍只有注入的那条提醒', remindersOf('FIRE-0003').length === 1)

console.log('8. 事务：写盘失败时队伍与提醒一起退回')
// 先把队伍3的待核对提醒核掉，再造一次可撤回场景：走 transact 把队伍3放回已出动（缓存保持同步）
transact((rows) => ({
  ok: true,
  next: {
    ...rows,
    fireteam: (rows['fireteam'] ?? []).map((t) => (Number(t.id) === 3 ? { ...t, status: '已出动' } : t)),
    reminder: (rows['reminder'] ?? []).map((x) => (Number(x.id) === 900 ? { ...x, status: '已核对' } : x)),
  },
  result: true,
}))
const before = store.get(storageKey())!
;(globalThis as any).__failWrite = true
r = runTeamAction(3, '撤回队伍')
;(globalThis as any).__failWrite = false
check('写盘失败返回失败结果', !r.ok, r)
check('失败文案提示整体退回', r.message.includes('整体退回'), r.message)
check('存储未被污染（整体回退）', store.get(storageKey()) === before)
check('队伍3仍是已出动（缓存也回退）', team(3).status === '已出动')
check('没有为队伍3补建新提醒', remindersOf('FIRE-0003').length === 1)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
