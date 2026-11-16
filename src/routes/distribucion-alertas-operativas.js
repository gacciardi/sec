"use strict";
const express=require('express');
const {detencion}=require('../services/distribucion-alertas-operativas');
module.exports=db=>{
 const router=express.Router();
 router.get('/alertas-operativas',async(req,res,next)=>{try{
  if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol))return res.status(403).json({error:'Solo oficina'});
  const inicio=req.query.inicio||'08:00',detenido=Number(req.query.detenido||30),demora=Number(req.query.demora||15);
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(inicio)||!Number.isInteger(detenido)||detenido<5||detenido>240||!Number.isInteger(demora)||demora<0||demora>240)return res.status(400).json({error:'Umbrales inválidos'});
  const empresa=req.actor.empresa_id;
  const reloj=(await db.query("SELECT now() AS ahora,(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text AS dia")).rows[0];
  const dia=reloj.dia,ahora=new Date(reloj.ahora),rows=[];
  const add=(tipo,referencia,detalle)=>rows.push({tipo,referencia,detalle});
  const repartos=(await db.query(`SELECT r.*,m.nombre||' '||m.apellido AS conductor,
   EXISTS(SELECT 1 FROM distribucion.gps g WHERE g.empresa_id=r.empresa_id AND g.conductor_id=r.conductor_id AND g.fecha>=($2::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AND g.fecha<=$3) OR
   EXISTS(SELECT 1 FROM distribucion.visitas v WHERE v.empresa_id=r.empresa_id AND v.reparto_id=r.id) AS iniciado
   FROM distribucion.repartos r LEFT JOIN distribucion.miembros m ON m.empresa_id=r.empresa_id AND m.id=r.conductor_id WHERE r.empresa_id=$1 AND r.fecha=$2`,[empresa,dia,ahora])).rows;
  const pedidos=(await db.query(`SELECT DISTINCT p.reparto_id,p.codigo_cliente,p.nombre_cliente,r.despacho,r.conductor_id,
   v.estado,v.observacion,re.estado AS rendicion,c.latitud,c.longitud,h.cierre_1,h.cierre_2
   FROM distribucion.pedidos p JOIN distribucion.repartos r ON r.empresa_id=p.empresa_id AND r.id=p.reparto_id
   LEFT JOIN distribucion.visitas v ON v.empresa_id=p.empresa_id AND v.reparto_id=p.reparto_id AND v.codigo_cliente=p.codigo_cliente
   LEFT JOIN distribucion.rendicion_entregas re ON re.empresa_id=p.empresa_id AND re.reparto_id=p.reparto_id AND re.codigo_cliente=p.codigo_cliente
   LEFT JOIN distribucion.clientes dc ON dc.empresa_id=p.empresa_id AND dc.codigo=p.codigo_cliente
   LEFT JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL
   LEFT JOIN distribucion.horarios_recepcion h ON h.empresa_id=p.empresa_id AND h.codigo_cliente=p.codigo_cliente AND h.dia_semana=extract(dow from $2::date)
   WHERE p.empresa_id=$1 AND r.fecha=$2`,[empresa,dia])).rows;
  const pendientes=new Set(pedidos.filter(p=>!p.rendicion&&!['ENTREGADO','CERRADO'].includes(p.estado)).map(p=>p.reparto_id));
  for(const r of repartos){
   if(!r.conductor_id)add('SIN_CONDUCTOR',r.despacho,'Reparto sin conductor asignado');
   if(!r.principal_id)add('SIN_VEHICULO',r.despacho,'Reparto sin vehículo asignado');
   if(r.conductor_id&&pendientes.has(r.id)&&!r.iniciado&&ahora>=new Date(dia+'T'+inicio+':00-03:00'))add('SIN_INICIO',r.despacho,(r.conductor||'Conductor')+': sin GPS ni visita registrados hoy después de '+inicio);
  }
  for(const p of pedidos){const ref=p.despacho+' · '+p.codigo_cliente+' · '+(p.nombre_cliente||'');
   if(p.latitud==null||p.longitud==null)add('SIN_COORDENADAS',ref,'Cliente sin coordenadas o sin vínculo de empresa');
   if(p.estado==='INCIDENCIA')add('INCIDENCIA',ref,p.observacion||'Incidencia registrada en la visita');
   if(p.rendicion==='PARCIAL'||p.rendicion==='RECHAZADO')add('INCIDENCIA_RENDICION',ref,'Entrega '+p.rendicion.toLowerCase());
   const cierre=p.cierre_2||p.cierre_1;
   if(cierre&&!p.rendicion&&!['ENTREGADO','CERRADO'].includes(p.estado)&&ahora>new Date(dia+'T'+cierre+'-03:00').getTime()+demora*60000)add('ENTREGA_DEMORADA',ref,'Sin resultado final; último cierre de recepción '+cierre+' + '+demora+' min');
  }
  const conductores=[...new Set(repartos.filter(r=>pendientes.has(r.id)&&r.conductor_id).map(r=>r.conductor_id))];
  for(const id of conductores){
   const gps=(await db.query(`SELECT fecha,latitud,longitud,precision_metros,velocidad FROM distribucion.gps WHERE empresa_id=$1 AND conductor_id=$2 AND fecha>=$3 AND fecha<=$4 ORDER BY fecha DESC`,[empresa,id,new Date(Math.max(new Date(dia+'T00:00:00-03:00').getTime(),ahora.getTime()-(detenido+10)*60000)),ahora])).rows;
   if(detencion(gps,ahora,detenido))add('DETENCION_PROLONGADA',repartos.find(r=>r.conductor_id===id).conductor,'GPS continuo dentro de 100 m durante al menos '+detenido+' min; verificar si corresponde a una descarga o pausa');
  }
  res.set('Cache-Control','no-store').json({fecha:dia,generado_en:ahora,alertas:rows});
 }catch(e){next(e);}});
 return router;
};
