-- Ampliar clasificaciones de motivos de rechazo sin modificar registros existentes.
BEGIN;
ALTER TABLE distribucion.motivos_rechazo DROP CONSTRAINT IF EXISTS motivos_rechazo_area_responsable_check;
ALTER TABLE distribucion.motivos_rechazo ADD CONSTRAINT motivos_rechazo_area_responsable_check CHECK (area_responsable IN ('COMERCIAL','DISTRIBUCION','BODEGA','CLIENTE','OTROS'));
COMMIT;
