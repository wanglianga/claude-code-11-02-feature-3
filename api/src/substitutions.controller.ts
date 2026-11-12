import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { one, q } from './db';
import {
  arrivalStats, buildSuggestions, estimateVolatility, lastOfficialValues,
  METHOD_LABELS, suggestionContext,
} from './substitutions';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

@Controller('substitutions')
export class SubstitutionsController {
  /** 缺口建议详情：历史到数节奏 + 三类替代来源的可用性/理由/注意事项 */
  @Get('suggest')
  async suggest(@Query() query: any) {
    const storeId = +query.storeId;
    const platformId = +query.platformId;
    const date = query.date;
    if (!storeId || !platformId || !dateRe.test(date || '')) {
      throw new BadRequestException('storeId/platformId/date 必填');
    }
    const ctx = await suggestionContext(storeId, platformId);
    if (!ctx) throw new NotFoundException('门店或平台不存在');
    const tasks = await q<{ status: string }>(
      `SELECT status FROM source_tasks WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3`,
      [storeId, platformId, date],
    );
    const suggestions = await buildSuggestions({
      storeId, platformId,
      platformCode: ctx.platform_code, platformName: ctx.platform_name,
      storeCode: ctx.store_code, storeKind: ctx.store_kind, posSystem: ctx.pos_system,
      expectedArrival: ctx.expected_arrival, arrivalOffsetMin: ctx.arrival_offset_min,
      date, taskStatuses: tasks.map((t) => t.status),
    });
    const active = await one(
      `SELECT * FROM substitute_entries WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3 AND status='active'
       ORDER BY created_at DESC LIMIT 1`, [storeId, platformId, date]);
    return { storeId, platformId, date, context: ctx, ...suggestions, activeSubstitute: active };
  }

