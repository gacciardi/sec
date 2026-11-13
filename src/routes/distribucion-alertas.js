'use strict';
const express=require('express');
module.exports=function(db){
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 router.post('/alertas-conductor',wrap(async(req,res)=>{
  if(req.actor.rol!=='CONDUCTOR')throw fail('Solo conductores',403);
  const b=req.body||{},tipo=b.tipo,lat= b.latitud==null?null:Number(b.latitud),lon=b.longitud==null?null:Number(b.longitud);
  if(!['ROBO','MECANICO'].includes(tipo)||typeof b.es_prueba!=='boolean'||(lat!==null&&(!Number.isFinite(lat)||Math.abs(lat)>90))||(lon!==null&&(!Number.isFinite(lon)||Math.abs(lon)>180))||String(b.observacion||'').length>500)throw fail('Datos de alerta inválidos');
  const r=await db.query(`INSERT INTO distribucion.alertas_conductor(empresa_id,conductor_id,reparto_id,tipo,es_prueba,latitud,longitud,observacion)
   VALUES($1,$2,(SELECT id FROM distribucion.repartos WHERE id=$3 AND empresa_id=$1 AND conductor_id=$2),$4,$5,$6,$7,$8)
   RETURNING id,tipo,es_prueba,estado,creada_en`,[req.actor.empresa_id,req.actor.id,b.reparto_id||null,tipo,b.es_prueba,lat,lon,String(b.observacion||'')]);
  res.status(201).json(r.rows[0]);
 }));
 router.get('/alertas-conductor',wrap(async(req,res)=>{
  const r=await db.query(`SELECT a.*,m.nombre||' '||m.apellido AS conductor,r.despacho,v.interno,v.patente
   FROM distribucion.alertas_conductor a JOIN distribucion.miembros m ON m.id=a.conductor_id AND m.empresa_id=a.empresa_id
   LEFT JOIN distribucion.repartos r ON r.id=a.reparto_id AND r.empresa_id=a.empresa_id
   LEFT JOIN distribucion.vehiculos v ON v.id=r.principal_id AND v.empresa_id=r.empresa_id
   WHERE a.empresa_id=$1 AND ($2::uuid IS NULL OR a.conductor_id=$2::uuid)
   AND a.creada_en>now()-interval '30 days'
   ORDER BY a.creada_en DESC LIMIT 250`,[req.actor.empresa_id,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);
  res.json(r.rows);
 }));
 router.post('/alertas-conductor/:id/confirmar',wrap(async(req,res)=>{
  if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol))throw fail('Solo oficina',403);
  const r=await db.query(`UPDATE distribucion.alertas_conductor SET estado='CONFIRMADA',confirmada_en=now(),confirmada_por=$3
   WHERE id=$1 AND empresa_id=$2 AND estado='ENVIADA' RETURNING *`,[req.params.id,req.actor.empresa_id,req.actor.id]);
  if(!r.rowCount)throw fail('Alerta no pendiente',409);res.json(r.rows[0]);
 }));
 router.post('/alertas-conductor/:id/resolver',wrap(async(req,res)=>{
  if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol))throw fail('Solo oficina',403);
  const r=await db.query(`UPDATE distribucion.alertas_conductor SET estado='RESUELTA',resuelta_en=now(),resuelta_por=$3
   WHERE id=$1 AND empresa_id=$2 AND estado='CONFIRMADA' RETURNING *`,[req.params.id,req.actor.empresa_id,req.actor.id]);
  if(!r.rowCount)throw fail('Primero confirmar lectura',409);res.json(r.rows[0]);
 }));
 return router;
};
