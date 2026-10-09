BEGIN;
CREATE TABLE IF NOT EXISTS distribucion.gps_apk(
 clave_hash text PRIMARY KEY,
 sesion_hash text NOT NULL REFERENCES distribucion.sesiones(token_hash) ON DELETE CASCADE,
 miembro_id uuid NOT NULL REFERENCES distribucion.miembros(id),
 activo boolean NOT NULL DEFAULT true,
 creado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dist_gps_apk_sesion ON distribucion.gps_apk(sesion_hash);
COMMIT;
