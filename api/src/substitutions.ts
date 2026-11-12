import { one, q } from './db';

export const METHOD_LABELS: Record<string, string> = {
  manual_upload: '人工上传平台报表',
  pos: '收银系统',
  prev_estimate: '前一日预估',
};

export interface ArrivalStats {
  sampleDays: number;
  avgArrivalMinutes: number | null;
  avgArrival: string;
  p90ArrivalMinutes: number | null;
  p90Arrival: string;
  p90DelayMinutes: number | null;
  avgDelayMinutes: number | null;
  delayRate: number;       // 0..1
  delayRatePct: number;    // 0..100
  delayedDays: number;
}

function minutesLabel(minutes: number | null): string {
  if (minutes === null || Number.isNaN(minutes)) return '未知';
  const rounded = Math.round(minutes);
  if (rounded < 0) return '早于基准';
  if (rounded >= 1440) return `次日 ${pad(Math.floor((rounded % 1440) / 60))}:${pad(rounded % 60)}`;
  return `${pad(Math.floor(rounded / 60))}:${pad(rounded % 60)}`;
}
function pad(n: number) { return String(n).padStart(2, '0'); }

/** 近30天（不含目标营业日）到数节奏；真实采集完成后也会写入同一张历史表。 */
export async function arrivalStats(storeId: number, platformId: number, date: string): Promise<ArrivalStats> {
  const row = await one<any>(
    `SELECT count(*)::int AS sample_days,
            avg(extract(epoch from arrived_at - biz_date::timestamp) / 60)::float AS avg_minutes,
            percentile_cont(0.9) WITHIN GROUP (
              ORDER BY extract(epoch from arrived_at - biz_date::timestamp) / 60
            )::float AS p90_minutes,
            avg(CASE WHEN was_delayed THEN 1 ELSE 0 END)::float AS delay_rate,
            avg(delay_minutes)::float AS avg_delay_minutes,
            count(*) FILTER (WHERE was_delayed)::int AS delayed_days,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY delay_minutes)::float AS p90_delay
     FROM arrival_history
     WHERE store_id=$1 AND platform_id=$2
       AND biz_date >= ($3::date - interval '30 days') AND biz_date < $3::date`,
    [storeId, platformId, date],
  );
  const sampleDays = row?.sample_days ?? 0;
  const delayRate = sampleDays ? +row.delay_rate : 0;
  return {
    sampleDays,
    avgArrivalMinutes: row?.avg_minutes ?? null,
    avgArrival: minutesLabel(row?.avg_minutes),
    p90ArrivalMinutes: row?.p90_minutes ?? null,
    p90Arrival: minutesLabel(row?.p90_minutes),
    p90DelayMinutes: row?.p90_delay === null || row?.p90_delay === undefined ? null : Math.round(+row.p90_delay),
    avgDelayMinutes: row?.avg_delay_minutes === null || row?.avg_delay_minutes === undefined ? null : Math.round(+row.avg_delay_minutes),
    delayRate,
    delayRatePct: Math.round(delayRate * 100),
    delayedDays: row?.delayed_days ?? 0,
  };
}

/** 目标营业日之前最近一次正式日结的聚合值（跨账号汇总）。 */
export async function lastOfficialValues(storeId: number, platformId: number, date: string) {
  const last = await one<{ biz_date: string }>(
    `SELECT max(biz_date)::text AS biz_date FROM daily_facts
     WHERE store_id=$1 AND platform_id=$2 AND biz_date < $3::date`,
    [storeId, platformId, date],
  );
  if (!last?.biz_date) return null;
  const rows = await q<{ metric: string; value: string }>(
    `SELECT metric, sum(value)::text AS value FROM daily_facts
     WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3
     GROUP BY metric ORDER BY metric`,
    [storeId, platformId, last.biz_date],
  );
  const values: Record<string, number> = {};
  for (const r of rows) values[r.metric] = +r.value;
  return { date: last.biz_date, values };
}

