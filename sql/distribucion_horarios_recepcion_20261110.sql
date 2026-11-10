-- SEC Distribución: horarios de recepción por cliente y propuestas de conductores.
-- Aplicar en PostgreSQL con respaldo previo y ventana controlada.
-- No modifica pedidos, repartos, visitas ni clientes comerciales.
BEGIN;
CREATE TABLE IF NOT EXISTS distribucion.horarios_recepcion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),
 codigo_cliente text NOT NULL,
 dia_semana smallint NOT NULL CHECK(dia_semana BETWEEN 0 AND 6),
 apertura_1 time NOT NULL,
 cierre_1 time NOT NULL,
 apertura_2 time,
 cierre_2 time,
 minutos_descarga integer NOT NULL DEFAULT 15 CHECK(minutos_descarga BETWEEN 0 AND 480),
 observaciones text NOT NULL DEFAULT '',
 actualizado_en timestamptz NOT NULL DEFAULT now(),
 UNIQUE(empresa_id,codigo_cliente,dia_semana),
 CHECK(apertura_1<cierre_1),
 CHECK((apertura_2 IS NULL AND cierre_2 IS NULL) OR (apertura_2 IS NOT NULL AND cierre_2 IS NOT NULL AND apertura_2<cierre_2 AND apertura_2>=cierre_1))
);
CREATE TABLE IF NOT EXISTS distribucion.propuestas_horarios (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),
 codigo_cliente text NOT NULL,
 conductor_id uuid NOT NULL REFERENCES distribucion.miembros(id),
 dia_semana smallint NOT NULL CHECK(dia_semana BETWEEN 0 AND 6),
 apertura_1 time NOT NULL,
 cierre_1 time NOT NULL,
 apertura_2 time,
 cierre_2 time,
 minutos_descarga integer NOT NULL DEFAULT 15 CHECK(minutos_descarga BETWEEN 0 AND 480),
 observaciones text NOT NULL DEFAULT '',
 estado text NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
 creado_en timestamptz NOT NULL DEFAULT now(),
 revisado_en timestamptz,
 revisado_por uuid REFERENCES distribucion.miembros(id),
 CHECK(apertura_1<cierre_1),
 CHECK((apertura_2 IS NULL AND cierre_2 IS NULL) OR (apertura_2 IS NOT NULL AND cierre_2 IS NOT NULL AND apertura_2<cierre_2 AND apertura_2>=cierre_1))
);
CREATE INDEX IF NOT EXISTS propuestas_horarios_pendientes ON distribucion.propuestas_horarios(empresa_id,estado,creado_en DESC);
COMMIT;
