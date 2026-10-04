<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，围绕排班编号、值勤日期、值勤时段、值勤岗位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值勤排班表</button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
        </tr>
      </tbody>
    </table>

    <section class="reminder-panel">
      <header class="reminder-head">
        <h3>处置提醒</h3>
        <span>扑火队伍撤回后在这里核对装备归还与值班记录，待核对 {{ pendingReminders }} 条</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>提醒编号</th>
            <th>提醒类型</th>
            <th>关联单号</th>
            <th>所属林场</th>
            <th>提醒内容</th>
            <th>生成时间</th>
            <th>当前状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in reminders" :key="String(row.id)">
            <td>{{ row['提醒编号'] }}</td>
            <td>{{ row['提醒类型'] }}</td>
            <td>{{ row['关联单号'] }}</td>
            <td>{{ row['所属林场'] || '—' }}</td>
            <td>{{ row['提醒内容'] }}</td>
            <td>{{ row['生成时间'] }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-if="row.status === '待核对'"
                class="link"
                type="button"
                @click="check(row)"
              >
                核对
              </button>
              <span v-else>已核对 {{ row['核对时间'] }}</span>
            </td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="8" class="empty-state">暂无处置提醒，撤回扑火队伍后会在这里生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { checkReminder, listReminders } from '@/api/team-chain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录", "排班状态"]
const actions = ["确认排班", "记录交接", "申请调班"]
const statuses = ["待确认", "已确认", "值勤中", "已交接", "已调班"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reminders = ref<EntryRow[]>([])
const pendingReminders = computed(
  () => reminders.value.filter((row) => String(row.status) === '待核对').length,
)
const stats = computed(() => [
  { label: '今日值勤人数', value: rows.value.filter((row) => String(row.status) === '值勤中').length },
  { label: '待交接次数', value: rows.value.filter((row) => String(row.status) === '已确认').length },
  { label: '调班申请数', value: rows.value.filter((row) => String(row.status) === '已调班').length },
  { label: '待核对提醒', value: pendingReminders.value },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值勤排班表登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function check(row: EntryRow) {
  errorMessage.value = ''
  const result = checkReminder(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reloadReminders()
}

function reloadReminders() {
  reminders.value = listReminders()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值勤排班列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadReminders()
})
</script>
