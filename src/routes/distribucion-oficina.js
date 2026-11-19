"use strict";
const express=require('express'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const id=v=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v);
const texto=(v,max,obligatorio=false)=>{if(v==null&&!obligatorio)return '';if(typeof v!=='string'||v.trim().length>max||(obligatorio&&!v.trim()))throw fail('Texto incompleto o demasiado largo');return v.trim();};
function validarSolicitud(b){
 if(!b||!uuid(b.reparto_id)||!uuid(b.solicitud_clave)||b.cliente_confirmado!==true||!['MERCADERIA','COBRANZA','OTRO'].includes(b.motivo))throw fail('Confirmá cliente, reparto y motivo');
 const codigo=texto(b.codigo_cliente,100,true),observacion=texto(b.observacion,500);
 const lat=b.latitud==null?null:Number(b.latitud),lon=b.longitud==null?null:Number(b.longitud);
 if((lat===null)!==(lon===null)||(lat!==null&&(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180)))throw fail('Ubicación inválida');
 return {...b,reparto_id:b.reparto_id.toLowerCase(),solicitud_clave:b.solicitud_clave.toLowerCase(),codigo_cliente:codigo,observacion,latitud:lat,longitud:lon};
}
module.exports=db=>{
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 // Migración aditiva e idempotente; un error deshabilita este módulo, no las alertas existentes.
 const schemaReady=Promise.resolve().then(()=>db.query(fs.readFileSync(path.join(__dirname,'../../migrations/20261116_llamar_oficina.sql'),'utf8')));
 schemaReady.catch(e=>console.error('Esquema llamar oficina:',e.code||'no disponible'));
 const ready=async(req,res,next)=>{try{await schemaReady;next();}catch{next(fail('Comunicación con oficina pendiente de habilitar en el servidor',503));}};
 const oficina=(req,res,next)=>['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol)?next():next(fail('Solo oficina',403));
 const admin=(req,res,next)=>req.actor.rol==='ADMIN'?next():next(fail('Solo administradores',403));
 const conductor=(req,res,next)=>req.actor.rol==='CONDUCTOR'?next():next(fail('Solo conductores',403));
 const auditar=(c,a,accion,detalle)=>c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[a.empresa_id,a.id,accion,JSON.stringify(detalle)]);
 const transaccion=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 router.get('/oficina/respuestas',ready,wrap(async(req,res)=>{
  if(!['ADMIN','SUPERVISOR','OPERADOR','CONDUCTOR'].includes(req.actor.rol))throw fail('Acceso restringido',403);
  const r=await db.query('SELECT id,codigo,nombre,activo FROM distribucion.oficina_respuestas WHERE empresa_id=$1 '+(req.actor.rol==='ADMIN'?'':'AND activo=true ')+'ORDER BY nombre,id',[req.actor.empresa_id]);res.set('Cache-Control','no-store').json(r.rows);
 }));
 router.post('/oficina/respuestas',admin,ready,wrap(async(req,res)=>{
  const nombre=texto(req.body?.nombre,120,true),r=await transaccion(async c=>{const r=await c.query('INSERT INTO distribucion.oficina_respuestas(empresa_id,codigo,nombre) VALUES($1,$2,$3) RETURNING id,nombre,activo',[req.actor.empresa_id,'R_'+crypto.randomUUID(),nombre]);await auditar(c,req.actor,'ALTA_RESPUESTA_OFICINA',{id:r.rows[0].id,nombre});return r.rows[0];});res.status(201).json(r);
 }));
 router.put('/oficina/respuestas/:id',admin,ready,wrap(async(req,res)=>{
  if(!id(req.params.id)||typeof req.body?.activo!=='boolean')throw fail('Respuesta inválida');const nombre=texto(req.body.nombre,120,true);
  const r=await transaccion(async c=>{const r=await c.query('UPDATE distribucion.oficina_respuestas SET nombre=$3,activo=$4,actualizado_en=now() WHERE empresa_id=$1 AND id=$2 RETURNING id,nombre,activo',[req.actor.empresa_id,req.params.id,nombre,req.body.activo]);if(!r.rowCount)throw fail('Respuesta no encontrada',404);await auditar(c,req.actor,'EDITAR_RESPUESTA_OFICINA',{id:req.params.id,nombre,activo:req.body.activo});return r.rows[0];});res.json(r);
 }));
 router.post('/oficina/solicitudes',conductor,ready,wrap(async(req,res)=>{
  const b=validarSolicitud(req.body),a=req.actor;
  const result=await transaccion(async c=>{
   const p=await c.query(`SELECT r.id,coalesce(p.nombre_cliente,p.codigo_cliente) AS nombre_cliente FROM distribucion.repartos r JOIN distribucion.pedidos p ON p.reparto_id=r.id AND p.empresa_id=r.empresa_id
    WHERE r.empresa_id=$1 AND r.id=$2 AND r.conductor_id=$3 AND p.codigo_cliente=$4 AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date ORDER BY p.numero LIMIT 1 FOR SHARE OF r`,[a.empresa_id,b.reparto_id,a.id,b.codigo_cliente]);
   if(!p.rowCount)throw fail('El cliente no pertenece a un reparto tuyo de hoy',403);
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[a.empresa_id+'|'+a.id+'|'+b.reparto_id+'|'+b.codigo_cliente]);
   const anterior=await c.query(`SELECT * FROM distribucion.oficina_solicitudes WHERE empresa_id=$1 AND conductor_id=$2 AND (solicitud_clave=$3 OR (reparto_id=$4 AND codigo_cliente=$5 AND estado IN ('ENVIADA','CONFIRMADA'))) ORDER BY id DESC LIMIT 1 FOR UPDATE`,[a.empresa_id,a.id,b.solicitud_clave,b.reparto_id,b.codigo_cliente]);
   if(anterior.rowCount){const x=anterior.rows[0];if(x.reparto_id!==b.reparto_id||x.codigo_cliente!==b.codigo_cliente)throw fail('Solicitud ya utilizada para otro cliente',409);return {solicitud:x,reutilizada:true};}
   const r=await c.query(`INSERT INTO distribucion.oficina_solicitudes(empresa_id,conductor_id,reparto_id,codigo_cliente,nombre_cliente,solicitud_clave,motivo,observacion,latitud,longitud) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.empresa_id,a.id,b.reparto_id,b.codigo_cliente,p.rows[0].nombre_cliente,b.solicitud_clave,b.motivo,b.observacion,b.latitud,b.longitud]);
   await auditar(c,a,'LLAMAR_OFICINA',{solicitud_id:r.rows[0].id,reparto_id:b.reparto_id,codigo_cliente:b.codigo_cliente,motivo:b.motivo});return {solicitud:r.rows[0],reutilizada:false};
  });res.status(result.reutilizada?200:201).json(result);
 }));
 router.get('/oficina/solicitudes',ready,wrap(async(req,res)=>{
  const a=req.actor,esConductor=a.rol==='CONDUCTOR';if(!esConductor&&!['ADMIN','SUPERVISOR','OPERADOR'].includes(a.rol))throw fail('Acceso restringido',403);
  const pendientes=req.query.pendientes==='1',recepcion=!esConductor&&req.query.recepcion==='1';
  const condicion=recepcion?"AND (s.estado IN ('ENVIADA','CONFIRMADA') OR s.creada_en>now()-interval '24 hours')":pendientes?(esConductor?"AND (s.estado<>'RESPONDIDA' OR s.leida_conductor_en IS NULL)":"AND s.estado IN ('ENVIADA','CONFIRMADA')") : "AND (s.creada_en>now()-interval '30 days' OR s.estado<>'RESPONDIDA' OR s.leida_conductor_en IS NULL)";
  const r=await db.query(`SELECT s.*,m.nombre||' '||m.apellido AS conductor,r.despacho,v.interno,v.patente,o.nombre||' '||o.apellido AS respondida_nombre
   FROM distribucion.oficina_solicitudes s JOIN distribucion.miembros m ON m.id=s.conductor_id AND m.empresa_id=s.empresa_id
   JOIN distribucion.repartos r ON r.id=s.reparto_id AND r.empresa_id=s.empresa_id
   LEFT JOIN distribucion.vehiculos v ON v.id=r.principal_id AND v.empresa_id=r.empresa_id
   LEFT JOIN distribucion.miembros o ON o.id=s.respondida_por AND o.empresa_id=s.empresa_id
   WHERE s.empresa_id=$1 AND ($2::uuid IS NULL OR s.conductor_id=$2::uuid) ${condicion} ORDER BY s.creada_en DESC ${pendientes||recepcion?'':'LIMIT 500'}`,[a.empresa_id,esConductor?a.id:null]);res.set('Cache-Control','no-store').json(r.rows);
 }));
 router.post('/oficina/solicitudes/:id/confirmar',oficina,ready,wrap(async(req,res)=>{
  if(!id(req.params.id))throw fail('Solicitud inválida');const r=await transaccion(async c=>{const r=await c.query(`UPDATE distribucion.oficina_solicitudes SET estado='CONFIRMADA',confirmada_en=now(),confirmada_por=$3 WHERE empresa_id=$1 AND id=$2 AND estado='ENVIADA' RETURNING *`,[req.actor.empresa_id,req.params.id,req.actor.id]);if(!r.rowCount)throw fail('Solicitud ya confirmada o respondida. Actualizá la lista.',409);await auditar(c,req.actor,'CONFIRMAR_LLAMADO_OFICINA',{solicitud_id:req.params.id});return r.rows[0];});res.json(r);
 }));
 router.post('/oficina/solicitudes/:id/responder',oficina,ready,wrap(async(req,res)=>{
  if(!id(req.params.id)||!id(String(req.body?.respuesta_id||'')))throw fail('Seleccionar una respuesta');const observacion=texto(req.body?.observacion,500);
  const r=await transaccion(async c=>{const opcion=await c.query('SELECT id,nombre FROM distribucion.oficina_respuestas WHERE empresa_id=$1 AND id=$2 AND activo=true FOR SHARE',[req.actor.empresa_id,req.body.respuesta_id]);if(!opcion.rowCount)throw fail('La opción ya no está disponible; elegí otra');
   const r=await c.query(`UPDATE distribucion.oficina_solicitudes SET estado='RESPONDIDA',confirmada_en=coalesce(confirmada_en,now()),confirmada_por=coalesce(confirmada_por,$3),respuesta_id=$4,respuesta_nombre=$5,respuesta_observacion=$6,respondida_en=now(),respondida_por=$3
    WHERE empresa_id=$1 AND id=$2 AND estado IN ('ENVIADA','CONFIRMADA') RETURNING *`,[req.actor.empresa_id,req.params.id,req.actor.id,opcion.rows[0].id,opcion.rows[0].nombre,observacion]);if(!r.rowCount)throw fail('Otra persona ya respondió esta solicitud. Actualizá la lista.',409);await auditar(c,req.actor,'RESPONDER_LLAMADO_OFICINA',{solicitud_id:req.params.id,respuesta_id:opcion.rows[0].id,respuesta:opcion.rows[0].nombre});return r.rows[0];});res.json(r);
 }));
 router.post('/oficina/solicitudes/:id/leida',conductor,ready,wrap(async(req,res)=>{
  if(!id(req.params.id))throw fail('Solicitud inválida');const r=await transaccion(async c=>{const r=await c.query(`UPDATE distribucion.oficina_solicitudes SET leida_conductor_en=coalesce(leida_conductor_en,now()) WHERE empresa_id=$1 AND id=$2 AND conductor_id=$3 AND estado='RESPONDIDA' RETURNING *`,[req.actor.empresa_id,req.params.id,req.actor.id]);if(!r.rowCount)throw fail('Respuesta no disponible',404);await auditar(c,req.actor,'LEER_RESPUESTA_OFICINA',{solicitud_id:req.params.id});return r.rows[0];});res.json(r);
 }));
 return router;
};
module.exports._test={validarSolicitud,uuid,id,texto};
