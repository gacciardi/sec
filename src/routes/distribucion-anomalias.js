'use strict';
const express=require('express');
module.exports=db=>{
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 const tipos=['LUCES','FRENOS','NEUMATICOS','MOTOR','ELECTRICO','CARROCERIA','OTRO'];
 router.get('/anomalias-vehiculo',wrap(async(req,res)=>{
  const conductor=req.actor.rol==='CONDUCTOR'?req.actor.id:null;
  const r=await db.query(`SELECT a.*,m.nombre AS conductor_nombre,m.apellido AS conductor_apellido,r.despacho
   FROM distribucion.anomalias_vehiculo a
   JOIN distribucion.miembros m ON m.id=a.conductor_id AND m.empresa_id=a.empresa_id
   LEFT JOIN distribucion.repartos r ON r.id=a.reparto_id AND r.empresa_id=a.empresa_id
   WHERE a.empresa_id=$1 AND ($2::uuid IS NULL OR a.conductor_id=$2)
   ORDER BY CASE a.estado WHEN 'PENDIENTE' THEN 0 WHEN 'EN_REVISION' THEN 1 ELSE 2 END,a.creado_en DESC LIMIT 300`,[req.actor.empresa_id,conductor]);
  res.json(r.rows);
 }));
 router.post('/anomalias-vehiculo',wrap(async(req,res)=>{
  if(req.actor.rol!=='CONDUCTOR')throw fail('Solo conductores',403);
  const b=req.body||{},tipo=String(b.tipo||''),descripcion=String(b.descripcion||'').trim(),prioridad=String(b.prioridad||'NORMAL');
  if(!tipos.includes(tipo)||descripcion.length<5||descripcion.length>1500||!['NORMAL','URGENTE'].includes(prioridad))throw fail('Completá tipo y descripción de la anomalía');
  const lat=b.latitud==null?null:Number(b.latitud),lon=b.longitud==null?null:Number(b.longitud);
  if((lat!==null&&(!Number.isFinite(lat)||Math.abs(lat)>90))||(lon!==null&&(!Number.isFinite(lon)||Math.abs(lon)>180)))throw fail('Ubicación inválida');
  const r=await db.query('INSERT INTO distribucion.anomalias_vehiculo(empresa_id,conductor_id,tipo,descripcion,prioridad,latitud,longitud) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.actor.empresa_id,req.actor.id,tipo,descripcion,prioridad,lat,lon]);
  res.status(201).json(r.rows[0]);
 }));
 router.patch('/anomalias-vehiculo/:id',wrap(async(req,res)=>{
  if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol))throw fail('Acceso restringido',403);
  const estado=String(req.body?.estado||''),nota=String(req.body?.observacion_mantenimiento||'');
  if(!['PENDIENTE','EN_REVISION','RESUELTA'].includes(estado)||nota.length>1500)throw fail('Datos inválidos');
  const r=await db.query("UPDATE distribucion.anomalias_vehiculo SET estado=$3,observacion_mantenimiento=$4,actualizado_en=now(),resuelto_en=CASE WHEN $3='RESUELTA' THEN now() ELSE NULL END WHERE empresa_id=$1 AND id=$2 RETURNING *",[req.actor.empresa_id,req.params.id,estado,nota]);
  if(!r.rowCount)throw fail('Anomalía no encontrada',404);
  res.json(r.rows[0]);
 }));
 return router;
};
