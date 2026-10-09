-- Inmobiliaria Lote 321 · Sendero 321 Residencial (Mérida, Yucatán). Datos del proyecto en dev.
-- Idempotente. Aplicar con: pnpm wrangler d1 execute DB --env dev --remote --file=seed/sendero-321.sql
-- Mantiene los ids tnt-demo / dev-almendros para no romper prospectos ni conversaciones ya existentes.

UPDATE tenants SET name = 'Inmobiliaria Lote 321', brand_primary = '#1B3A6B', brand_accent = '#C9A227' WHERE id = 'tnt-demo';
UPDATE developments SET name = 'Sendero 321 Residencial', slug = 'sendero-321',
  description = 'Privada residencial de 60 lotes urbanizados al norte de Mérida, sobre la carretera Mérida–Progreso, a 12 minutos del Periférico y 20 minutos de la playa de Progreso.',
  address = 'Carretera Mérida–Progreso km 18, Komchén', city = 'Mérida', state = 'Yucatán', lat = 21.1187, lng = -89.6295,
  amenities = '["Pórtico de acceso con caseta de vigilancia 24/7", "Casa club con alberca y palapa", "Parque lineal con ciclovía y andadores", "Juegos infantiles", "Áreas verdes con vegetación nativa", "Electricidad, agua potable y drenaje subterráneos", "Calles pavimentadas con alumbrado LED"]', status = 'active', updated_at = 1760000000000
WHERE id = 'dev-almendros';

DELETE FROM lot_media WHERE tenant_id = 'tnt-demo' AND kind = 'quote';
DELETE FROM lots WHERE tenant_id = 'tnt-demo';
DELETE FROM payment_plans WHERE tenant_id = 'tnt-demo';

