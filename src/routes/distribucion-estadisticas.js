"use strict";
const express=require('express');
const {resumir,hojas}=require('../services/distribucion-estadisticas');
const fail=(s,status=400)=>Object.assign(new Error(s),{status});
function filtros(q){
 const valido=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!valido(q.desde)||!valido(q.hasta)||q.desde>q.hasta||(new Date(q.hasta)-new Date(q.desde))/86400000>365)throw fail('Seleccioná un período válido de hasta 366 días.');
 const uuid=v=>!v||typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
 if(!uuid(q.conductor_id)||!uuid(q.reparto_id))throw fail('Conductor o reparto inválido.');
 return {desde:q.desde,hasta:q.hasta,conductor_id:q.conductor_id||null,reparto_id:q.reparto_id||null};
}
async function consultar(db,empresa,f){
 const c=await db.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL statement_timeout = '20s'");
  const args=[empresa,f.desde,f.hasta,f.conductor_id,f.reparto_id];
  const condicion='r.empresa_id=$1 AND r.fecha BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR r.conductor_id=$4::uuid) AND ($5::uuid IS NULL OR r.id=$5::uuid)';
  const opciones=(await c.query(`SELECT r.id,to_char(r.fecha,'YYYY-MM-DD') AS fecha,r.despacho,r.conductor_id,coalesce(m.nombre||' '||m.apellido,r.conductor_nombre,'Sin asignar') AS conductor FROM distribucion.repartos r LEFT JOIN distribucion.miembros m ON m.id=r.conductor_id AND m.empresa_id=r.empresa_id WHERE r.empresa_id=$1 AND r.fecha BETWEEN $2::date AND $3::date ORDER BY r.fecha DESC,r.despacho LIMIT 20001`,args.slice(0,3))).rows;
  const detalle=(await c.query(`WITH plan AS (
   SELECT p.empresa_id,p.reparto_id,p.codigo_cliente,max(p.nombre_cliente) AS nombre_cliente,count(*)::int AS pedidos,sum(coalesce(p.importe,0)) AS importe_despachado
   FROM distribucion.pedidos p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id WHERE ${condicion}
   GROUP BY p.empresa_id,p.reparto_id,p.codigo_cliente
  ) SELECT p.*,to_char(r.fecha,'YYYY-MM-DD') AS fecha,r.despacho,r.conductor_id,
   coalesce(m.nombre||' '||m.apellido,r.conductor_nombre,'Sin asignar') AS conductor,
   e.id AS rendicion_id,e.estado,e.importe_original,e.importe_entregado,e.motivo_rechazo_id,e.motivo_rechazo_nombre,e.observacion,mr.area_responsable,v.estado AS estado_visita
   FROM plan p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id
   LEFT JOIN distribucion.miembros m ON m.id=r.conductor_id AND m.empresa_id=r.empresa_id
   LEFT JOIN distribucion.rendicion_entregas e ON e.reparto_id=p.reparto_id AND e.codigo_cliente=p.codigo_cliente AND e.empresa_id=p.empresa_id
   LEFT JOIN distribucion.motivos_rechazo mr ON mr.id=e.motivo_rechazo_id AND mr.empresa_id=e.empresa_id
   LEFT JOIN distribucion.visitas v ON v.reparto_id=p.reparto_id AND v.codigo_cliente=p.codigo_cliente AND v.empresa_id=p.empresa_id
   ORDER BY r.fecha DESC,r.despacho,p.codigo_cliente LIMIT 20001`,args)).rows;
  const cobros=(await c.query(`SELECT rc.id,rc.rendicion_entrega_id,rc.medio_cobranza_id,rc.medio_nombre,rc.medio_clasificacion,rc.importe,rc.referencia,rc.registrado_en::text,
   to_char(r.fecha,'YYYY-MM-DD') AS fecha,r.despacho,e.codigo_cliente,coalesce(m.nombre||' '||m.apellido,r.conductor_nombre,'Sin asignar') AS conductor
   FROM distribucion.rendicion_cobros rc JOIN distribucion.rendicion_entregas e ON e.id=rc.rendicion_entrega_id AND e.empresa_id=rc.empresa_id
   JOIN distribucion.repartos r ON r.id=e.reparto_id AND r.empresa_id=e.empresa_id
   LEFT JOIN distribucion.miembros m ON m.id=r.conductor_id AND m.empresa_id=r.empresa_id
   WHERE ${condicion} AND EXISTS(SELECT 1 FROM distribucion.pedidos p WHERE p.empresa_id=e.empresa_id AND p.reparto_id=e.reparto_id AND p.codigo_cliente=e.codigo_cliente)
   ORDER BY r.fecha DESC,rc.id DESC LIMIT 50001`,args)).rows;
  const cierres=f.reparto_id?[]:(await c.query(`SELECT to_char(cc.fecha,'YYYY-MM-DD') AS fecha,cc.efectivo_sistema,cc.efectivo_declarado,cc.diferencia,cc.observacion,m.nombre||' '||m.apellido AS conductor
   FROM distribucion.cierres_caja_conductor cc LEFT JOIN distribucion.miembros m ON m.id=cc.conductor_id AND m.empresa_id=cc.empresa_id
   WHERE cc.empresa_id=$1 AND cc.fecha BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR cc.conductor_id=$4::uuid) ORDER BY cc.fecha DESC,m.apellido LIMIT 20001`,args.slice(0,4))).rows;
  if(detalle.length>20000||cobros.length>50000||opciones.length>20000||cierres.length>20000)throw fail('El período contiene demasiados movimientos. Reducí las fechas o filtrá por conductor/reparto; no se exportan datos incompletos.',413);
  const generado=(await c.query('SELECT now()::text AS fecha')).rows[0].fecha;
  await c.query('COMMIT');
  return {...resumir(detalle,cobros,cierres),filtros:f,opciones,generado_en:generado};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function libro(d,ExcelJS){
 const w=new ExcelJS.Workbook();w.creator='SEC Distribución';w.created=new Date();
 for(const [nombre,rows] of hojas(d)){
  const s=w.addWorksheet(nombre,{views:[{state:'frozen',ySplit:1}]});
  // Strings remain text cells, even when they begin with =, +, - or @.
  for(const row of rows)s.addRow(row.map(v=>v==null?null:typeof v==='number'?v:String(v)));
  s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF142B4B'}};
  s.autoFilter={from:{row:1,column:1},to:{row:Math.max(rows.length,1),column:rows[0].length}};
  s.columns.forEach((col,i)=>{col.width=Math.min(48,Math.max(14,String(rows[0][i]||'').length+3));});
  s.eachRow((row,n)=>{if(n===1)return;row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Number)cell.numFmt='#,##0.00';});});
 }
 return w.xlsx.writeBuffer();
}
module.exports=db=>{
 const router=express.Router();
 router.get('/estadisticas',async(req,res,next)=>{try{
  if(!['ADMIN','SUPERVISOR'].includes(req.actor.rol))throw fail('Estadísticas disponibles para administración y supervisión.',403);
  const f=filtros(req.query),d=await consultar(db,req.actor.empresa_id,f);
  res.set('Cache-Control','no-store');
  if(req.query.formato==='xlsx'){
   const contenido=await libro(d,require('exceljs'));
   res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="SEC-estadisticas-${f.desde}-${f.hasta}.xlsx"`);res.send(contenido);
  }else res.json(d);
 }catch(e){next(e);}});
 return router;
};
module.exports._test={filtros,consultar,libro};
