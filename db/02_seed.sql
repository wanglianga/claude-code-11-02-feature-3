-- 种子数据：门店 / 平台 / 账号（与 mock-platform 内置账号一一对应）
INSERT INTO stores (code, name, kind) VALUES
  ('S001', '直营一店', 'direct'),
  ('S002', '直营二店', 'direct'),
  ('S003', '加盟三店', 'franchise'),
  ('S004', '加盟四店', 'franchise')
ON CONFLICT (code) DO NOTHING;

INSERT INTO platforms (code, name, source_kind, day_cutoff) VALUES
  ('ALPHA', '星团外卖',   'web_export',      '02:00'),
  ('BETA',  '蓝雀到家',   'download_center', '00:00'),
  ('GAMMA', '星火开放平台', 'api',            '00:00')
ON CONFLICT (code) DO NOTHING;

-- S003 在 ALPHA 有两个账号，用于验证“同一门店多账号”
INSERT INTO platform_accounts (platform_id, store_id, username, password, api_token)
SELECT p.id, s.id, a.username, 'pass123', a.token
FROM platforms p
JOIN stores s ON TRUE
JOIN (VALUES
  ('ALPHA','S001','s001', NULL::text),
  ('ALPHA','S002','s002', NULL),
  ('ALPHA','S003','s003a',NULL),
  ('ALPHA','S003','s003b',NULL),
  ('ALPHA','S004','s004', NULL),
  ('BETA', 'S001','s001b',NULL),
  ('BETA', 'S002','s002b',NULL),
  ('BETA', 'S003','s003b',NULL),
  ('BETA', 'S004','s004b',NULL),
  ('GAMMA','S001','s001g','g-token-s001'),
  ('GAMMA','S002','s002g','g-token-s002'),
  ('GAMMA','S003','s003g','g-token-s003'),
  ('GAMMA','S004','s004g','g-token-s004')
) AS a(platform_code, store_code, username, token)
  ON a.platform_code = p.code AND a.store_code = s.code
ON CONFLICT (platform_id, store_id, username) DO NOTHING;

-- 平台基准到数时间（历史到数节奏的基准，门店偏移见 stores.arrival_offset_min）
UPDATE platforms SET expected_arrival = CASE code
  WHEN 'ALPHA' THEN TIME '08:30'
  WHEN 'BETA'  THEN TIME '09:15'
  WHEN 'GAMMA' THEN TIME '07:45'
  ELSE expected_arrival END;

-- 门店收银系统可用性（直营接入可导出；加盟店自有收银无法导出）
UPDATE stores SET
  pos_system = CASE code WHEN 'S001' THEN '海鼎POS' WHEN 'S002' THEN '思迅POS' ELSE NULL END,
  arrival_offset_min = CASE code WHEN 'S001' THEN 0 WHEN 'S002' THEN 10 WHEN 'S003' THEN 25 ELSE 5 END;

-- 近30天到数历史（确定性种子）：用于“平均到数时间 / 延迟概率 / P90 延迟”建议依据
INSERT INTO arrival_history(store_id, platform_id, biz_date, expected_at, arrived_at, delay_minutes, was_delayed, source)
SELECT s.id, p.id, (CURRENT_DATE - g)::date,
       (p.expected_arrival + (s.arrival_offset_min || ' minutes')::interval)::time,
       ((CURRENT_DATE - g)::date + interval '1 day')::timestamp
         + (p.expected_arrival + (s.arrival_offset_min || ' minutes')::interval)::time
         + (d.delay_min || ' minutes')::interval AS arrived_at,
       d.delay_min,
       d.delay_min > 30,
       'history'
FROM stores s
CROSS JOIN platforms p
CROSS JOIN generate_series(1, 30) AS g
CROSS JOIN LATERAL (
  SELECT CASE p.code
    WHEN 'ALPHA' THEN CASE WHEN (g * 7 + s.id * 3 + p.id) % 20 < 3
                           THEN 35 + ((g * 17 + s.id * 5 + p.id * 11) % 130) ELSE 0 END
    WHEN 'BETA'  THEN CASE WHEN (g * 7 + s.id * 2 + p.id) % 10 < 3
                           THEN 40 + ((g * 13 + s.id * 7) % 100) ELSE 0 END
    ELSE CASE WHEN (g * 11 + s.id * 5 + p.id * 3) % 20 < 11
                           THEN 240 + ((g * 29 + s.id * 11) % 900) ELSE 0 END
  END AS delay_min
) d
WHERE NOT EXISTS (
  SELECT 1 FROM arrival_history h
  WHERE h.store_id = s.id AND h.platform_id = p.id AND h.biz_date = (CURRENT_DATE - g)::date
);
