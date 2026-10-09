BEGIN;
CREATE TABLE IF NOT EXISTS distribucion.gps(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas, conductor_id uuid NOT NULL,
 latitud double precision NOT NULL CHECK(latitud BETWEEN -90 AND 90),
 longitud double precision NOT NULL CHECK(longitud BETWEEN -180 AND 180),
 precision_metros double precision NOT NULL CHECK(precision_metros>=0),
 velocidad double precision, fecha timestamptz NOT NULL, recibido timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(empresa_id,conductor_id) REFERENCES distribucion.miembros(empresa_id,id),
 UNIQUE(empresa_id,conductor_id,fecha,latitud,longitud)
);
CREATE INDEX IF NOT EXISTS dist_gps_conductor_fecha ON distribucion.gps(empresa_id,conductor_id,fecha DESC);
CREATE TABLE IF NOT EXISTS distribucion.visitas(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES distribucion.empresas,
 reparto_id uuid NOT NULL, codigo_cliente text NOT NULL, llegada timestamptz NOT NULL DEFAULT now(),
 estado text NOT NULL DEFAULT 'VISITADO' CHECK(estado IN('VISITADO','ENTREGADO','CERRADO','INCIDENCIA')),
 observacion text, actualizado timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(empresa_id,reparto_id) REFERENCES distribucion.repartos(empresa_id,id),
 UNIQUE(empresa_id,reparto_id,codigo_cliente),UNIQUE(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS distribucion.permanencias(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,empresa_id uuid NOT NULL,
 visita_id uuid NOT NULL,conductor_id uuid NOT NULL,entrada timestamptz NOT NULL,salida timestamptz,
 FOREIGN KEY(empresa_id,visita_id) REFERENCES distribucion.visitas(empresa_id,id),
 FOREIGN KEY(empresa_id,conductor_id) REFERENCES distribucion.miembros(empresa_id,id),
 CHECK(salida IS NULL OR salida>=entrada)
);
CREATE UNIQUE INDEX IF NOT EXISTS dist_permanencia_abierta ON distribucion.permanencias(empresa_id,visita_id,conductor_id) WHERE salida IS NULL;
CREATE TABLE IF NOT EXISTS distribucion.fotos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),empresa_id uuid NOT NULL,visita_id uuid NOT NULL,
 actor_id uuid NOT NULL,contenido bytea NOT NULL,mime text NOT NULL,fecha timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(empresa_id,visita_id) REFERENCES distribucion.visitas(empresa_id,id),
 FOREIGN KEY(empresa_id,actor_id) REFERENCES distribucion.miembros(empresa_id,id)
);
COMMIT;
