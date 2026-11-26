'use strict';
const preparados=new WeakMap();
const fail=(m,status=400)=>Object.assign(Error(m),{status});
async function preparar(db){if(!preparados.has(db))preparados.set(db,db.query(`CREATE TABLE IF NOT EXISTS distribucion.vehiculo_fuente_gps(
 empresa_id uuid NOT NULL,vehiculo_id uuid NOT NULL,fuente text NOT NULL CHECK(fuente IN('CUSAT','CELULAR')),
 version integer NOT NULL DEFAULT 1,actualizado_en timestamptz NOT NULL DEFAULT now(),actor_id uuid NOT NULL,
 PRIMARY KEY(empresa_id,vehiculo_id),FOREIGN KEY(empresa_id,vehiculo_id) REFERENCES distribucion.vehiculos(empresa_id,id))`).catch(e=>{preparados.delete(db);throw e;}));await preparados.get(db);}
async function fuentes(db,empresaId,env=process.env){
 const r=await db.query(`SELECT v.id AS vehiculo_id,v.interno,v.patente,v.tipo,v.activo,
 coalesce(f.fuente,CASE WHEN lower(e.codigo)=lower($2) AND $3::boolean THEN 'CUSAT' ELSE 'CELULAR' END) AS fuente,
 coalesce(f.version,0) AS version,f.actualizado_en,(lower(e.codigo)=lower($2) AND $3::boolean) AS cusat_disponible
 FROM distribucion.vehiculos v JOIN distribucion.empresas e ON e.id=v.empresa_id
 LEFT JOIN distribucion.vehiculo_fuente_gps f ON f.empresa_id=v.empresa_id AND f.vehiculo_id=v.id
 WHERE v.empresa_id=$1 AND v.tipo IN('camion','tractor') ORDER BY v.interno,v.id`,[empresaId,env.CUSAT_EMPRESA_CODIGO||'',!!(env.CUSAT_API_CODE&&env.CUSAT_PHONE)]);return r.rows;
}
function permite(fuente,origen,fecha){return !!fuente&&fuente.fuente===origen&&(!fuente.actualizado_en||new Date(fecha)>=new Date(fuente.actualizado_en));}
module.exports=function(db){const r=require('express').Router(),wrap=f=>(q,s,n)=>Promise.resolve().then(()=>f(q,s)).catch(n);
 const acceso=(q,s,n)=>!q.actor?.consulta_comercial&&['ADMIN','SUPERVISOR','OPERADOR'].includes(q.actor?.rol)?n():n(fail('Acceso restringido a Distribución.',403));
 r.get('/vehiculos/fuentes-gps',acceso,wrap(async(q,s)=>{await preparar(db);s.set('Cache-Control','no-store').json(await fuentes(db,q.actor.empresa_id));}));
 r.put('/vehiculos/:id/fuente-gps',acceso,wrap(async(q,s)=>{
  if(!['ADMIN','SUPERVISOR'].includes(q.actor.rol))throw fail('Solo administración o supervisión puede elegir la fuente GPS.',403);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.params.id)||!['CUSAT','CELULAR'].includes(q.body?.fuente)||!Number.isInteger(q.body.version)||q.body.version<0)throw fail('Seleccioná camión, fuente GPS y versión válida.');
  await preparar(db);const c=await db.connect();try{await c.query('BEGIN');
   const v=await c.query("SELECT id FROM distribucion.vehiculos WHERE id=$1 AND empresa_id=$2 AND tipo IN('camion','tractor') FOR UPDATE",[q.params.id,q.actor.empresa_id]);if(!v.rowCount)throw fail('Camión no disponible en esta empresa.',404);
   const anterior=(await fuentes(c,q.actor.empresa_id)).find(x=>x.vehiculo_id===q.params.id);if(!anterior)throw fail('Camión no disponible.',404);if(anterior.version!==q.body.version)throw fail('Otro usuario cambió la fuente GPS. Volvé a consultar antes de guardar.',409);
   if(q.body.fuente==='CUSAT'&&!anterior.cusat_disponible)throw fail('Esta empresa no tiene conexión Cusat configurada.',409);
   if(anterior.version>0&&anterior.fuente===q.body.fuente){await c.query('COMMIT');return s.json(anterior);}
   const actualizado=await c.query(`INSERT INTO distribucion.vehiculo_fuente_gps(empresa_id,vehiculo_id,fuente,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id,vehiculo_id) DO UPDATE SET fuente=excluded.fuente,version=distribucion.vehiculo_fuente_gps.version+1,actualizado_en=now(),actor_id=excluded.actor_id RETURNING fuente,version,actualizado_en`,[q.actor.empresa_id,q.params.id,q.body.fuente,q.actor.id]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[q.actor.empresa_id,q.actor.id,'CAMBIAR_FUENTE_GPS',JSON.stringify({vehiculo_id:q.params.id,anterior:anterior.fuente,actual:q.body.fuente})]);await c.query('COMMIT');s.json({...anterior,...actualizado.rows[0]});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));return r;};
module.exports.preparar=preparar;module.exports.fuentes=fuentes;module.exports.permite=permite;
