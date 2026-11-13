-- SEC Distribución: permitir el perfil OPERADOR sin alterar los usuarios existentes.
BEGIN;
ALTER TABLE distribucion.miembros
  DROP CONSTRAINT IF EXISTS miembros_rol_check;
ALTER TABLE distribucion.miembros
  ADD CONSTRAINT miembros_rol_check
  CHECK (rol IN ('ADMIN','SUPERVISOR','OPERADOR','CONDUCTOR'));
COMMIT;