-- 3 manzanas, 60 lotes. Precio por m² según ubicación; esquinas y frente a parque con sobreprecio.
INSERT INTO lots (id, tenant_id, development_id, block, number, area_m2, front_m, depth_m, price_per_m2_cents, total_price_cents, status, reserved_until, features, geojson, updated_at) VALUES
  ('lot-A-1', 'tnt-demo', 'dev-almendros', 'A', '1', 240, 12, 20, 335000, 80400000, 'available', NULL, 'Esquina, Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-2', 'tnt-demo', 'dev-almendros', 'A', '2', 200, 10, 20, 295000, 59000000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-A-3', 'tnt-demo', 'dev-almendros', 'A', '3', 220, 11, 20, 310000, 68200000, 'sold', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-4', 'tnt-demo', 'dev-almendros', 'A', '4', 225.0, 10, 22.5, 295000, 66375000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-A-5', 'tnt-demo', 'dev-almendros', 'A', '5', 200, 10, 20, 310000, 62000000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-6', 'tnt-demo', 'dev-almendros', 'A', '6', 220, 11, 20, 295000, 64900000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-A-7', 'tnt-demo', 'dev-almendros', 'A', '7', 200, 10, 20, 310000, 62000000, 'sold', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-8', 'tnt-demo', 'dev-almendros', 'A', '8', 225.0, 10, 22.5, 295000, 66375000, 'reserved', unixepoch() * 1000 + 6 * 86400000, NULL, NULL, 1760000000000),
  ('lot-A-9', 'tnt-demo', 'dev-almendros', 'A', '9', 220, 11, 20, 310000, 68200000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-10', 'tnt-demo', 'dev-almendros', 'A', '10', 200, 10, 20, 295000, 59000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-A-11', 'tnt-demo', 'dev-almendros', 'A', '11', 240, 12, 20, 335000, 80400000, 'sold', NULL, 'Esquina, Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-12', 'tnt-demo', 'dev-almendros', 'A', '12', 247.5, 11, 22.5, 295000, 73012500, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-A-13', 'tnt-demo', 'dev-almendros', 'A', '13', 200, 10, 20, 310000, 62000000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-14', 'tnt-demo', 'dev-almendros', 'A', '14', 200, 10, 20, 295000, 59000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-A-15', 'tnt-demo', 'dev-almendros', 'A', '15', 220, 11, 20, 310000, 68200000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-16', 'tnt-demo', 'dev-almendros', 'A', '16', 225.0, 10, 22.5, 295000, 66375000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-A-17', 'tnt-demo', 'dev-almendros', 'A', '17', 200, 10, 20, 310000, 62000000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-18', 'tnt-demo', 'dev-almendros', 'A', '18', 220, 11, 20, 295000, 64900000, 'reserved', unixepoch() * 1000 + 6 * 86400000, NULL, NULL, 1760000000000),
  ('lot-A-19', 'tnt-demo', 'dev-almendros', 'A', '19', 200, 10, 20, 310000, 62000000, 'available', NULL, 'Frente a parque lineal', NULL, 1760000000000),
  ('lot-A-20', 'tnt-demo', 'dev-almendros', 'A', '20', 270.0, 12, 22.5, 320000, 86400000, 'available', NULL, 'Esquina', NULL, 1760000000000),
  ('lot-B-1', 'tnt-demo', 'dev-almendros', 'B', '1', 240, 12, 20, 350000, 84000000, 'sold', NULL, 'Esquina, Junto a casa club', NULL, 1760000000000),
  ('lot-B-2', 'tnt-demo', 'dev-almendros', 'B', '2', 250, 10, 25, 310000, 77500000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-3', 'tnt-demo', 'dev-almendros', 'B', '3', 220, 11, 20, 325000, 71500000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-4', 'tnt-demo', 'dev-almendros', 'B', '4', 250, 10, 25, 310000, 77500000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-B-5', 'tnt-demo', 'dev-almendros', 'B', '5', 200, 10, 20, 325000, 65000000, 'sold', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-6', 'tnt-demo', 'dev-almendros', 'B', '6', 275, 11, 25, 310000, 85250000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-7', 'tnt-demo', 'dev-almendros', 'B', '7', 200, 10, 20, 325000, 65000000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-8', 'tnt-demo', 'dev-almendros', 'B', '8', 250, 10, 25, 310000, 77500000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-9', 'tnt-demo', 'dev-almendros', 'B', '9', 220, 11, 20, 325000, 71500000, 'sold', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-10', 'tnt-demo', 'dev-almendros', 'B', '10', 250, 10, 25, 310000, 77500000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-11', 'tnt-demo', 'dev-almendros', 'B', '11', 200, 10, 20, 325000, 65000000, 'reserved', unixepoch() * 1000 + 6 * 86400000, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-12', 'tnt-demo', 'dev-almendros', 'B', '12', 300, 12, 25, 335000, 100500000, 'available', NULL, 'Esquina', NULL, 1760000000000),
  ('lot-B-13', 'tnt-demo', 'dev-almendros', 'B', '13', 200, 10, 20, 325000, 65000000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-14', 'tnt-demo', 'dev-almendros', 'B', '14', 250, 10, 25, 310000, 77500000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-B-15', 'tnt-demo', 'dev-almendros', 'B', '15', 220, 11, 20, 325000, 71500000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-16', 'tnt-demo', 'dev-almendros', 'B', '16', 250, 10, 25, 310000, 77500000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-17', 'tnt-demo', 'dev-almendros', 'B', '17', 200, 10, 20, 325000, 65000000, 'reserved', unixepoch() * 1000 + 6 * 86400000, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-18', 'tnt-demo', 'dev-almendros', 'B', '18', 275, 11, 25, 310000, 85250000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-B-19', 'tnt-demo', 'dev-almendros', 'B', '19', 200, 10, 20, 325000, 65000000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-20', 'tnt-demo', 'dev-almendros', 'B', '20', 250, 10, 25, 310000, 77500000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-B-21', 'tnt-demo', 'dev-almendros', 'B', '21', 220, 11, 20, 325000, 71500000, 'available', NULL, 'Junto a casa club', NULL, 1760000000000),
  ('lot-B-22', 'tnt-demo', 'dev-almendros', 'B', '22', 300, 12, 25, 335000, 100500000, 'available', NULL, 'Esquina', NULL, 1760000000000),
  ('lot-C-1', 'tnt-demo', 'dev-almendros', 'C', '1', 240, 12, 20, 310000, 74400000, 'available', NULL, 'Esquina', NULL, 1760000000000),
  ('lot-C-2', 'tnt-demo', 'dev-almendros', 'C', '2', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-3', 'tnt-demo', 'dev-almendros', 'C', '3', 220, 11, 20, 285000, 62700000, 'reserved', unixepoch() * 1000 + 6 * 86400000, NULL, NULL, 1760000000000),
  ('lot-C-4', 'tnt-demo', 'dev-almendros', 'C', '4', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-5', 'tnt-demo', 'dev-almendros', 'C', '5', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-6', 'tnt-demo', 'dev-almendros', 'C', '6', 220, 11, 20, 285000, 62700000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-C-7', 'tnt-demo', 'dev-almendros', 'C', '7', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-8', 'tnt-demo', 'dev-almendros', 'C', '8', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-9', 'tnt-demo', 'dev-almendros', 'C', '9', 220, 11, 20, 285000, 62700000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-10', 'tnt-demo', 'dev-almendros', 'C', '10', 200, 10, 20, 285000, 57000000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-C-11', 'tnt-demo', 'dev-almendros', 'C', '11', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-12', 'tnt-demo', 'dev-almendros', 'C', '12', 220, 11, 20, 285000, 62700000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-13', 'tnt-demo', 'dev-almendros', 'C', '13', 200, 10, 20, 285000, 57000000, 'sold', NULL, NULL, NULL, 1760000000000),
  ('lot-C-14', 'tnt-demo', 'dev-almendros', 'C', '14', 200, 10, 20, 285000, 57000000, 'available', NULL, NULL, NULL, 1760000000000),
  ('lot-C-15', 'tnt-demo', 'dev-almendros', 'C', '15', 220, 11, 20, 285000, 62700000, 'available', NULL, 'Vista a área de conservación', NULL, 1760000000000),
  ('lot-C-16', 'tnt-demo', 'dev-almendros', 'C', '16', 200, 10, 20, 285000, 57000000, 'available', NULL, 'Vista a área de conservación', NULL, 1760000000000),
  ('lot-C-17', 'tnt-demo', 'dev-almendros', 'C', '17', 200, 10, 20, 285000, 57000000, 'available', NULL, 'Vista a área de conservación', NULL, 1760000000000),
  ('lot-C-18', 'tnt-demo', 'dev-almendros', 'C', '18', 240, 12, 20, 310000, 74400000, 'blocked', NULL, 'Esquina, Vista a área de conservación', NULL, 1760000000000);

-- Planes (montos en centavos, porcentajes en puntos base: 1 % = 100).
INSERT INTO payment_plans (id, tenant_id, development_id, name, calculation_type, discount_bp, reservation_cents, down_payment_bp, down_payment_installments, months, annual_interest_bp, monthly_bp, on_delivery_bp, on_delivery_installments, rounding_absorber, delivery_date, active) VALUES
  ('plan-contado', 'tnt-demo', 'dev-almendros', 'Contado (8 % de descuento)', 'on_delivery', 800, 1500000, 10000, 1, 0, 0, 0, 0, 1, NULL, NULL, 1),
  ('plan-12msi', 'tnt-demo', 'dev-almendros', '12 meses sin intereses (30 % de enganche)', 'on_delivery', 0, 1500000, 3000, 1, 12, 0, 7000, 0, 1, 'monthly', NULL, 1),
  ('plan-24msi', 'tnt-demo', 'dev-almendros', '24 meses sin intereses (40 % de enganche)', 'on_delivery', 0, 1500000, 4000, 1, 24, 0, 6000, 0, 1, 'monthly', NULL, 1),
  ('plan-60', 'tnt-demo', 'dev-almendros', '60 meses con 11.9 % anual (20 % de enganche)', 'with_interest', 0, 1500000, 2000, 1, 60, 1190, 0, 0, 1, NULL, NULL, 1);

DELETE FROM kb_articles WHERE tenant_id = 'tnt-demo';
INSERT INTO kb_articles (id, tenant_id, development_id, title, body, keywords, category, status, approved_at, created_at, updated_at) VALUES
  ('s321-kb-1', 'tnt-demo', NULL, '¿Qué servicios tienen los lotes?', 'Todos los lotes de Sendero 321 se entregan urbanizados: electricidad (CFE), agua potable y drenaje subterráneos, calles pavimentadas con banquetas y alumbrado LED. El internet y la televisión los contrata cada propietario con el proveedor de su preferencia.', 'luz, agua, drenaje, cfe, servicios, internet, pavimento', 'desarrollo', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-2', 'tnt-demo', NULL, '¿Qué amenidades tiene Sendero 321?', 'Sendero 321 cuenta con pórtico de acceso con caseta de vigilancia 24/7, casa club con alberca y palapa, parque lineal con ciclovía y andadores, juegos infantiles y áreas verdes con vegetación nativa.', 'amenidades, alberca, casa club, seguridad, vigilancia, parque, ciclovia', 'desarrollo', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-3', 'tnt-demo', NULL, '¿Dónde está Sendero 321?', 'Sendero 321 Residencial está en la carretera Mérida–Progreso km 18, en Komchén, al norte de Mérida, Yucatán: a 12 minutos del Periférico, 15 minutos de plazas comerciales y hospitales del norte de la ciudad y 20 minutos de la playa de Progreso.', 'ubicacion, donde, direccion, como llegar, cerca', 'desarrollo', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-4', 'tnt-demo', NULL, '¿Qué formas de pago aceptan?', 'Manejamos cuatro planes: contado con 8 % de descuento; 12 meses sin intereses con 30 % de enganche; 24 meses sin intereses con 40 % de enganche; y 60 meses con 11.9 % de interés anual y 20 % de enganche. Todos inician con un apartado de $15,000 MXN que se descuenta del precio. Los pagos se hacen únicamente por transferencia o depósito a las cuentas a nombre de Inmobiliaria Lote 321; nunca a cuentas personales. Confirma siempre los datos bancarios con tu asesor.', 'pago, credito, financiamiento, mensualidades, contado, transferencia, deposito, apartado', 'pagos', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-5', 'tnt-demo', NULL, '¿Aceptan crédito Infonavit o bancario?', 'Por ahora los lotes se venden de contado o con nuestro financiamiento directo, sin buró de crédito. Los créditos Infonavit y bancarios aplican para construir: tu asesor te puede orientar sobre las opciones una vez escriturado el terreno.', 'infonavit, fovissste, credito bancario, hipoteca, buro', 'pagos', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-6', 'tnt-demo', NULL, '¿Cómo es el proceso de compra?', '1) Eliges tu lote y el plan de pago. 2) Lo apartas con $15,000 MXN, que se descuentan del precio, y el apartado se respeta 7 días. 3) Firmas el contrato de compraventa con tu asesor en la oficina de ventas. 4) Pagas el enganche y las mensualidades según tu plan. 5) Al liquidar, se firma la escritura ante notario.', 'comprar, proceso, pasos, apartar, contrato, escritura', 'compra', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-7', 'tnt-demo', NULL, '¿Qué documentos necesito para comprar?', 'Identificación oficial vigente (INE o pasaporte), CURP, comprobante de domicilio reciente y constancia de situación fiscal (RFC). Por seguridad, la documentación se entrega directamente a tu asesor, no por este chat.', 'documentos, requisitos, ine, curp, rfc, comprobante', 'compra', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-8', 'tnt-demo', NULL, '¿Cuándo puedo empezar a construir?', 'Puedes construir a partir de la firma del contrato y de estar al corriente en tus pagos, respetando el reglamento de construcción de la privada (alturas, remetimientos y fachada). El reglamento completo te lo entrega tu asesor.', 'construir, construccion, obra, reglamento', 'construccion', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-9', 'tnt-demo', NULL, '¿Hay cuota de mantenimiento?', 'Sí. La cuota de mantenimiento de la privada es de $650 MXN al mes por lote y cubre vigilancia 24/7, mantenimiento de áreas verdes, casa club y alumbrado de áreas comunes. Se empieza a pagar a partir de la entrega del lote.', 'mantenimiento, cuota, administracion', 'desarrollo', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-10', 'tnt-demo', NULL, '¿Dónde está la oficina de ventas y en qué horario atiende?', 'La oficina de ventas está en el mismo desarrollo, en la carretera Mérida–Progreso km 18. Atiende de lunes a viernes de 9:00 a 18:00 y sábados de 9:00 a 14:00. Las visitas al desarrollo se agendan con un asesor.', 'oficina, horario, visita, atencion', 'oficina', 'approved', 1760000000000, 1760000000000, 1760000000000),
  ('s321-kb-11', 'tnt-demo', NULL, '¿Se permiten mascotas?', 'Sí, Sendero 321 es pet friendly. Las mascotas deben pasear con correa en áreas comunes y sus dueños recoger sus desechos, según el reglamento interno.', 'mascotas, perros, gatos, pet friendly', 'desarrollo', 'approved', 1760000000000, 1760000000000, 1760000000000);