/** 近30天正式营业额波动率（用于判断前一日预估是否可靠）。 */
export async function estimateVolatility(storeId: number, platformId: number, date: string) {
  const row = await one<any>(
    `SELECT count(*)::int AS days, avg(v)::float AS mean, stddev_samp(v)::float AS sd
     FROM (
       SELECT biz_date, sum(value)::float AS v FROM daily_facts
       WHERE store_id=$1 AND platform_id=$2 AND metric='gross_sales'
         AND biz_date >= ($3::date - interval '30 days') AND biz_date < $3::date
       GROUP BY biz_date
     ) x`,
    [storeId, platformId, date],
  );
  const days = row?.days ?? 0;
  const mean = row?.mean ?? null;
  const sd = days >= 2 ? row?.sd ?? null : null;
  const cv = sd !== null && mean !== null && mean > 0 ? sd / mean : null;
  return { days, mean, sd, cv };
}

interface SuggestionInput {
  storeId: number;
  platformId: number;
  platformCode: string;
  platformName: string;
  storeCode: string;
  storeKind: string;
  posSystem: string | null;
  expectedArrival: string;
  arrivalOffsetMin: number;
  date: string;
  taskStatuses: string[];
  now?: Date;
}

/** 生成三类替代来源建议：人工上传、收银系统、前一日预估。 */
export async function buildSuggestions(input: SuggestionInput) {
  const stats = await arrivalStats(input.storeId, input.platformId, input.date);
  const last = await lastOfficialValues(input.storeId, input.platformId, input.date);
  const vol = await estimateVolatility(input.storeId, input.platformId, input.date);
  const now = input.now ?? new Date();

  const today = now.toISOString().slice(0, 10);
  const expectedHm = (input.expectedArrival || '09:00').slice(0, 5);
  // 平台日结一般在营业日次日到达；基准时间按“次日 HH:MM”计算
  const expectedMinutes = 1440 + +expectedHm.slice(0, 2) * 60 + +expectedHm.slice(3, 5) + (input.arrivalOffsetMin || 0);
  const expectedLabel = minutesLabel(expectedMinutes);
  const expectedDateTime = new Date(`${input.date}T${expectedHm}:00Z`);
  expectedDateTime.setUTCDate(expectedDateTime.getUTCDate() + 1);
  expectedDateTime.setUTCMinutes(expectedDateTime.getUTCMinutes() + (input.arrivalOffsetMin || 0));

  const isPast = input.date < today;
  const isAutoBlocked = input.taskStatuses.some((s) => s === 'failed' || s === 'waiting_human');
  const isAutoActive = input.taskStatuses.some((s) => s === 'queued' || s === 'running');
  const overdueByClock = now.getTime() > expectedDateTime.getTime();
  const overdue = isPast || isAutoBlocked || overdueByClock;
  const waitRecommended = !overdue && isAutoActive;

  const evidence = {
    sampleDays: stats.sampleDays,
    avgArrival: stats.avgArrival,
    avgArrivalMinutes: stats.avgArrivalMinutes,
    p90Arrival: stats.p90Arrival,
    p90ArrivalMinutes: stats.p90ArrivalMinutes,
    delayRate: stats.delayRate,
    delayRatePct: stats.delayRatePct,
    delayedDays: stats.delayedDays,
    p90DelayMinutes: stats.p90DelayMinutes,
    avgDelayMinutes: stats.avgDelayMinutes,
    expectedArrival: expectedLabel,
    lastOfficialDate: last?.date ?? null,
    lastOfficialValues: last?.values ?? null,
    estimateVolatilityDays: vol.days,
    estimateVolatilityPct: vol.cv === null ? null : Math.round(vol.cv * 100),
    overdue,
    waitRecommended,
  };

  const cadence = stats.sampleDays
    ? `该门店该平台近30天平均到数 ${stats.avgArrival}（P90 ${stats.p90Arrival}），延迟概率 ${stats.delayRatePct}%（${stats.delayedDays}/${stats.sampleDays} 天）`
    : '该门店该平台近30天历史到数样本不足';
  const timing = isPast
    ? '目标营业日已过去且仍无正式文件，属于已延迟'
    : isAutoBlocked
      ? '自动采集已失败/等待人工，短期内无法自动拿到正式文件'
      : overdueByClock
        ? `当前已超过该门店历史到数窗口（基准 ${expectedLabel}）`
        : `当前仍在历史到数窗口内（基准 ${expectedLabel}）`;

  const methods: any[] = [];

  methods.push({
    method: 'manual_upload',
    label: METHOD_LABELS.manual_upload,
    available: true,
    recommended: overdue,
    scope: 'platform',
    reason: `${cadence}；${timing}。人工上传平台原始报表可保留门店/平台/账号口径，是优先替代方式。`,
    caveat: '临时替代来源；正式文件到达后自动生成替换记录，不会与原数据叠加。',
  });

  const posAvailable = !!input.posSystem;
  methods.push({
    method: 'pos',
    label: METHOD_LABELS.pos,
    available: posAvailable,
    recommended: overdue && posAvailable,
    scope: 'store_total',
    reason: posAvailable
      ? `${cadence}；门店已接入「${input.posSystem}」，可导出全店营业额作为总量参考。${timing}。`
      : `${input.storeCode} 为${input.storeKind === 'franchise' ? '加盟' : '直营'}门店，未接入可导出的收银系统，故不可采用收银系统替代。`,
    caveat: '收银系统为全店合计口径，无法按平台拆分，仅作临时参考，不得计入正式日结。',
  });

  const estimateAvailable = !!last;
  const cv = vol.cv;
  const estimateStable = cv !== null && cv <= 0.35;
  methods.push({
    method: 'prev_estimate',
    label: METHOD_LABELS.prev_estimate,
    available: estimateAvailable,
    recommended: overdue && estimateAvailable && (cv === null || estimateStable),
    scope: 'platform',
    reason: estimateAvailable
      ? `${cadence}；可参考最近正式日 ${last!.date} 的同平台数据（营业额 ${last!.values.gross_sales ?? '-'} 元）作前一日预估。近30天营业额波动率 ${cv === null ? '样本不足' : Math.round(cv * 100) + '%'}（${vol.days} 个样本），${cv === null ? '样本不足，仅供业务参考' : estimateStable ? '波动较低，可作临时参考' : '波动较大，不建议作为替代'}。`
      : '该门店该平台没有更早的正式日结数据，无法生成前一日预估。',
    caveat: '预估值不得混入正式日结，仅供缺口提示/业务参考；正式文件到达后必须生成替换记录，不得与原数据叠加。',
    estimatedValues: last?.values ?? null,
    basedOnDate: last?.date ?? null,
  });

  const recommendedOrder = methods
    .filter((m) => m.available && m.recommended)
    .map((m) => m.method);
  const recommendedMethod = recommendedOrder.includes('manual_upload')
    ? 'manual_upload'
    : recommendedOrder[0] ?? null;
  const waitReason = waitRecommended
    ? `${cadence}；${timing}。建议先等待官方文件，避免临时数据污染日结；如业务急需，可采用替代来源（预估值不得混入正式日结）。`
    : null;

  return {
    evidence,
    methods,
    waitRecommended,
    waitReason,
    recommendedMethod,
    recommendation: overdue
      ? `已超过历史到数节奏（平均 ${stats.avgArrival}，延迟概率 ${stats.delayRatePct}%），建议采用替代来源并明确标记。`
      : `尚未超过历史到数节奏（平均 ${stats.avgArrival}，延迟概率 ${stats.delayRatePct}%），建议优先等待官方文件。`,
  };
}

/** 读取门店×平台上下文（含平台到数基准与门店收银能力）。 */
export async function suggestionContext(storeId: number, platformId: number) {
  return one<any>(
    `SELECT s.id AS store_id, s.code AS store_code, s.kind AS store_kind, s.pos_system,
            p.id AS platform_id, p.code AS platform_code, p.name AS platform_name,
            p.expected_arrival::text AS expected_arrival,
            COALESCE(s.arrival_offset_min, 0) AS arrival_offset_min
     FROM stores s JOIN platforms p ON p.id=$2 WHERE s.id=$1`,
    [storeId, platformId],
  );
}
