<template>
  <div>
    <div class="toolbar">
      <el-select v-model="storeId" placeholder="门店" style="width: 180px" @change="load">
        <el-option v-for="s in meta.stores" :key="s.id" :label="`${s.code} ${s.name}`" :value="s.id" />
      </el-select>
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="load" />
    </div>

    <el-card v-if="data.store">
      <template #header>
        <div class="card-head">
          <span>{{ data.store.code }} {{ data.store.name }} · {{ data.date }} 经营事实（可溯源）</span>
          <span class="muted">下表仅含正式来源；临时替代/预估见下方独立区块，不计入正式日结。</span>
        </div>
      </template>
      <el-table :data="factRows" size="small" border>
        <el-table-column label="指标" width="160">
          <template #default="{ row }">{{ METRIC_LABELS[row.metric] || row.metric }}</template>
        </el-table-column>
        <el-table-column label="全店合计" width="120">
          <template #default="{ row }"><b>{{ row.total }}</b></template>
        </el-table-column>
        <el-table-column label="来源明细（平台 / 账号 / 原始文件 / 解析版本）">
          <template #default="{ row }">
            <div v-for="(s, i) in row.sources" :key="i" class="src">
              <el-tag size="small">{{ s.platform_code }}</el-tag>
              <span class="mono">{{ s.username }}</span>
              <el-tag size="small" :type="s.origin === 'manual' ? 'warning' : 'info'" effect="plain">{{ s.origin === 'manual' ? '人工' : '自动' }}</el-tag>
              <span>= {{ s.value }}</span>
              <el-tooltip :content="`SHA256 ${s.sha256 || '-'} · 修订r${s.file_revision || '-'} · ${s.parser_version || '-'}/${s.mapping_version || '-'}`">
                <el-link v-if="s.file_id" type="primary" class="mono" @click="downloadEvidence(s.file_id, s.file_name)">
                  {{ s.file_name }}
                </el-link>
                <span v-else>-</span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="mt" v-if="data.substitutions && data.substitutions.length">
      <template #header>
        <div class="card-head">
          <span>临时替代数据（来源已标记，不计入正式日结）</span>
          <el-tag type="warning" effect="plain">预估值不得混入正式日结</el-tag>
        </div>
      </template>
      <el-table :data="data.substitutions" size="small" border>
        <el-table-column prop="platform_code" label="平台" width="90" />
        <el-table-column label="替代方式" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="methodTag(row.method)">{{ methodLabel(row.method) }}</el-tag>
            <el-tag v-if="row.scope === 'store_total'" size="small" type="warning" effect="plain">全店口径</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="临时值（来源标记）" min-width="240">
          <template #default="{ row }"><span class="mono">{{ valuesText(row.values) }}</span></template>
        </el-table-column>
        <el-table-column label="依据" min-width="220">
          <template #default="{ row }">
            <div v-if="row.based_on_date">最近正式日 {{ row.based_on_date }}</div>
            <div v-if="row.evidence && row.evidence.avgArrival" class="muted">
              近30天平均到数 {{ row.evidence.avgArrival }} · 延迟概率 {{ row.evidence.delayRatePct }}%
            </div>
            <div v-if="row.file_name" class="muted">文件 {{ row.file_name }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="160">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'replaced' ? 'success' : row.status === 'active' ? 'warning' : 'info'">
              {{ subStatusLabel(row.status) }}
            </el-tag>
            <div v-if="row.replaced_by_file_name" class="muted">正式文件 {{ row.replaced_by_file_name }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="mt" v-if="data.replacements && data.replacements.length">
      <template #header>替换记录（正式文件到达后替换临时来源，不叠加）</template>
      <el-table :data="data.replacements" size="small" border>
        <el-table-column prop="platform_code" label="平台" width="90" />
        <el-table-column label="替代方式" width="150">
          <template #default="{ row }">{{ methodLabel(row.method) }}</template>
        </el-table-column>
        <el-table-column label="被替换的临时值" min-width="220">
          <template #default="{ row }"><span class="mono">{{ valuesText(row.provisional_values) }}</span></template>
        </el-table-column>
        <el-table-column label="正式文件值" min-width="220">
          <template #default="{ row }"><span class="mono">{{ valuesText(row.official_values) }}</span></template>
        </el-table-column>
        <el-table-column label="替换依据" min-width="180">
          <template #default="{ row }">
            <div>{{ row.replaced_by_file_name || row.replaced_by_file_id || '-' }}</div>
            <div class="muted">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="时间" width="180" />
      </el-table>
    </el-card>

    <el-card class="mt" v-if="data.files">
      <template #header>当日文件证据</template>
      <el-table :data="data.files" size="small" border>
        <el-table-column prop="platform_code" label="平台" width="80" />
        <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
        <el-table-column label="哈希" width="100">
          <template #default="{ row }"><code>{{ row.sha256.slice(0, 10) }}</code></template>
        </el-table-column>
        <el-table-column prop="revision" label="修订" width="60" />
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.meta && row.meta.substitute" size="small" type="warning" effect="plain">临时替代</el-tag>
            <el-tag v-else size="small" :type="row.origin === 'manual' ? 'warning' : 'info'">{{ row.origin === 'manual' ? '人工' : '自动' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ { active: '有效', superseded: '已被取代', rejected: '错误文件', ignored_manual: '人工优先' }[row.status] || row.status }}</template>
        </el-table-column>
        <el-table-column label="解析" width="200">
          <template #default="{ row }">
            <span v-if="row.last_batch">{{ row.last_batch.status }} · 行{{ row.last_batch.rows_parsed }}/{{ row.last_batch.rows_total }} · {{ row.last_batch.parser_version }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="downloadEvidence(row.id, row.file_name)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, METRIC_LABELS, METHOD_LABELS, SUB_STATUS_LABELS, downloadEvidence } from '../api';

const meta = ref<any>({ stores: [] });
const storeId = ref<number>();
const date = ref(new Date().toISOString().slice(0, 10));
const data = ref<any>({});

const factRows = computed(() => {
  const byMetric: Record<string, any> = {};
  for (const f of data.value.facts || []) {
    byMetric[f.metric] = byMetric[f.metric] || { metric: f.metric, total: 0, sources: [] };
    byMetric[f.metric].total = Math.round((byMetric[f.metric].total + +f.value) * 100) / 100;
    byMetric[f.metric].sources.push(f);
  }
  return Object.values(byMetric);
});

const methodLabel = (m: string) => METHOD_LABELS[m] || m;
const methodTag = (m: string) => ({ manual_upload: 'primary', pos: 'warning', prev_estimate: 'danger' }[m] || 'info');
const subStatusLabel = (s: string) => SUB_STATUS_LABELS[s] || s;
const valuesText = (v: any) => {
  if (!v) return '-';
  const entries = Object.entries(v);
  if (!entries.length) return '-';
  return entries.map(([k, val]) => `${METRIC_LABELS[k] || k} ${val}`).join('，');
};

async function load() {
  if (!storeId.value) return;
  data.value = (await api.get(`/stores/${storeId.value}/daily`, { params: { date: date.value } })).data;
}
onMounted(async () => {
  meta.value = (await api.get('/meta')).data;
  storeId.value = meta.value.stores[0]?.id;
  await load();
});
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; margin-bottom: 12px; }
.mt { margin-top: 12px; }
.src { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.mono { font-family: monospace; font-size: 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.muted { color: #909399; font-size: 12px; }
</style>
