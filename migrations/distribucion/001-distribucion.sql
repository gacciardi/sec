BEGIN;
CREATE SCHEMA IF NOT EXISTS distribucion;
-- Conservar todos los roles actuales y permitir CONDUCTOR sin renombrar vendedores.
DO $$ DECLARE expr text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint
 WHERE conrelid='public.usuarios'::regclass AND conname='usuarios_rol_check';
 IF expr IS NOT NULL AND position('CONDUCTOR' in expr)=0 THEN
  ALTER TABLE public.usuarios DROP CONSTRAINT usuarios_rol_check;
  EXECUTE 'ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_rol_check CHECK (('||expr||') OR rol = ''CONDUCTOR'')';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS distribucion.empresas(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), codigo text NOT NULL UNIQUE,
 nombre text NOT NULL, activo boolean NOT NULL DEFAULT true
);
INSERT INTO distribucion.empresas(codigo,nombre) VALUES ('rebesa','REBESA') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS distribucion.miembros(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES distribucion.empresas,
 usuario_id uuid NOT NULL REFERENCES public.usuarios,
 legajo text NOT NULL, nombre text NOT NULL, apellido text NOT NULL, telefono text,
 rol text NOT NULL CHECK(rol IN ('ADMIN','SUPERVISOR','CONDUCTOR')),
 clave_hash text NOT NULL, activo boolean NOT NULL DEFAULT true,
 UNIQUE(empresa_id,legajo), UNIQUE(empresa_id,usuario_id), UNIQUE(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS distribucion.sesiones(
 token_hash text PRIMARY KEY, miembro_id uuid NOT NULL REFERENCES distribucion.miembros,
 expira timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS distribucion.clientes(
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas, codigo text NOT NULL,
 cliente_id uuid NOT NULL REFERENCES public.clientes,
 PRIMARY KEY(empresa_id,codigo), UNIQUE(empresa_id,cliente_id)
);
-- Vincular sólo códigos inequívocos del padrón actual a la primera empresa.
INSERT INTO distribucion.clientes(empresa_id,codigo,cliente_id)
SELECT e.id,trim(c.codigo_cliente),c.id FROM public.clientes c
CROSS JOIN distribucion.empresas e
WHERE e.codigo='rebesa' AND c.deleted_at IS NULL AND nullif(trim(c.codigo_cliente),'') IS NOT NULL
AND trim(c.codigo_cliente) IN (SELECT trim(d.codigo_cliente) FROM public.clientes d WHERE d.deleted_at IS NULL GROUP BY trim(d.codigo_cliente) HAVING count(*)=1)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS distribucion.auditoria(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas, actor_id uuid REFERENCES distribucion.miembros,
 accion text NOT NULL, detalle jsonb NOT NULL, fecha timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS distribucion.vehiculos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES distribucion.empresas,
 interno text NOT NULL, patente text NOT NULL, tipo text NOT NULL CHECK(tipo IN('camion','tractor','semi')),
 activo boolean NOT NULL DEFAULT true, UNIQUE(empresa_id,interno), UNIQUE(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS distribucion.repartos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES distribucion.empresas,
 fecha date NOT NULL, despacho text NOT NULL, conductor_nombre text,
 conductor_id uuid, principal_id uuid, semi_id uuid,
 FOREIGN KEY(empresa_id,conductor_id) REFERENCES distribucion.miembros(empresa_id,id),
 FOREIGN KEY(empresa_id,principal_id) REFERENCES distribucion.vehiculos(empresa_id,id),
 FOREIGN KEY(empresa_id,semi_id) REFERENCES distribucion.vehiculos(empresa_id,id),
 UNIQUE(empresa_id,fecha,despacho), UNIQUE(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS distribucion.pedidos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES distribucion.empresas,
 reparto_id uuid NOT NULL, fecha date NOT NULL, numero text NOT NULL, codigo_cliente text NOT NULL,
 nombre_cliente text, cantidad numeric, importe numeric,
 FOREIGN KEY(empresa_id,reparto_id) REFERENCES distribucion.repartos(empresa_id,id),
 UNIQUE(empresa_id,fecha,numero)
);
CREATE INDEX IF NOT EXISTS pedidos_reparto ON distribucion.pedidos(empresa_id,reparto_id);
COMMIT;
