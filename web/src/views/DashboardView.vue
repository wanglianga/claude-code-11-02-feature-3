<template>
  <div>
    <div class="toolbar">
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="load" />
      <el-button type="primary" :loading="generating" @click="generate">生成当日任务</el-button>
      <el-button @click="rerunWindow">重跑近 3 天窗口</el-button>
      <span class="spacer" />
      <el-tag v-if="data.summary" type="warning">待人工接管 {{ data.summary.openInterventions }}</el-tag>
      <el-tag v-if="data.summary" type="danger">映射异常 {{ data.summary.openIssues }}</el-tag>
    </div>

    <el-row :gutter="12" class="summary" v-if="data.summary">
      <el-col :span="4"><el-card><div class="num">{{ data.summary.covered }}/{{ data.summary.cells }}</div><div class="lbl">已覆盖 门店×平台</div></el-card></el-col>
      <el-col :span="4"><el-card><div class="num warn">{{ data.summary.missing }}</div><div class="lbl">缺报</div></el-card></el-col>
      <el-col :span="4"><el-card><div class="num provisional">{{ data.summary.substituted }}</div><div class="lbl">临时替代生效</div></el-card></el-col>
      <el-col :span="4"><el-card><div class="num">{{ data.summary.replacements }}</div><div class="lbl">已替换记录</div></el-card></el-col>
      <el-col :span="4"><el-card><div class="num">{{ data.summary.openInterventions }}</div><div class="lbl">人工接管</div></el-card></el-col>
      <el-col :span="4"><el-card><div class="num">{{ data.summary.openIssues }}</div><div class="lbl">映射异常</div></el-card></el-col>
    </el-row>

    <el-card class="mt">
      <template #header>采集矩阵（{{ data.date }}）</template>
      <el-table :data="matrixRows" border size="small">
        <el-table-column label="门店" width="160">
          <template #default="{ row }">
            <b>{{ row.store_code }}</b> {{ row.store_name }}
            <el-tag size="small" effect="plain">{{ row.kind === 'direct' ? '直营' : '加盟' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-for="p in platforms" :key="p" :label="p">
          <template #default="{ row }">
            <div v-if="row.cells[p]">
              <template v-if="row.cells[p].tasks && row.cells[p].tasks.length">
                <el-tooltip v-for="t in row.cells[p].tasks" :key="t.taskId" :content="`${t.username}${t.lastError ? '：' + t.lastError : ''}`">
                  <el-tag class="cell-tag" :type="statusType(t.status)" size="small" @click="$router.push(`/tasks/${t.taskId}`)">
                    {{ t.username }} {{ statusLabel(t.status) }}
                  </el-tag>
                </el-tooltip>
              </template>
              <el-tag v-else class="cell-tag" size="small" type="info" effect="plain">未生成任务</el-tag>
              <div class="files">
                <el-icon v-if="+row.cells[p].active_files > 0" color="#67c23a"><CircleCheckFilled /></el-icon>
                <span v-if="+row.cells[p].active_files > 0">正式文件 {{ row.cells[p].active_files }}</span>
                <span v-else class="miss">缺报</span>
                <el-tag v-if="row.cells[p].activeSubstitute" size="small" type="warning" effect="plain" class="prov-tag">
                  临时替代 · {{ methodLabel(row.cells[p].activeSubstitute.method) }}
                </el-tag>
                <el-tag v-else-if="row.cells[p].lastReplacedSubstitute" size="small" type="success" effect="plain" class="prov-tag">
                  已替换
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="mt">
      <template #header>
        <div class="card-head">
          <span>缺报清单与替代来源建议</span>
          <span class="muted">替代/预估数据不计入正式日结；正式文件到达后生成替换记录，不与临时值叠加。</span>
        </div>
      </template>
      <el-table :data="data.missing" size="small" border>
        <el-table-column label="门店" width="120">
          <template #default="{ row }"><b>{{ row.store }}</b> {{ row.storeName }}</template>
        </el-table-column>
        <el-table-column label="平台" width="100">
          <template #default="{ row }">{{ row.platform }}<div class="muted">{{ row.platformName }}</div></template>
        </el-table-column>
        <el-table-column prop="status" label="任务状态" width="120" show-overflow-tooltip />
        <el-table-column label="历史到数依据（近30天）" width="260">
          <template #default="{ row }">
            <div v-if="row.evidence">
              平均到数 <b>{{ row.evidence.avgArrival }}</b>
              · 延迟概率 <b>{{ row.evidence.delayRatePct }}%</b>
              <span class="muted">（{{ row.evidence.delayedDays }}/{{ row.evidence.sampleDays }} 天）</span>
            </div>
            <div class="muted" v-if="row.evidence">
              基准 {{ row.evidence.expectedArrival }} · P90 到数 {{ row.evidence.p90Arrival }}
              <span v-if="row.evidence.p90DelayMinutes !== null">· P90 延迟 {{ row.evidence.p90DelayMinutes }} 分钟</span>
            </div>
            <div class="muted" v-if="row.evidence && row.evidence.lastOfficialDate">
              最近正式日 {{ row.evidence.lastOfficialDate }}
              <span v-if="row.evidence.estimateVolatilityPct !== null">· 营业额波动 {{ row.evidence.estimateVolatilityPct }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="替代来源建议" min-width="380">
          <template #default="{ row }">
            <div v-for="m in row.methods" :key="m.method" class="sug-row">
              <el-popover placement="top" trigger="hover" :width="440">
                <template #reference>
                  <el-tag size="small" :type="methodTagType(m)" :effect="m.available ? 'plain' : 'info'">{{ m.label }}</el-tag>
                </template>
                <div class="pop-title">
                  <b>{{ m.label }}</b>
                  <el-tag v-if="!m.available" size="small" type="info">不可用</el-tag>
                  <el-tag v-else-if="m.recommended" size="small" type="success">建议采用</el-tag>
                  <el-tag v-else size="small" type="info" effect="plain">可暂用</el-tag>
                  <el-tag v-if="m.scope === 'store_total'" size="small" type="warning" effect="plain">全店口径</el-tag>
                </div>
                <p class="pop-reason">{{ m.reason }}</p>
                <p class="pop-caveat">注意：{{ m.caveat }}</p>
              </el-popover>
              <span v-if="m.method === 'prev_estimate'" class="no-mix">预估值 / 不混入日结</span>
              <el-button v-if="m.available && m.method !== 'manual_upload'" link type="primary" size="small" @click="adopt(row, m)">采用</el-button>
              <el-button v-if="m.available && m.method === 'manual_upload'" link type="primary" size="small" @click="goUpload(row)">去上传</el-button>
            </div>
            <div class="wait-hint" v-if="row.waitRecommended">建议先等待官方文件（见悬停依据）；业务急需时再采用替代来源。</div>
          </template>
        </el-table-column>
        <el-table-column label="当前替代数据" width="220">
          <template #default="{ row }">
            <div v-if="row.activeSubstitute">
              <el-tag size="small" type="warning">临时替代生效</el-tag>
              <span class="mono">{{ methodLabel(row.activeSubstitute.method) }}</span>
              <div class="muted">待正式文件到达后替换，不计入日结</div>
            </div>
            <div v-else-if="row.lastReplacedSubstitute">
              <el-tag size="small" type="success">已替换</el-tag>
              <span class="mono">{{ methodLabel(row.lastReplacedSubstitute.method) }}</span>
              <div class="muted">正式文件 {{ row.lastReplacedSubstitute.replaced_by_file_name || '' }} 已替换，未叠加</div>
            </div>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!data.missing || !data.missing.length" description="当日无缺报" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { CircleCheckFilled } from '@element-plus/icons-vue';
import { api, METHOD_LABELS, METRIC_LABELS, STATUS_META } from '../api';

const router = useRouter();
const today = new Date().toISOString().slice(0, 10);
const date = ref(today);
const data = ref<any>({ cells: [], missing: [], summary: null, date: '' });
const generating = ref(false);
let timer: any = null;

const platforms = computed(() => [...new Set((data.value.cells || []).map((c: any) => c.platform_code))]);
const matrixRows = computed(() => {
  const rows: Record<string, any> = {};
  for (const c of data.value.cells || []) {
    rows[c.store_code] = rows[c.store_code] || { store_code: c.store_code, store_name: c.store_name, kind: c.kind, cells: {} };
    rows[c.store_code].cells[c.platform_code] = c;
  }
  return Object.values(rows);
});

const statusLabel = (s: string) => STATUS_META[s]?.label || s;
const statusType = (s: string) => STATUS_META[s]?.type || 'info';
const methodLabel = (m: string) => METHOD_LABELS[m] || m;
const methodTagType = (m: any) => {
  if (!m.available) return 'info';
  if (m.recommended) return 'success';
  return m.method === 'prev_estimate' ? 'warning' : 'primary';
};

async function load() {
  const r = await api.get('/dashboard', { params: { date: date.value } });
  data.value = r.data;
}
async function generate() {
  generating.value = true;
  try {
    const r = await api.post('/tasks/generate', { date: date.value });
    ElMessage.success(`已生成并入队 ${r.data.enqueued} 个任务`);
    setTimeout(load, 800);
  } finally {
    generating.value = false;
  }
}
async function rerunWindow() {
  const from = new Date(new Date(date.value).getTime() - 2 * 86400000).toISOString().slice(0, 10);
  await ElMessageBox.confirm(`将重跑 ${from} ~ ${date.value} 的全部任务（含失败/待人工）`, '重跑窗口');
  const r = await api.post('/tasks/rerun-window', { from, to: date.value });
  ElMessage.success(`窗口 ${r.data.days} 天，入队 ${r.data.enqueued} 个任务`);
  setTimeout(load, 800);
}

function goUpload(row: any) {
  const accountId = (row.tasks || []).find((t: any) => t.accountId)?.accountId;
  router.push({
    path: '/upload',
    query: {
      storeId: String(row.storeId), platformId: String(row.platformId),
      accountId: accountId ? String(accountId) : '', bizDate: date.value, substitute: '1',
    },
  });
}

async function adopt(row: any, m: any) {
  if (m.method === 'prev_estimate') {
    const vals = m.estimatedValues || {};
    const valText = Object.entries(vals).slice(0, 4)
      .map(([k, v]) => `${METRIC_LABELS[k] || k} ${v}`).join('，') || '无历史指标';
    await ElMessageBox.confirm(
      `将采用「${m.label}」，依据最近正式日 ${m.basedOnDate} 的数据（${valText}）。\n\n预估值不得混入正式日结；正式文件到达后会生成替换记录，不会与临时值叠加。`,
      '采用替代来源', { type: 'warning', confirmButtonText: '采用临时预估' },
    );
    await api.post('/substitutions/adopt', {
      storeId: row.storeId, platformId: row.platformId, bizDate: date.value, method: 'prev_estimate',
    });
    ElMessage.success('已登记前一日预估（临时替代，不计入正式日结）');
    await load();
    return;
  }
  if (m.method === 'pos') {
    const { value } = await ElMessageBox.prompt(
      '请输入收银系统全店营业额（元）。收银系统为全店合计口径，不能按平台拆分，仅作临时参考、不得计入正式日结。',
      '采用收银系统数据',
      { inputPattern: /^\d+(\.\d+)?$/, inputErrorMessage: '请输入正数金额', confirmButtonText: '采用临时参考' },
    );
    await api.post('/substitutions/adopt', {
      storeId: row.storeId, platformId: row.platformId, bizDate: date.value,
      method: 'pos', values: { gross_sales: +value },
    });
    ElMessage.success('已登记收银系统全店口径参考（不计入正式日结）');
    await load();
  }
}

onMounted(() => {
  load();
  timer = setInterval(load, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.spacer { flex: 1; }
.summary .num { font-size: 24px; font-weight: 700; }
.summary .num.warn { color: #e6a23c; }
.summary .num.provisional { color: #f56c6c; }
.summary .lbl { color: #909399; font-size: 13px; }
.mt { margin-top: 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.muted { color: #909399; font-size: 12px; }
.cell-tag { margin: 2px 4px 2px 0; cursor: pointer; }
.files { font-size: 12px; color: #606266; margin-top: 2px; }
.files .miss { color: #f56c6c; }
.prov-tag { margin-left: 6px; }
.sug-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.no-mix { color: #f56c6c; font-size: 11px; }
.wait-hint { color: #e6a23c; font-size: 12px; margin-top: 4px; }
.pop-title { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.pop-reason { margin: 4px 0; font-size: 13px; line-height: 1.5; }
.pop-caveat { margin: 4px 0; font-size: 12px; color: #c45656; line-height: 1.5; }
.mono { font-family: monospace; font-size: 12px; }
</style>
