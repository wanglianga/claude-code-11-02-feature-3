import { one, q } from './db';

/** 人工上传的临时替代文件（meta.substitute=true） */
export function isSubstituteFile(file: any): boolean {
  return !!file?.meta?.substitute || file?.origin === 'substitute';
}

/**
 * 正式文件解析完成后记录真实到数时间，作为后续“历史到数节奏”依据。
 * 只记录非替代来源；替代文件不改变官方到数历史。
 */
export async function recordArrival(file: any) {
  if (isSubstituteFile(file) || file.status !== 'active') return;
  const arrivedAt = file.downloaded_at || new Date().toISOString();
  await q(
    `INSERT INTO arrival_history(store_id, platform_id, biz_date, expected_at, arrived_at, delay_minutes, was_delayed, source)
     SELECT $1, $2, $3::date,
            (p.expected_arrival + (s.arrival_offset_min || ' minutes')::interval)::time,
            $4::timestamptz,
            GREATEST(0, floor(extract(epoch from (
              $4::timestamptz - (($3::date + interval '1 day')::timestamp
                + (p.expected_arrival + (s.arrival_offset_min || ' minutes')::interval)::time)
            ) / 60)))::int,
            GREATEST(0, floor(extract(epoch from (
              $4::timestamptz - (($3::date + interval '1 day')::timestamp
                + (p.expected_arrival + (s.arrival_offset_min || ' minutes')::interval)::time)
            ) / 60)))::int > 30,
            'actual'
     FROM stores s JOIN platforms p ON p.id=$2
     WHERE s.id=$1
     ON CONFLICT (store_id, platform_id, biz_date) DO UPDATE SET
       arrived_at=EXCLUDED.arrived_at, delay_minutes=EXCLUDED.delay_minutes,
       was_delayed=EXCLUDED.was_delayed, source='actual'`,
    [file.store_id, file.platform_id, file.biz_date, arrivedAt],
  );
}

async function officialValuesFor(entry: any): Promise<Record<string, number>> {
  const rows = await q<{ metric: string; value: string }>(
    `SELECT metric, sum(value)::text AS value FROM daily_facts
     WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3
       AND ($4::int IS NULL OR account_id=$4)
     GROUP BY metric ORDER BY metric`,
    [entry.store_id, entry.platform_id, entry.biz_date, entry.account_id ?? null],
  );
  const values: Record<string, number> = {};
  for (const r of rows) values[r.metric] = +r.value;
  return values;
}

/**
 * 正式文件到达后：将仍在生效的临时替代标记 replaced，并写入替换记录。
 * 替代值从未写入 daily_facts，因此不会出现“两种来源相加”。
 */
export async function resolveSubstitutions(file: any) {
  if (isSubstituteFile(file) || file.status !== 'active') return;
  const entries = await q<any>(
    `SELECT * FROM substitute_entries
     WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3 AND status='active'`,
    [file.store_id, file.platform_id, file.biz_date],
  );
  if (!entries.length) return;

  for (const entry of entries) {
    if (entry.account_id) {
      // 账号级替代：只由该账号的正式文件替换
      if (entry.account_id !== file.account_id) continue;
    } else {
      // 平台级替代：须该门店×平台全部启用账号都有正式文件，避免用部分账号替换整体
      const official = await one<{ c: number }>(
        `SELECT count(*)::int c FROM collected_files
         WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3 AND status='active'
           AND COALESCE(meta->>'substitute','false') <> 'true'`,
        [entry.store_id, entry.platform_id, entry.biz_date],
      );
      const accounts = await one<{ c: number }>(
        `SELECT count(*)::int c FROM platform_accounts
         WHERE store_id=$1 AND platform_id=$2 AND status <> 'disabled'`,
        [entry.store_id, entry.platform_id],
      );
      if ((official?.c ?? 0) < (accounts?.c ?? 1)) continue;
    }

    const officialValues = await officialValuesFor(entry);
    await q(
      `UPDATE substitute_entries SET status='replaced', replaced_at=now(),
         replaced_by_file_id=$2, replaced_by_values=$3
       WHERE id=$1 AND status='active'`,
      [entry.id, file.id, JSON.stringify(officialValues)],
    );
    await q(
      `INSERT INTO substitution_replacements(entry_id, store_id, platform_id, account_id, biz_date,
         method, provisional_values, official_values, replaced_by_file_id, note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.id, entry.store_id, entry.platform_id, entry.account_id, entry.biz_date, entry.method,
       JSON.stringify(entry.values), JSON.stringify(officialValues), file.id,
       '正式文件到达：替换临时替代值，不叠加两种来源'],
    );
  }
}
