'use strict';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail=(s,status=400)=>Object.assign(Error(s),{status});
function fecha(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&s>='2000-01-01'&&s<='2100-12-31'&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
function validar(b){
 if(!uuid.test(b.vehiculo_id||'')||!fecha(b.fecha)||!['EXTERIOR','INTERIOR','COMPLETO'].includes(b.tipo))throw fail('Seleccioná unidad, fecha válida y tipo de lavado.');
 const costo=b.costo===''||b.costo==null?null:String(b.costo);
 if(costo!==null&&(!/^\d{1,10}(?:\.\d{1,2})?$/.test(costo)||!Number.isFinite(Number(costo))))throw fail('El costo debe ser mayor o igual a cero y tener hasta dos decimales.');
 if(typeof b.lugar!=='string'||b.lugar.trim().length>150||typeof b.observacion!=='string'||b.observacion.trim().length>1000)throw fail('Revisá el lugar y la observación.');
 return {vehiculo_id:b.vehiculo_id,fecha:b.fecha,tipo:b.tipo,lugar:b.lugar.trim(),costo,observacion:b.observacion.trim()};
}
module.exports=db=>{
 const r=require('express').Router(),wrap=f=>(q,s,n)=>Promise.resolve(f(q,s)).catch(n);let ready;
 async function iniciar(){if(!ready)ready=db.query(`CREATE TABLE IF NOT EXISTS distribucion.lavados_vehiculo(id uuid PRIMARY KEY,empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),vehiculo_id uuid NOT NULL REFERENCES distribucion.vehiculos(id),fecha date NOT NULL,tipo text NOT NULL CHECK(tipo IN('EXTERIOR','INTERIOR','COMPLETO')),lugar varchar(150) NOT NULL DEFAULT '',costo numeric(12,2) CHECK(costo>=0),observacion varchar(1000) NOT NULL DEFAULT '',registrado_por uuid NOT NULL,creado_en timestamptz NOT NULL DEFAULT now(),actualizado_en timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1);CREATE INDEX IF NOT EXISTS idx_lavados_empresa_fecha ON distribucion.lavados_vehiculo(empresa_id,fecha DESC,vehiculo_id);`).catch(e=>{ready=null;throw e;});await ready;}
 r.use('/lavados',(q,s,n)=>{s.set('Cache-Control','no-store');return ['ADMIN','SUPERVISOR','OPERADOR','MECANICO'].includes(q.actor?.rol)?n():n(fail('Acceso restringido',403));});
 r.get('/lavados',wrap(async(q,s)=>{
  const {desde,hasta,vehiculo_id}=q.query;if(desde&&!fecha(desde)||hasta&&!fecha(hasta)||desde&&hasta&&desde>hasta||vehiculo_id&&!uuid.test(vehiculo_id))throw fail('Revisá los filtros de fecha y unidad.');
  const pagina=Number(q.query.pagina||1);if(!Number.isInteger(pagina)||pagina<1||pagina>100000)throw fail('Página inválida.');await iniciar();
  const args=[q.actor.empresa_id,vehiculo_id||null,desde||null,hasta||null],filtro='l.empresa_id=$1 AND ($2::uuid IS NULL OR l.vehiculo_id=$2) AND ($3::date IS NULL OR l.fecha >= $3) AND ($4::date IS NULL OR l.fecha <= $4)';
  const resumen=await db.query('SELECT count(*)::int AS cantidad,COALESCE(sum(l.costo),0) AS costo_total,count(*) FILTER(WHERE l.costo IS NULL)::int AS sin_costo FROM distribucion.lavados_vehiculo l WHERE '+filtro,args);
  const filas=await db.query(`SELECT l.*,l.fecha::text AS fecha,v.interno,v.patente,v.tipo AS tipo_vehiculo,concat_ws(' ',m.nombre,m.apellido) AS registrado_nombre FROM distribucion.lavados_vehiculo l JOIN distribucion.vehiculos v ON v.id=l.vehiculo_id AND v.empresa_id=l.empresa_id LEFT JOIN distribucion.miembros m ON m.id=l.registrado_por AND m.empresa_id=l.empresa_id WHERE ${filtro} ORDER BY l.fecha DESC,l.creado_en DESC,l.id LIMIT 50 OFFSET $5`,[...args,(pagina-1)*50]);
  s.json({registros:filas.rows,pagina,...resumen.rows[0]});
 }));
 async function guardar(q,s){
  const b=validar(q.body||{}),editar=!!q.params.id;if(editar&&(!uuid.test(q.params.id)||!Number.isInteger(q.body.version)||q.body.version<1))throw fail('Registro o versión inválidos.');await iniciar();const c=await db.connect();
  try{await c.query('BEGIN');const v=await c.query('SELECT id FROM distribucion.vehiculos WHERE id=$1 AND empresa_id=$2',[b.vehiculo_id,q.actor.empresa_id]);if(!v.rowCount)throw fail('Unidad no disponible en esta empresa.',404);
   let anterior=null;const id=q.params.id||require('node:crypto').randomUUID();if(editar){const a=await c.query('SELECT * FROM distribucion.lavados_vehiculo WHERE id=$1 AND empresa_id=$2 FOR UPDATE',[id,q.actor.empresa_id]);if(!a.rowCount)throw fail('Lavado no encontrado.',404);anterior=a.rows[0];if(anterior.version!==q.body.version)throw fail('Otro usuario modificó este lavado. Actualizá el historial antes de editar.',409);}
   const args=[id,q.actor.empresa_id,b.vehiculo_id,b.fecha,b.tipo,b.lugar,b.costo,b.observacion,q.actor.id];
   if(editar)await c.query('UPDATE distribucion.lavados_vehiculo SET vehiculo_id=$3,fecha=$4::date,tipo=$5,lugar=$6,costo=$7,observacion=$8,version=version+1,actualizado_en=now() WHERE id=$1 AND empresa_id=$2',args.slice(0,8));
   else await c.query('INSERT INTO distribucion.lavados_vehiculo(id,empresa_id,vehiculo_id,fecha,tipo,lugar,costo,observacion,registrado_por) VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9)',args);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[q.actor.empresa_id,q.actor.id,editar?'MODIFICAR_LAVADO':'REGISTRAR_LAVADO',JSON.stringify({id,anterior,actual:b})]);await c.query('COMMIT');s.status(editar?200:201).json({ok:true,id});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 r.post('/lavados',wrap(guardar));r.put('/lavados/:id',wrap(guardar));return r;
};
module.exports.validar=validar;module.exports.fecha=fecha;
