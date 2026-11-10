// Módulo opcional. Montar después de ejecutar sql/distribucion_horarios_recepcion_20261110.sql.
// Requiere req.actor y autenticación previa del router Distribución.
const express=require('express');
module.exports=function horarios(db){
 const r=express.Router();
 const admin=(req,res,next)=>['ADMIN','SUPERVISOR'].includes(req.actor?.rol)?next():res.status(403).json({error:'Acceso restringido'});
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const validar=b=>{
  const dia=Number(b.dia_semana),min=Number(b.minutos_descarga??15);
  const hora=x=>typeof x==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  if(!Number.isInteger(dia)||dia<0||dia>6||!hora(b.apertura_1)||!hora(b.cierre_1)||b.apertura_1>=b.cierre_1||!Number.isInteger(min)||min<0||min>480)throw Object.assign(new Error('Horario, día o descarga inválidos'),{status:400});
  if((b.apertura_2||b.cierre_2)&&(!hora(b.apertura_2)||!hora(b.cierre_2)||b.apertura_2>=b.cierre_2||b.apertura_2<b.cierre_1))throw Object.assign(new Error('Segundo turno inválido'),{status:400});
  return [dia,b.apertura_1,b.cierre_1,b.apertura_2||null,b.cierre_2||null,min,String(b.observaciones||'').slice(0,1000)];
 };
 r.get('/horarios-recepcion',wrap(async(req,res)=>{
  const q=await db.query('SELECT codigo_cliente,dia_semana,apertura_1,cierre_1,apertura_2,cierre_2,minutos_descarga,observaciones FROM distribucion.horarios_recepcion WHERE empresa_id=$1 AND ($2::text IS NULL OR codigo_cliente=$2) ORDER BY codigo_cliente,dia_semana',[req.actor.empresa_id,req.query.codigo_cliente||null]);res.json(q.rows);
 }));
 r.put('/horarios-recepcion/:codigo',admin,wrap(async(req,res)=>{
  const codigo=String(req.params.codigo).trim();if(!codigo||codigo.length>100)return res.status(400).json({error:'Cliente inválido'});
  const v=validar(req.body);
  const q=await db.query(`INSERT INTO distribucion.horarios_recepcion(empresa_id,codigo_cliente,dia_semana,apertura_1,cierre_1,apertura_2,cierre_2,minutos_descarga,observaciones) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(empresa_id,codigo_cliente,dia_semana) DO UPDATE SET apertura_1=EXCLUDED.apertura_1,cierre_1=EXCLUDED.cierre_1,apertura_2=EXCLUDED.apertura_2,cierre_2=EXCLUDED.cierre_2,minutos_descarga=EXCLUDED.minutos_descarga,observaciones=EXCLUDED.observaciones,actualizado_en=now() RETURNING *`,[req.actor.empresa_id,codigo,...v]);res.json(q.rows[0]);
 }));
 r.post('/propuestas-horarios',wrap(async(req,res)=>{
  if(req.actor.rol!=='CONDUCTOR')return res.status(403).json({error:'Solo conductores'});
  const codigo=String(req.body.codigo_cliente||'').trim();if(!codigo||codigo.length>100)return res.status(400).json({error:'Cliente inválido'});
  const existe=await db.query(`SELECT 1 FROM distribucion.pedidos p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id WHERE p.empresa_id=$1 AND r.conductor_id=$2 AND p.codigo_cliente=$3 AND p.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date LIMIT 1`,[req.actor.empresa_id,req.actor.id,codigo]);
  if(!existe.rowCount)return res.status(403).json({error:'Cliente no asignado hoy'});
  const v=validar(req.body);
  const q=await db.query(`INSERT INTO distribucion.propuestas_horarios(empresa_id,codigo_cliente,conductor_id,dia_semana,apertura_1,cierre_1,apertura_2,cierre_2,minutos_descarga,observaciones) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,estado`,[req.actor.empresa_id,codigo,req.actor.id,...v]);res.status(201).json(q.rows[0]);
 }));
 r.get('/propuestas-horarios',admin,wrap(async(req,res)=>{
  const q=await db.query(`SELECT p.*,m.nombre,m.apellido FROM distribucion.propuestas_horarios p JOIN distribucion.miembros m ON m.id=p.conductor_id AND m.empresa_id=p.empresa_id WHERE p.empresa_id=$1 AND p.estado='PENDIENTE' ORDER BY p.creado_en DESC`,[req.actor.empresa_id]);res.json(q.rows);
 }));
 r.post('/propuestas-horarios/:id/resolver',admin,wrap(async(req,res)=>{
  if(!['APROBADO','RECHAZADO'].includes(req.body.estado))return res.status(400).json({error:'Estado inválido'});
  const c=await db.connect();try{await c.query('BEGIN');const q=await c.query('SELECT * FROM distribucion.propuestas_horarios WHERE id=$1 AND empresa_id=$2 AND estado=\'PENDIENTE\' FOR UPDATE',[req.params.id,req.actor.empresa_id]);if(!q.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'Propuesta ya resuelta o inexistente'});}const p=q.rows[0];
   if(req.body.estado==='APROBADO')await c.query(`INSERT INTO distribucion.horarios_recepcion(empresa_id,codigo_cliente,dia_semana,apertura_1,cierre_1,apertura_2,cierre_2,minutos_descarga,observaciones) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(empresa_id,codigo_cliente,dia_semana) DO UPDATE SET apertura_1=EXCLUDED.apertura_1,cierre_1=EXCLUDED.cierre_1,apertura_2=EXCLUDED.apertura_2,cierre_2=EXCLUDED.cierre_2,minutos_descarga=EXCLUDED.minutos_descarga,observaciones=EXCLUDED.observaciones,actualizado_en=now()`,[p.empresa_id,p.codigo_cliente,p.dia_semana,p.apertura_1,p.cierre_1,p.apertura_2,p.cierre_2,p.minutos_descarga,p.observaciones]);
   await c.query('UPDATE distribucion.propuestas_horarios SET estado=$3,revisado_en=now(),revisado_por=$4 WHERE id=$1 AND empresa_id=$2',[p.id,p.empresa_id,req.body.estado,req.actor.id]);await c.query('COMMIT');res.json({ok:true,estado:req.body.estado});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 return r;
};
