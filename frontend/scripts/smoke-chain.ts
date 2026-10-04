// 出动/撤回联动链的冒烟验证：不依赖浏览器，localStorage 缺省时数据层走内存。
// 运行：npm run smoke
import assert from 'node:assert/strict'

import {
  listDispatchReminders,
  listEntries,
  reconcileDispatch,
  runAction,
} from '@/api/local-service'
import { readFresh, saveEntries } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

function team(id: number): EntryRow {
  const row = (readFresh()['fireteam'] ?? []).find((item) => Number(item.id) === id)
  assert.ok(row, `队伍 ${id} 应存在`)
  return row
}

function equipment(id: number): EntryRow {
  const row = (readFresh()['equipment'] ?? []).find((item) => Number(item.id) === id)
  assert.ok(row, `装备 ${id} 应存在`)
  return row
}

function openReminders(teamCode: string): EntryRow[] {
  return listDispatchReminders().filter(
    (row) => String(row['队伍编号']) === teamCode && row.status === '待处置',
  )
}

// —— 准备：把装备 1 挂到队伍 1 的林场，模拟台账登记 ——
const base0 = readFresh()
const farm1 = String(team(1)['所属林场'])
saveEntries({
  equipment: (base0['equipment'] ?? []).map((row) =>
    Number(row.id) === 1 ? { ...row, 保管林场: farm1 } : row,
  ),
})

// —— 1. 下达出动：队伍、装备、提醒同次生效 ——
let result = runAction('fireteam', 1, '下达出动')
assert.equal(result.ok, true, `出动应成功：${result.message}`)
assert.equal(team(1).status, '已出动')
assert.equal(team(1)['值班状态'], '火场处置')
assert.equal(team(1)['出动状态'], '已出动')
const dispatchTime = String(team(1)['出动时间'])
assert.ok(dispatchTime.trim() !== '', '出动时间应已写入')
assert.equal(equipment(1).status, '已领用', '本林场可用装备应随队领用')
assert.equal(String(equipment(1)['领用队伍']), String(team(1)['队伍编号']))
assert.equal(openReminders('FIRE-0001').length, 1, '出动后应恰好有一条待处置提醒')
assert.equal(String(openReminders('FIRE-0001')[0]['出动时间']), dispatchTime, '提醒上的出动时间应与队伍一致')

// —— 2. 单向推进：已出动不能再下达出动 ——
result = runAction('fireteam', 1, '下达出动')
assert.equal(result.ok, false, '重复出动应被拒绝')
assert.match(result.message, /单向推进|不用重复操作/)

// —— 3. 撤回队伍：装备按原林场归还、提醒同次闭环、标记不残留 ——
result = runAction('fireteam', 1, '撤回队伍')
assert.equal(result.ok, true, `撤回应成功：${result.message}`)
assert.equal(team(1).status, '已撤回')
assert.equal(team(1).pending, false, '撤回后不应再挂待处理标记')
assert.equal(team(1).abnormal, false, '撤回后不应残留异常标记')
assert.equal(team(1)['值班状态'], '已归队')
assert.equal(team(1)['出动状态'], '已撤回')
assert.equal(String(team(1)['出动时间']), dispatchTime, '原出动时间保持原样')
assert.equal(equipment(1).status, '可用', '装备应归还为可用')
assert.equal(equipment(1)['领用批次'], undefined, '领用批次应清掉')
assert.equal(String(equipment(1)['保管林场']), farm1, '装备保管林场保持原归属')
assert.equal(openReminders('FIRE-0001').length, 0, '撤回后不应残留待处置提醒')
assert.equal(team(1)['所属林场'], farm1, '队伍所属林场保持原归属')

// —— 4. 单向推进：已撤回不能再出动、不能重复撤回 ——
result = runAction('fireteam', 1, '下达出动')
assert.equal(result.ok, false, '撤回后再次出动应被拒绝')
result = runAction('fireteam', 1, '撤回队伍')
assert.equal(result.ok, false, '重复撤回应被拒绝')

// —— 5. 转入休整：已撤回 → 休整中 ——
result = runAction('fireteam', 1, '转入休整')
assert.equal(result.ok, true, `转入休整应成功：${result.message}`)
assert.equal(team(1).status, '休整中')
assert.equal(team(1).pending, false)