  /** 替代来源记录（默认全部，可按日期/门店/平台/状态过滤） */
  @Get()
  async list(@Query() query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.date) { params.push(query.date); cond.push(`e.biz_date=$${params.length}`); }
    if (query.storeId) { params.push(+query.storeId); cond.push(`e.store_id=$${params.length}`); }
    if (query.platformId) { params.push(+query.platformId); cond.push(`e.platform_id=$${params.length}`); }
    if (query.status) { params.push(query.status); cond.push(`e.status=$${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return q(
      `SELECT e.*, e.biz_date::text, e.based_on_date::text AS based_on_date,
              e.replaced_at::text AS replaced_at,
              s.code AS store_code, p.code AS platform_code, p.name AS platform_name,
              a.username, cf.file_name, rcf.file_name AS replaced_by_file_name
       FROM substitute_entries e
       JOIN stores s ON s.id=e.store_id JOIN platforms p ON p.id=e.platform_id
       LEFT JOIN platform_accounts a ON a.id=e.account_id
       LEFT JOIN collected_files cf ON cf.id=e.file_id
       LEFT JOIN collected_files rcf ON rcf.id=e.replaced_by_file_id
       ${where} ORDER BY e.created_at DESC LIMIT 300`, params);
  }

  /** 替换记录：正式文件到达后，替代值被替换（不是相加） */
  @Get('replacements')
  async replacements(@Query() query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.date) { params.push(query.date); cond.push(`r.biz_date=$${params.length}`); }
    if (query.storeId) { params.push(+query.storeId); cond.push(`r.store_id=$${params.length}`); }
    if (query.platformId) { params.push(+query.platformId); cond.push(`r.platform_id=$${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return q(
      `SELECT r.*, r.biz_date::text, s.code AS store_code, p.code AS platform_code,
              cf.file_name AS replaced_by_file_name
       FROM substitution_replacements r
       JOIN stores s ON s.id=r.store_id JOIN platforms p ON p.id=r.platform_id
       LEFT JOIN collected_files cf ON cf.id=r.replaced_by_file_id
       ${where} ORDER BY r.created_at DESC LIMIT 300`, params);
  }

  /**
   * 采用替代来源（收银系统 / 前一日预估）。人工上传走 POST /files/upload 并带 substitute=1。
   * 替代数据写入 substitute_entries，不写 daily_facts，因此不会混入正式日结。
   */
  @Post('adopt')
  async adopt(@Body() body: any) {
    const storeId = +body?.storeId;
    const platformId = +body?.platformId;
    const date = body?.bizDate;
    const method = body?.method;
    if (!storeId || !platformId || !dateRe.test(date || '')) {
      throw new BadRequestException('storeId/platformId/bizDate 必填');
    }
    if (method === 'manual_upload') {
      throw new BadRequestException('人工上传请使用 POST /files/upload 并携带 substitute=1');
    }
    if (!['pos', 'prev_estimate'].includes(method)) {
      throw new BadRequestException('method 仅支持 pos / prev_estimate（人工上传走文件上传接口）');
    }
    const ctx = await suggestionContext(storeId, platformId);
    if (!ctx) throw new NotFoundException('门店或平台不存在');
    const official = await one(
      `SELECT 1 FROM collected_files
       WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3 AND status='active'
         AND COALESCE(meta->>'substitute','false') <> 'true' LIMIT 1`,
      [storeId, platformId, date],
    );
    if (official) {
      throw new BadRequestException('该门店×平台当日已有正式文件，不能再采用临时替代来源');
    }
    const tasks = await q<{ status: string }>(
      `SELECT status FROM source_tasks WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3`,
      [storeId, platformId, date],
    );
    const suggestion = await buildSuggestions({
      storeId, platformId,
      platformCode: ctx.platform_code, platformName: ctx.platform_name,
      storeCode: ctx.store_code, storeKind: ctx.store_kind, posSystem: ctx.pos_system,
      expectedArrival: ctx.expected_arrival, arrivalOffsetMin: ctx.arrival_offset_min,
      date, taskStatuses: tasks.map((t) => t.status),
    });

    let values: Record<string, number>;
    let scope = 'platform';
    let basedOnDate: string | null = null;

    if (method === 'pos') {
      if (!ctx.pos_system) {
        throw new BadRequestException(`${ctx.store_code} 未接入可导出的收银系统，无法采用收银系统替代`);
      }
      scope = 'store_total';
      const sales = +(body?.values?.gross_sales);
      if (!sales || sales <= 0) throw new BadRequestException('values.gross_sales 必须为正数（全店营业额）');
      values = { gross_sales: sales };
      if (body?.values?.orders && +body.values.orders > 0) values.orders = +body.values.orders;
    } else {
      const last = await lastOfficialValues(storeId, platformId, date);
      if (!last) throw new BadRequestException('没有更早的正式日结数据，无法生成前一日预估');
      values = last.values;
      basedOnDate = last.date;
    }

    const stats = await arrivalStats(storeId, platformId, date);
    const vol = await estimateVolatility(storeId, platformId, date);
    const evidence = {
      ...suggestion.evidence,
      snapshot: {
        method,
        sampleDays: stats.sampleDays,
        avgArrival: stats.avgArrival,
        delayRatePct: stats.delayRatePct,
        p90DelayMinutes: stats.p90DelayMinutes,
        basedOnDate,
        estimateVolatilityPct: vol.cv === null ? null : Math.round(vol.cv * 100),
        platformCode: ctx.platform_code,
        storeCode: ctx.store_code,
      },
    };

    await q(
      `UPDATE substitute_entries SET status='cancelled'
       WHERE store_id=$1 AND platform_id=$2 AND biz_date=$3 AND status='active'`,
      [storeId, platformId, date],
    );
    const inserted = await one<any>(
      `INSERT INTO substitute_entries(store_id, platform_id, account_id, biz_date, method, scope,
         values, based_on_date, evidence, status, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10) RETURNING id`,
      [storeId, platformId, body?.accountId ?? null, date, method, scope,
       JSON.stringify(values), basedOnDate, JSON.stringify(evidence), body?.createdBy || 'ops'],
    );
    const row = await one<any>(
      `SELECT e.*, e.biz_date::text, e.based_on_date::text AS based_on_date, e.replaced_at::text AS replaced_at
       FROM substitute_entries e WHERE e.id=$1`, [inserted!.id]);
    return {
      ok: true,
      entry: row,
      methodLabel: METHOD_LABELS[method],
      notice: method === 'prev_estimate'
        ? '前一日预估已登记为临时替代来源，不会混入正式日结；正式文件到达后自动生成替换记录。'
        : '收银系统全店口径已登记为临时参考，不会按平台拆分、不会混入正式日结。',
    };
  }

  /** 取消尚未被正式文件替换的临时替代 */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const row = await one(`SELECT * FROM substitute_entries WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException();
    await q(`UPDATE substitute_entries SET status='cancelled' WHERE id=$1 AND status='active'`, [id]);
    return { ok: true };
  }
}
