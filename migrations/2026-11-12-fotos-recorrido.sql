-- Ejecutar una vez en PostgreSQL antes de habilitar fotos del recorrido.
CREATE TABLE IF NOT EXISTS distribucion.fotos_recorrido (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id uuid NOT NULL,
 conductor_id uuid NOT NULL,
 reparto_id uuid NULL,
 codigo_cliente text NULL,
 contenido bytea NOT NULL,
 mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
 latitud double precision NULL,
 longitud double precision NULL,
 precision_metros double precision NULL,
 origen text NOT NULL CHECK (origen IN ('CAMARA','GALERIA')),
 fecha timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT foto_recorrido_asociacion CHECK ((reparto_id IS NULL AND codigo_cliente IS NULL) OR (reparto_id IS NOT NULL AND codigo_cliente IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fotos_recorrido_empresa_fecha ON distribucion.fotos_recorrido(empresa_id,fecha DESC);
CREATE INDEX IF NOT EXISTS idx_fotos_recorrido_conductor_fecha ON distribucion.fotos_recorrido(conductor_id,fecha DESC);