// —— 6. 历史记录兼容：种子里的队伍 2（已出动）、队伍 3（扑救中）没有提醒，核对时补建 ——
const reconcile1 = reconcileDispatch()
assert.equal(reconcile1.ok, true)
assert.equal(reconcile1.changed, true, '首次核对应有补建')
assert.equal(openReminders('FIRE-0002').length, 1, '历史已出动队伍应补建提醒')
assert.equal(openReminders('FIRE-0003').length, 1, '历史扑救中队伍应补建提醒')
assert.equal(String(openReminders('FIRE-0002')[0]['创建来源']), '历史补建')
assert.ok(String(team(2)['出动批次']).startsWith('LEGACY-'), '历史队伍应补上 LEGACY 出动批次')

// —— 7. 核对幂等：再核对一遍不应再有改动 ——
const reconcile2 = reconcileDispatch()
assert.equal(reconcile2.ok, true)
assert.equal(reconcile2.changed, false, `核对应幂等：${reconcile2.message}`)

// —— 8. 提醒去重：人为制造重复待处置提醒，核对后只留最早一条 ——
const base8 = readFresh()
const dup: EntryRow = {
  ...openReminders('FIRE-0002')[0],
  id: 900,
  提醒编号: 'REM-0900',
}
saveEntries({ 'dispatch-reminder': [...(base8['dispatch-reminder'] ?? []), dup] })
assert.equal(openReminders('FIRE-0002').length, 2)
const reconcile3 = reconcileDispatch()
assert.equal(reconcile3.ok, true)
assert.equal(openReminders('FIRE-0002').length, 1, '重复提醒应被去重，只留一条')
assert.ok(Number(openReminders('FIRE-0002')[0].id) < 900, '应保留先到的一条')

// —— 9. 历史队伍撤回：LEGACY 批次 + 无批次装备按原林场归属兼容归还 ——
const base9 = readFresh()
const farm2 = String(team(2)['所属林场'])
saveEntries({
  equipment: (base9['equipment'] ?? []).map((row) =>
    Number(row.id) === 2 ? { ...row, 保管林场: farm2, status: '已领用', 装备状态: '已领用' } : row,
  ),
})
result = runAction('fireteam', 2, '撤回队伍')
assert.equal(result.ok, true, `历史队伍撤回应成功：${result.message}`)
assert.equal(team(2).status, '已撤回')
assert.equal(equipment(2).status, '可用', '无批次装备应按原林场归属兼容归还')
assert.equal(openReminders('FIRE-0002').length, 0, '补建的提醒应随撤回闭环')

// —— 10. 并发撤回只接受先到结果：过期指纹整体拒写 ——
const staleSnapshot = readFresh()
result = runAction('fireteam', 3, '撤回队伍') // 另一个值班操作先完成撤回
assert.equal(result.ok, true)
const tampered = (staleSnapshot['fireteam'] ?? []).map((row) =>
  Number(row.id) === 3 ? { ...row, status: '已撤回' } : row,
)
const committed = saveEntries(
  { fireteam: tampered },
  { fireteam: JSON.stringify(staleSnapshot['fireteam'] ?? []) },
)
assert.equal(committed, false, '后到结果应被整体拒绝')
assert.equal(team(3).status, '已撤回', '先到结果保持不变')
assert.equal(openReminders('FIRE-0003').length, 0, '先到撤回已闭环提醒，不被后到覆盖')

// —— 11. 装备台账单向推进 ——
assert.equal(runAction('equipment', 3, '领用装备').ok, false, '待检修不能直接领用')
assert.equal(runAction('equipment', 3, '报废装备').ok, true, '待检修可以报废')
assert.equal(runAction('equipment', 3, '送检登记').ok, false, '已报废不能回退送检')

// —— 12. 列表展示：值班状态/出动状态与当前状态一致 ——
for (const row of listEntries('fireteam').items) {
  const duty = String(row['值班状态'])
  const deploy = String(row['出动状态'])
  if (row.status === '已撤回' || row.status === '休整中') {
    assert.equal(duty === '已归队' || duty === '休整中', true, `撤回后值班状态不应显示在营待命：${duty}`)
    assert.equal(deploy, '已撤回')
  }
  if (row.status === '扑救中') {
    assert.equal(duty, '火场处置')
    assert.equal(deploy, '已出动')
  }
}
for (const row of listEntries('equipment').items) {
  assert.equal(String(row['装备状态']), String(row.status), '装备台账展示字段应与当前状态一致')
}

console.log('smoke-chain: 全部 12 组断言通过')
