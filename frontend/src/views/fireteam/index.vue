<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">维护扑火队伍，围绕队伍编号、队伍名称、所属林场、队长姓名做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <section class="reminder-panel">
      <header class="reminder-head">
        <h3>处置提醒</h3>
        <p class="page-desc">
          下达出动后值班状态进入火场处置并生成提醒，同一队伍同时只有一条待处置提醒；撤回队伍时提醒同次闭环。
        </p>
        <button class="btn" type="button" @click="recheck">核对提醒</button>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>提醒编号</th>
            <th>队伍编号</th>
            <th>队伍名称</th>
            <th>所属林场</th>
            <th>出动批次</th>
            <th>出动时间</th>
            <th>提醒状态</th>
            <th>处置时间</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="reminder in reminders"
            :key="String(reminder.id)"
            :class="{ 'reminder-open': reminder.status === '待处置' }"
          >
            <td>{{ reminder['提醒编号'] ?? '—' }}</td>
            <td>{{ reminder['队伍编号'] ?? '—' }}</td>
            <td>{{ reminder['队伍名称'] ?? '—' }}</td>
            <td>{{ reminder['所属林场'] ?? '—' }}</td>
            <td>{{ reminder['出动批次'] ?? '—' }}</td>
            <td>{{ reminder['出动时间'] || '—' }}</td>
            <td>{{ reminder.status }}</td>
            <td>{{ reminder['处置时间'] || '—' }}</td>
            <td>{{ reminder['创建来源'] ?? '—' }}</td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="9" class="empty-state">暂无处置提醒，下达出动后自动生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listDispatchReminders,
  listEntries,
  moduleMeta,
  reconcileDispatch,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fireteam')
const columns = ["队伍编号", "队伍名称", "所属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态"]
const actions = ["下达出动", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]
const stats = [{"label": "队伍总数", "value": 0}, {"label": "待命队伍", "value": 0}, {"label": "出动队伍", "value": 0}]

const rows = ref<EntryRow[]>([])
const reminders = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  // 撤回/出动后回到面板再核对一遍提醒，保证队伍、装备、提醒三者一致。
  reconcileDispatch()
  reload()
}

function recheck() {
  errorMessage.value = ''
  const result = reconcileDispatch()
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reminders.value = listDispatchReminders()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(() => {
  // 进入值班面板先核对一次：历史出动中的队伍补建提醒，已撤回的闭环残留提醒。
  const result = reconcileDispatch()
  if (result.ok && result.changed) {
    noticeMessage.value = result.message
  }
  reload()
})
</script>
