-- Seed de demo (datos ficticios). Idempotente: se puede correr varias veces.
-- pnpm db:seed

INSERT INTO tenants (id, name, slug, created_at)
VALUES ('tnt-demo', 'Desarrolladora Demo', 'demo', 1759708800000)
ON CONFLICT(id) DO UPDATE SET name = excluded.name;

-- Cambia phone_number_id por el de tu número en Meta (WhatsApp → Configuración de la API).
INSERT INTO wa_accounts (id, tenant_id, phone_number_id, waba_id, display_phone, created_at)
VALUES ('wa-demo', 'tnt-demo', 'DEMO_PHONE_NUMBER_ID', NULL, NULL, 1759708800000)
ON CONFLICT(id) DO NOTHING;

INSERT INTO developments (id, tenant_id, name, slug, description, address, city, state, lat, lng, amenities, status, created_at, updated_at)
VALUES (
  'dev-almendros', 'tnt-demo', 'Residencial Los Almendros', 'los-almendros',
  'Lotes residenciales con servicios ocultos, a 15 minutos del periférico.',
  'Carretera Mérida–Progreso km 18', 'Mérida', 'Yucatán', 21.1205, -89.6268,
  '["Casa club","Alberca","Áreas verdes","Acceso controlado","Ciclovía","Servicios subterráneos"]',
  'active', 1759708800000, 1759708800000
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name, description = excluded.description, amenities = excluded.amenities,
  updated_at = excluded.updated_at;

DELETE FROM lots WHERE tenant_id = 'tnt-demo';
DELETE FROM payment_plans WHERE tenant_id = 'tnt-demo';

-- 4 manzanas (A–D) × 10 lotes. Superficies 200–300 m², precio/m² por manzana.
-- Algunos vendidos (n % 7 = 0) y apartados (n % 9 = 0) para probar disponibilidad.
WITH RECURSIVE
  seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 40),
  base AS (
    SELECT
      n,
      char(64 + ((n - 1) / 10) + 1) AS block,
      ((n - 1) % 10) + 1 AS num,
      200 + ((n * 37) % 11) * 10 AS area,
      CASE ((n - 1) / 10) WHEN 0 THEN 320000 WHEN 1 THEN 300000 WHEN 2 THEN 280000 ELSE 350000 END AS ppm2
    FROM seq
  )
INSERT INTO lots (id, tenant_id, development_id, block, number, area_m2, front_m, depth_m,
                  price_per_m2_cents, total_price_cents, status, reserved_until, features, geojson, updated_at)
SELECT
  'lot-' || block || '-' || num, 'tnt-demo', 'dev-almendros', block, CAST(num AS TEXT),
  area, 10, area / 10.0, ppm2, area * ppm2,
  CASE WHEN n % 7 = 0 THEN 'sold' WHEN n % 9 = 0 THEN 'reserved' ELSE 'available' END,
  NULL,
  CASE WHEN num IN (1, 10) THEN 'Esquina' WHEN block = 'D' THEN 'Frente a parque' ELSE NULL END,
  NULL, 1759708800000
FROM base;

-- Planes (montos en centavos, porcentajes en puntos base: 1 % = 100).
INSERT INTO payment_plans (id, tenant_id, development_id, name, calculation_type, discount_bp, reservation_cents,
                           down_payment_bp, down_payment_installments, months, annual_interest_bp,
                           monthly_bp, on_delivery_bp, on_delivery_installments, rounding_absorber, delivery_date, active) VALUES
  -- Pago único con 10 % de descuento.
  ('plan-contado',  'tnt-demo', NULL,            'Contado (10 % de descuento)', 'on_delivery',   1000,       0, 10000, 1,  0,    0,    0,    0, 1, NULL,          NULL,         1),
  -- 20 % de enganche y 80 % en 12 mensualidades sin intereses.
  ('plan-12msi',    'tnt-demo', 'dev-almendros', '12 meses sin intereses',      'on_delivery',      0, 1000000,  2000, 1, 12,    0, 8000,    0, 1, 'monthly',     NULL,         1),
  -- 15 % de enganche y 36 mensualidades con 12 % anual (amortización francesa).
  ('plan-36',       'tnt-demo', 'dev-almendros', '36 meses (12 % anual)',       'with_interest',    0, 1000000,  1500, 1, 36, 1200,    0,    0, 1, NULL,          NULL,         1),
  -- Preventa: 30 % de enganche en 2 pagos, 50 % en 18 mensualidades y 20 % contra entrega.
  ('plan-preventa', 'tnt-demo', 'dev-almendros', 'Preventa 30/50/20',           'on_delivery',    500, 1000000,  3000, 2, 18,    0, 5000, 2000, 1, 'on_delivery', '2028-06-30', 1);
