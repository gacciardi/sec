'use strict';
// Todas las filas se guardan en la transacción del importador, sin viajes por cada horario.
module.exports=async function guardarHorarios(c,empresa,cambios){
 if(!Array.isArray(cambios)||!cambios.length)throw Error('No hay horarios para importar');
 const filas=cambios.map(x=>({codigo:x.codigo,dia:x.dia,apertura_1:x.turnos[0][0],cierre_1:x.turnos[0][1],apertura_2:x.turnos[1]?.[0]||null,cierre_2:x.turnos[1]?.[1]||null,minutos:x.minutos}));
 // Serializa importaciones de una misma empresa, sin bloquear las otras empresas.
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('horarios:'||$1::text,0))",[empresa]);
 const r=await c.query(`INSERT INTO distribucion.horarios_recepcion(empresa_id,codigo_cliente,dia_semana,apertura_1,cierre_1,apertura_2,cierre_2,minutos_descarga)
 SELECT $1::uuid,x.codigo,x.dia,x.apertura_1,x.cierre_1,x.apertura_2,x.cierre_2,x.minutos
 FROM jsonb_to_recordset($2::jsonb) AS x(codigo text,dia smallint,apertura_1 time,cierre_1 time,apertura_2 time,cierre_2 time,minutos integer)
 ON CONFLICT(empresa_id,codigo_cliente,dia_semana) DO UPDATE SET apertura_1=EXCLUDED.apertura_1,cierre_1=EXCLUDED.cierre_1,apertura_2=EXCLUDED.apertura_2,cierre_2=EXCLUDED.cierre_2,minutos_descarga=EXCLUDED.minutos_descarga,actualizado_en=now()`,[empresa,JSON.stringify(filas)]);
 if(r.rowCount!==cambios.length)throw Error('No se pudo guardar la totalidad de horarios');
 return r.rowCount;
};
