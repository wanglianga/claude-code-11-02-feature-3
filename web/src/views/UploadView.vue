<template>
  <el-card style="max-width: 680px">
    <template #header>
      {{ form.substitute ? '临时替代上传（不计入正式日结）' : '人工补传（覆盖同一门店×平台×账号×日期的自动数据）' }}
    </template>
    <el-alert v-if="form.substitute" type="warning" :closable="false" class="mb"
      title="临时替代来源：数据只登记为替代记录，不写入正式日结；正式文件到达后自动生成替换记录，两种来源不会叠加。"
      description="若这只是对正式数据的永久人工修正，请不要使用临时替代模式。" />
    <el-form label-width="90px">
      <el-form-item label="门店">
        <el-select v-model="form.storeId" style="width: 100%" @change="filterAccounts">
          <el-option v-for="s in meta.stores" :key="s.id" :label="`${s.code} ${s.name}`" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="平台">
        <el-select v-model="form.platformId" style="width: 100%" @change="filterAccounts">
          <el-option v-for="p in meta.platforms" :key="p.id" :label="`${p.code} ${p.name}`" :value="p.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="账号">
        <el-select v-model="form.accountId" style="width: 100%">
          <el-option v-for="a in accountOptions" :key="a.id" :label="a.username" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="营业日">
        <el-date-picker v-model="form.bizDate" type="date" value-format="YYYY-MM-DD" :clearable="false" />
      </el-form-item>
      <el-form-item label="报表文件">
        <input type="file" @change="onFile" />
      </el-form-item>
      <el-form-item label="来源模式">
        <el-checkbox v-model="form.substitute" :disabled="fromDashboard">临时替代（不混入正式日结）</el-checkbox>
        <div class="muted" v-if="fromDashboard">由缺报看板「人工上传」入口带入，正式文件到达后自动替换。</div>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="uploading" @click="submit">
          {{ form.substitute ? '上传并登记临时替代' : '上传并解析' }}
        </el-button>
        <el-button @click="goBack">返回看板</el-button>
      </el-form-item>
    </el-form>
    <el-alert v-if="result" :type="result.substitute ? 'warning' : 'success'" :closable="false"
      :title="result.substitute
        ? `已登记临时替代 fileId=${result.fileId}，来源标记为「人工上传」，不计入正式日结；正式文件到达后生成替换记录`
        : `已登记 fileId=${result.fileId}，修订 r${result.revision}，覆盖 ${result.superseded.length} 份旧文件，解析已入队`" />
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const meta = ref<any>({ stores: [], platforms: [], accounts: [] });
const form = reactive<any>({
  storeId: null, platformId: null, accountId: null, bizDate: new Date().toISOString().slice(0, 10),
  substitute: false,
});
const fromDashboard = ref(false);
const file = ref<File | null>(null);
const uploading = ref(false);
const result = ref<any>(null);

const accountOptions = computed(() =>
  meta.value.accounts.filter((a: any) => a.store_id === form.storeId && a.platform_id === form.platformId),
);
function filterAccounts() {
  form.accountId = accountOptions.value[0]?.id ?? null;
}
function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] || null;
}
function goBack() {
  router.push('/');
}
async function submit() {
  if (!file.value || !form.accountId) {
    ElMessage.warning('请选择账号与文件');
    return;
  }
  uploading.value = true;
  result.value = null;
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    fd.append('storeId', String(form.storeId));
    fd.append('platformId', String(form.platformId));
    fd.append('accountId', String(form.accountId));
    fd.append('bizDate', form.bizDate);
    if (form.substitute) fd.append('substitute', '1');
    result.value = (await api.post('/files/upload', fd)).data;
    ElMessage.success(form.substitute ? '临时替代已登记（不计入正式日结）' : '上传成功，解析已入队');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}
onMounted(async () => {
  meta.value = (await api.get('/meta')).data;
  const q = route.query;
  form.storeId = q.storeId ? +q.storeId : meta.value.stores[0]?.id;
  form.platformId = q.platformId ? +q.platformId : meta.value.platforms[0]?.id;
  form.bizDate = q.bizDate ? String(q.bizDate) : form.bizDate;
  form.substitute = String(q.substitute || '') === '1';
  fromDashboard.value = form.substitute && !!q.storeId;
  const wantedAccount = q.accountId ? +q.accountId : null;
  filterAccounts();
  if (wantedAccount && accountOptions.value.some((a: any) => a.id === wantedAccount)) form.accountId = wantedAccount;
});
</script>

<style scoped>
.mb { margin-bottom: 12px; }
.muted { color: #909399; font-size: 12px; }
</style>
