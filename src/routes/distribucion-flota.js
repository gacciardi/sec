'use strict';
const express=require('express');
module.exports=db=>{
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 const office=(req,res,next)=>['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol)?next():next(fail('Acceso restringido',403));
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
 const validMoney=n=>Number.isFinite(n)&&n>=0&&Math.round(n*100)===n*100;
 router.get('/mantenimiento/trabajos',office,wrap(async(req,res)=>{
  const r=await db.query(`SELECT t.*,v.interno,v.patente,v.tipo AS tipo_vehiculo FROM distribucion.mantenimiento_trabajos t
   JOIN distribucion.vehiculos v ON v.id=t.vehiculo_id AND v.empresa_id=t.empresa_id
   WHERE t.empresa_id=$1 ORDER BY t.fecha DESC,t.id DESC LIMIT 500`,[req.actor.empresa_id]);res.json(r.rows);
 }));
 router.post('/mantenimiento/trabajos',office,wrap(async(req,res)=>{
  const b=req.body||{},tipo=String(b.tipo||''),sistema=String(b.sistema||'').trim(),trabajo=String(b.trabajo_realizado||'').trim(),costo=Number(b.costo||0),km=b.kilometraje===''||b.kilometraje==null?null:Number(b.kilometraje),prox=b.proximo_servicio_km===''||b.proximo_servicio_km==null?null:Number(b.proximo_servicio_km);
  if(!validDate(b.fecha)||!['PREVENTIVO','CORRECTIVO'].includes(tipo)||!sistema||sistema.length>60||!trabajo||trabajo.length>3000||!validMoney(costo)||(km!==null&&(!Number.isFinite(km)||km<0))||(prox!==null&&(!Number.isFinite(prox)||prox<0))||(b.proximo_servicio_fecha&&!validDate(b.proximo_servicio_fecha)))throw fail('Datos del mantenimiento inválidos');
  const r=await db.query(`INSERT INTO distribucion.mantenimiento_trabajos(empresa_id,vehiculo_id,anomalia_id,fecha,tipo,sistema,falla,trabajo_realizado,repuestos,taller,kilometraje,costo,proximo_servicio_fecha,proximo_servicio_km,registrado_por)
   SELECT $1,v.id,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15 FROM distribucion.vehiculos v WHERE v.id=$2 AND v.empresa_id=$1
   RETURNING *`,[req.actor.empresa_id,b.vehiculo_id,b.anomalia_id||null,b.fecha,tipo,sistema,String(b.falla||'').slice(0,3000),trabajo,String(b.repuestos||'').slice(0,3000),String(b.taller||'').slice(0,150),km,costo,b.proximo_servicio_fecha||null,prox,req.actor.id]);
  if(!r.rowCount)throw fail('Vehículo no encontrado',404);res.status(201).json(r.rows[0]);
 }));
 router.get('/combustible/cargas',office,wrap(async(req,res)=>{
  const r=await db.query(`SELECT c.*,v.interno,v.patente FROM distribucion.combustible_cargas c JOIN distribucion.vehiculos v ON v.id=c.vehiculo_id AND v.empresa_id=c.empresa_id WHERE c.empresa_id=$1 ORDER BY c.fecha DESC,c.id DESC LIMIT 500`,[req.actor.empresa_id]);res.json(r.rows);
 }));
 router.post('/combustible/cargas',office,wrap(async(req,res)=>{
  const b=req.body||{},litros=Number(b.litros),km=b.kilometros_periodo===''||b.kilometros_periodo==null?null:Number(b.kilometros_periodo),od=b.odometro===''||b.odometro==null?null:Number(b.odometro),costo=b.costo===''||b.costo==null?null:Number(b.costo);
  if(!validDate(b.fecha)||!Number.isFinite(litros)||litros<=0||(km!==null&&(!Number.isFinite(km)||km<=0))||(od!==null&&(!Number.isFinite(od)||od<0))||(costo!==null&&!validMoney(costo)))throw fail('Datos de combustible inválidos');
  const r=await db.query(`INSERT INTO distribucion.combustible_cargas(empresa_id,vehiculo_id,fecha,litros,kilometros_periodo,odometro,costo,observacion,registrado_por)
   SELECT $1,v.id,$3::date,$4,$5,$6,$7,$8,$9 FROM distribucion.vehiculos v WHERE v.id=$2 AND v.empresa_id=$1 RETURNING *`,[req.actor.empresa_id,b.vehiculo_id,b.fecha,litros,km,od,costo,String(b.observacion||'').slice(0,1000),req.actor.id]);
  if(!r.rowCount)throw fail('Vehículo no encontrado',404);res.status(201).json(r.rows[0]);
 }));
 return router;
};
