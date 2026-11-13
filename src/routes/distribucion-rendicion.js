'use strict';
const express=require('express');
module.exports=function(db){
 const router=express.Router();
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 const office=(req,res,next)=>req.actor.rol==='ADMIN'||req.actor.rol==='SUPERVISOR'?next():next(fail('Acceso restringido',403));
 const administrator=(req,res,next)=>req.actor.rol==='ADMIN'?next():next(fail('Solo administradores',403));
 const config={
  motivos:{table:'motivos_rechazo',fields:['codigo','nombre','area_responsable','orden'],classes:['COMERCIAL','DISTRIBUCION','BODEGA','CLIENTE','OTROS']},
  medios:{table:'medios_cobranza',fields:['codigo','nombre','clasificacion','orden'],classes:['EFECTIVO','DIGITAL','CHEQUE','OTRO']}
 };
 const spec=req=>{const c=config[req.params.tipo];if(!c)throw fail('Catálogo desconocido',404);return c;};
 router.get('/rendicion/catalogos/:tipo',wrap(async(req,res)=>{
  const c=spec(req),r=await db.query('SELECT * FROM distribucion.'+c.table+' WHERE empresa_id=$1 '+(req.actor.rol==='CONDUCTOR'?'AND activo=true ':'')+'ORDER BY orden,nombre',[req.actor.empresa_id]);res.json(r.rows);
 }));
 router.post('/rendicion/catalogos/:tipo',administrator,wrap(async(req,res)=>{
  const c=spec(req),b=req.body||{},codigo=String(b.codigo||'').trim().toUpperCase(),nombre=String(b.nombre||'').trim(),clase=String(b[c.fields[2]]||'').trim().toUpperCase(),orden=Number(b.orden??100);
  if(!/^[A-Z0-9_]{2,30}$/.test(codigo)||!nombre||nombre.length>150||!c.classes.includes(clase)||!Number.isInteger(orden)||orden<0||orden>9999)throw fail('Datos de catálogo inválidos');
  const r=await db.query('INSERT INTO distribucion.'+c.table+' (empresa_id,codigo,nombre,'+c.fields[2]+',orden) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.actor.empresa_id,codigo,nombre,clase,orden]);
  res.status(201).json(r.rows[0]);
 }));
 router.put('/rendicion/catalogos/:tipo/:id',administrator,wrap(async(req,res)=>{
  const c=spec(req),b=req.body||{},codigo=String(b.codigo||'').trim().toUpperCase(),nombre=String(b.nombre||'').trim(),clase=String(b[c.fields[2]]||'').trim().toUpperCase(),orden=Number(b.orden);
  if(!/^[A-Z0-9_]{2,30}$/.test(codigo)||!nombre||nombre.length>150||!c.classes.includes(clase)||!Number.isInteger(orden)||orden<0||orden>9999||typeof b.activo!=='boolean')throw fail('Datos de catálogo inválidos');
  const r=await db.query('UPDATE distribucion.'+c.table+' SET codigo=$3,nombre=$4,'+c.fields[2]+'=$5,orden=$6,activo=$7,actualizado_en=now() WHERE empresa_id=$1 AND id=$2 RETURNING *',[req.actor.empresa_id,req.params.id,codigo,nombre,clase,orden,b.activo]);
  if(!r.rowCount)throw fail('Registro no encontrado',404);res.json(r.rows[0]);
 }));
 // Estado económico persistido, limitado por empresa y reparto asignado.
 router.get('/rendicion/entregas',wrap(async(req,res)=>{
  const r=await db.query(`SELECT e.*,r.fecha,r.despacho,r.conductor_id
   FROM distribucion.rendicion_entregas e
   JOIN distribucion.repartos r ON r.id=e.reparto_id AND r.empresa_id=e.empresa_id
   WHERE e.empresa_id=$1 AND ($2::date IS NULL OR r.fecha=$2::date)
   AND ($3::uuid IS NULL OR r.conductor_id=$3::uuid)
   ORDER BY r.fecha DESC,r.despacho,e.codigo_cliente`,
   [req.actor.empresa_id,req.query.fecha||null,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);res.json(r.rows);
 }));
 router.get('/rendicion/cobros',wrap(async(req,res)=>{
  const r=await db.query(`SELECT c.*,e.reparto_id,e.codigo_cliente,r.fecha,r.despacho
   FROM distribucion.rendicion_cobros c
   JOIN distribucion.rendicion_entregas e ON e.id=c.rendicion_entrega_id AND e.empresa_id=c.empresa_id
   JOIN distribucion.repartos r ON r.id=e.reparto_id AND r.empresa_id=e.empresa_id
   WHERE c.empresa_id=$1 AND ($2::date IS NULL OR r.fecha=$2::date)
   AND ($3::uuid IS NULL OR r.conductor_id=$3::uuid)
   ORDER BY c.registrado_en DESC`,[req.actor.empresa_id,req.query.fecha||null,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);res.json(r.rows);
 }));
 // Actualización atómica: cobros y entrega deben conciliar, no se alteran pedidos importados.
 router.post('/rendicion/entregas',wrap(async(req,res)=>{
  if(!['CONDUCTOR','ADMIN','SUPERVISOR'].includes(req.actor.rol))throw fail('Acceso restringido',403);
  const b=req.body||{},estado=b.estado,entregado=Number(b.importe_entregado),cobros=b.cobros;
  if(!['ENTREGADO','PARCIAL','RECHAZADO'].includes(estado)||!Array.isArray(cobros)||cobros.length>8||!Number.isFinite(entregado)||entregado<0||!Number.isInteger(Math.round(entregado*100))||!b.reparto_id||!b.codigo_cliente)throw fail('Datos de rendición inválidos');
  const c=await db.connect();
  try{
   await c.query('BEGIN');
   const rr=await c.query('SELECT id FROM distribucion.repartos WHERE id=$1 AND empresa_id=$2 AND ($3::uuid IS NULL OR conductor_id=$3::uuid) FOR UPDATE',[b.reparto_id,req.actor.empresa_id,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);
   if(!rr.rowCount)throw fail('Reparto no autorizado',403);
   const cierre=await c.query('SELECT cc.id FROM distribucion.cierres_caja_conductor cc JOIN distribucion.repartos rp ON rp.conductor_id=cc.conductor_id AND rp.fecha=cc.fecha AND rp.empresa_id=cc.empresa_id WHERE rp.id=$1 AND cc.empresa_id=$2 LIMIT 1',[b.reparto_id,req.actor.empresa_id]);
   if(cierre.rowCount)throw fail('La caja del conductor está cerrada. Solicitá revisión a supervisión antes de modificar la rendición.',409);
   const p=await c.query('SELECT COALESCE(SUM(importe),0)::numeric AS total,COUNT(*)::int AS cantidad FROM distribucion.pedidos WHERE empresa_id=$1 AND reparto_id=$2 AND codigo_cliente=$3',[req.actor.empresa_id,b.reparto_id,String(b.codigo_cliente)]);
   if(!p.rows[0].cantidad)throw fail('Cliente sin pedidos en el reparto',404);
   const total=Number(p.rows[0].total),centavos=n=>Math.round(Number(n)*100);
   if(!Number.isFinite(total)||total<0||centavos(entregado)>centavos(total))throw fail('Importe entregado fuera de rango');
   if((estado==='ENTREGADO'&&centavos(entregado)!==centavos(total))||(estado==='RECHAZADO'&&centavos(entregado)!==0)||(estado==='PARCIAL'&&(centavos(entregado)<=0||centavos(entregado)>=centavos(total))))throw fail('Estado e importe no coinciden');
   let motivo=null;
   if(estado!=='ENTREGADO'){
    const m=await c.query('SELECT id,nombre FROM distribucion.motivos_rechazo WHERE id=$1 AND empresa_id=$2 AND activo=true',[b.motivo_rechazo_id||null,req.actor.empresa_id]);
    if(!m.rowCount)throw fail('Seleccionar motivo de rechazo vigente');motivo=m.rows[0];
   }
   let suma=0;const medios=[];
   for(const pago of cobros){
    const importe=Number(pago.importe);
    if(!Number.isFinite(importe)||centavos(importe)<=0||centavos(importe)!==importe*100||String(pago.referencia||'').length>150)throw fail('Cobro inválido');
    const m=await c.query('SELECT id,nombre,clasificacion FROM distribucion.medios_cobranza WHERE id=$1 AND empresa_id=$2 AND activo=true',[pago.medio_cobranza_id,req.actor.empresa_id]);
    if(!m.rowCount)throw fail('Medio de cobranza inválido');
    medios.push({...m.rows[0],importe,referencia:String(pago.referencia||'')});suma+=centavos(importe);
   }
   if(suma>centavos(entregado))throw fail('Los cobros superan la mercadería entregada');
   const v=await c.query(`INSERT INTO distribucion.rendicion_entregas(empresa_id,reparto_id,codigo_cliente,estado,motivo_rechazo_id,motivo_rechazo_nombre,importe_original,importe_entregado,observacion,actualizado_por)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT(empresa_id,reparto_id,codigo_cliente) DO UPDATE SET estado=excluded.estado,motivo_rechazo_id=excluded.motivo_rechazo_id,motivo_rechazo_nombre=excluded.motivo_rechazo_nombre,importe_original=excluded.importe_original,importe_entregado=excluded.importe_entregado,observacion=excluded.observacion,actualizado_por=excluded.actualizado_por,actualizado_en=now() RETURNING *`,
   [req.actor.empresa_id,b.reparto_id,String(b.codigo_cliente),estado,motivo?.id||null,motivo?.nombre||null,total,entregado,String(b.observacion||'').slice(0,3000),req.actor.id]);
   await c.query('DELETE FROM distribucion.rendicion_cobros WHERE empresa_id=$1 AND rendicion_entrega_id=$2',[req.actor.empresa_id,v.rows[0].id]);
   for(const pago of medios)await c.query('INSERT INTO distribucion.rendicion_cobros(empresa_id,rendicion_entrega_id,medio_cobranza_id,medio_nombre,medio_clasificacion,importe,referencia,registrado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[req.actor.empresa_id,v.rows[0].id,pago.id,pago.nombre,pago.clasificacion,pago.importe,pago.referencia,req.actor.id]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[req.actor.empresa_id,req.actor.id,'RENDICION_ENTREGA',JSON.stringify({reparto_id:b.reparto_id,codigo_cliente:b.codigo_cliente,estado,importe_entregado:entregado,cobros:medios.length})]);
   await c.query('COMMIT');res.json(v.rows[0]);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));

 // Cierre diario: el conductor declara efectivo físico. La diferencia se calcula en servidor.
 router.get('/rendicion/cierre-caja',wrap(async(req,res)=>{
  if(!['CONDUCTOR','ADMIN','SUPERVISOR'].includes(req.actor.rol))throw fail('Acceso restringido',403);
  const fecha=String(req.query.fecha||'');
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(fecha))throw fail('Fecha inválida');
  const conductor=req.actor.rol==='CONDUCTOR'?req.actor.id:req.query.conductor_id;
  if(!conductor)throw fail('Indicar conductor');
  const r=await db.query('SELECT * FROM distribucion.cierres_caja_conductor WHERE empresa_id=$1 AND conductor_id=$2 AND fecha=$3::date',[req.actor.empresa_id,conductor,fecha]);
  res.json(r.rows[0]||null);
 }));
 router.post('/rendicion/cierre-caja',wrap(async(req,res)=>{
  if(req.actor.rol!=='CONDUCTOR')throw fail('Solo el conductor puede cerrar su caja',403);
  const b=req.body||{},fecha=String(b.fecha||''),declarado=Number(b.efectivo_declarado);
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(fecha)||!Number.isFinite(declarado)||declarado<0||!Number.isInteger(declarado*100+1e-7)||String(b.observacion||'').length>1000)throw fail('Datos del cierre inválidos');
  const c=await db.connect();
  try{
   await c.query('BEGIN');
   const existe=await c.query('SELECT id FROM distribucion.cierres_caja_conductor WHERE empresa_id=$1 AND conductor_id=$2 AND fecha=$3::date FOR UPDATE',[req.actor.empresa_id,req.actor.id,fecha]);
   if(existe.rowCount)throw fail('La caja de esta fecha ya está cerrada. Consultá con supervisión.',409);
   const q=await c.query(`SELECT COALESCE(SUM(rc.importe),0)::numeric AS efectivo
    FROM distribucion.rendicion_cobros rc
    JOIN distribucion.rendicion_entregas re ON re.id=rc.rendicion_entrega_id AND re.empresa_id=rc.empresa_id
    JOIN distribucion.repartos rp ON rp.id=re.reparto_id AND rp.empresa_id=re.empresa_id
    WHERE rc.empresa_id=$1 AND rp.conductor_id=$2 AND rp.fecha=$3::date
    AND rc.medio_clasificacion='EFECTIVO'`,[req.actor.empresa_id,req.actor.id,fecha]);
   const sistema=Number(q.rows[0].efectivo);
   const dif=Math.round(declarado*100-sistema*100)/100;
   const insert=await c.query('INSERT INTO distribucion.cierres_caja_conductor(empresa_id,conductor_id,fecha,efectivo_sistema,efectivo_declarado,diferencia,observacion) VALUES($1,$2,$3::date,$4,$5,$6,$7) RETURNING *',[req.actor.empresa_id,req.actor.id,fecha,sistema,declarado,dif,String(b.observacion||'').trim()]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[req.actor.empresa_id,req.actor.id,'CIERRE_CAJA_CONDUCTOR',JSON.stringify({fecha,efectivo_sistema:sistema,efectivo_declarado:declarado,diferencia:dif})]);
   await c.query('COMMIT');res.status(201).json(insert.rows[0]);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 return router;
};
