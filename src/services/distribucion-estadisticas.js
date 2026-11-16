"use strict";
const centavos=v=>Math.round(Number(v||0)*100);
const porcentaje=(a,b)=>b?Math.round(a/b*10000)/100:null;
function resumir(detalle,cobros,cierres){
 const cero=()=>({paradas:0,pedidos:0,despachado:0,rendidas:0,original_rendido:0,entregado:0,rechazado:0,cobrado:0,sin_cobro:0,pendiente:0,completas:0,parciales:0,rechazadas:0});
 const resumen=cero(),dias=new Map(),conductores=new Map(),clientes=new Map(),motivos=new Map(),areas=new Map(),medios=new Map();
 const porEntrega=new Map();for(const c of cobros)porEntrega.set(String(c.rendicion_entrega_id),(porEntrega.get(String(c.rendicion_entrega_id))||0)+centavos(c.importe));
 const incrementar=(g,d)=>{g.paradas++;g.pedidos+=Number(d.pedidos);for(const k of ['despachado','original_rendido','entregado','rechazado','cobrado','sin_cobro','pendiente'])g[k]+=centavos(d[k]);if(d.estado!=='SIN_RENDICION'){g.rendidas++;if(d.estado==='ENTREGADO')g.completas++;if(d.estado==='PARCIAL')g.parciales++;if(d.estado==='RECHAZADO')g.rechazadas++;}};
 const grupo=(m,k,extras)=>{if(!m.has(k))m.set(k,{...extras,...cero()});return m.get(k);};
 let desajustes=0,excesos=0;
 const filas=detalle.map(r=>{const cobrado=porEntrega.get(String(r.rendicion_id))||0,entregado=centavos(r.importe_entregado),original=centavos(r.importe_original),plan=centavos(r.importe_despachado),estado=r.rendicion_id==null?'SIN_RENDICION':r.estado;
  const d={...r,fecha:String(r.fecha).slice(0,10),estado,despachado:plan/100,original_rendido:original/100,entregado:entregado/100,rechazado:(original-entregado)/100,cobrado:cobrado/100,sin_cobro:Math.max(0,entregado-cobrado)/100,pendiente:estado==='SIN_RENDICION'?plan/100:0};
  if(r.rendicion_id!=null&&plan!==original)desajustes++;
  if(cobrado>entregado)excesos++;
  incrementar(resumen,d);incrementar(grupo(dias,d.fecha,{fecha:d.fecha}),d);incrementar(grupo(conductores,r.conductor_id||'SIN_ASIGNAR',{id:r.conductor_id,nombre:r.conductor||'Sin asignar'}),d);incrementar(grupo(clientes,r.codigo_cliente,{codigo:r.codigo_cliente,nombre:r.nombre_cliente}),d);
  if(['PARCIAL','RECHAZADO'].includes(estado)){
   const nombre=r.motivo_rechazo_nombre||'Sin motivo registrado',area=r.area_responsable||'SIN_CLASIFICAR';
   for(const [m,k,extras] of [[motivos,String(r.motivo_rechazo_id||'SIN_MOTIVO'),{nombre,area}],[areas,area,{nombre:area}]]){if(!m.has(k))m.set(k,{...extras,casos:0,importe:0});const g=m.get(k);g.casos++;g.importe+=original-entregado;}
  }
  return d;
 });
 for(const c of cobros){const k=String(c.medio_cobranza_id)+'|'+c.medio_nombre+'|'+c.medio_clasificacion;if(!medios.has(k))medios.set(k,{nombre:c.medio_nombre,clasificacion:c.medio_clasificacion,movimientos:0,importe:0});const g=medios.get(k);g.movimientos++;g.importe+=centavos(c.importe);}
 const finalizar=g=>{const x={...g};for(const k of ['despachado','original_rendido','entregado','rechazado','cobrado','sin_cobro','pendiente'])x[k]/=100;x.cobertura=porcentaje(g.rendidas,g.paradas);x.tasa_rechazo=porcentaje(g.rechazado,g.original_rendido);x.tasa_cobro=porcentaje(g.cobrado,g.entregado);return x;};
 const importes=m=>[...m.values()].map(g=>({...g,importe:g.importe/100})).sort((a,b)=>b.importe-a.importe);
 const listado=m=>[...m.values()].map(finalizar);
 const resumenFinal=finalizar(resumen);
 resumenFinal.clientes=clientes.size;resumenFinal.repartos=new Set(filas.map(r=>r.reparto_id)).size;
 return {resumen:resumenFinal,dias:listado(dias).sort((a,b)=>a.fecha.localeCompare(b.fecha)),conductores:listado(conductores).sort((a,b)=>b.rechazado-a.rechazado),clientes:listado(clientes).sort((a,b)=>b.rechazado-a.rechazado),motivos:importes(motivos),areas:importes(areas),medios:importes(medios),detalle:filas,cobros,cierres,calidad:{pedidos_modificados_tras_rendir:desajustes,cobros_superiores_a_entrega:excesos,sin_rendicion:filas.filter(r=>r.estado==='SIN_RENDICION').length,sin_historico_area:true}};
}
function hojas(d){
 const resumen=[['Indicador','Valor'],...Object.entries(d.resumen).map(([k,v])=>[k,v])];
 const base=['Paradas','Pedidos','Despachado','Con rendición','Original rendido','Entregado','Rechazado','Cobrado','Entregado sin cobro','Pendiente de rendición','Completas','Parciales','Rechazadas','Cobertura %','Rechazo %','Cobranza %'];
 const metricas=g=>['paradas','pedidos','despachado','rendidas','original_rendido','entregado','rechazado','cobrado','sin_cobro','pendiente','completas','parciales','rechazadas','cobertura','tasa_rechazo','tasa_cobro'].map(k=>g[k]);
 return [
  ['Resumen',resumen],
  ['Por día',[['Fecha',...base],...d.dias.map(g=>[g.fecha,...metricas(g)])]],
  ['Conductores',[['Conductor',...base],...d.conductores.map(g=>[g.nombre,...metricas(g)])]],
  ['Clientes',[['Código','Cliente',...base],...d.clientes.map(g=>[g.codigo,g.nombre,...metricas(g)])]],
  ['Motivos de rechazo',[['Motivo','Área actual','Casos','Importe rechazado'],...d.motivos.map(g=>[g.nombre,g.area,g.casos,g.importe])]],
  ['Áreas responsables',[['Área actual','Casos','Importe rechazado'],...d.areas.map(g=>[g.nombre,g.casos,g.importe])]],
  ['Medios de cobranza',[['Medio','Clasificación','Movimientos','Importe'],...d.medios.map(g=>[g.nombre,g.clasificacion,g.movimientos,g.importe])]],
  ['Detalle entregas',[['Fecha','Despacho','Conductor','Cliente','Nombre','Pedidos','Estado rendición','Estado visita','Motivo','Área actual','Despachado','Original rendido','Entregado','Rechazado','Cobrado','Entregado sin cobro','Pendiente rendición','Observación'],...d.detalle.map(g=>[g.fecha,g.despacho,g.conductor,g.codigo_cliente,g.nombre_cliente,Number(g.pedidos),g.estado,g.estado_visita,g.motivo_rechazo_nombre,g.area_responsable,g.despachado,g.original_rendido,g.entregado,g.rechazado,g.cobrado,g.sin_cobro,g.pendiente,g.observacion])]],
  ['Detalle cobros',[['Fecha reparto','Registrado','Despacho','Cliente','Conductor','Medio','Clasificación','Importe','Referencia'],...d.cobros.map(g=>[g.fecha,g.registrado_en,g.despacho,g.codigo_cliente,g.conductor,g.medio_nombre,g.medio_clasificacion,Number(g.importe),g.referencia])]],
  ['Cierres de caja',[['Fecha','Conductor','Efectivo sistema','Efectivo declarado','Diferencia','Observación'],...d.cierres.map(g=>[g.fecha,g.conductor,Number(g.efectivo_sistema),Number(g.efectivo_declarado),Number(g.diferencia),g.observacion])]],
  ['Criterios',[
   ['Criterio','Valor'],['Desde',d.filtros.desde],['Hasta (incluido)',d.filtros.hasta],['Conductor',d.filtros.conductor_id||'Todos'],['Reparto',d.filtros.reparto_id||'Todos'],['Generado',d.generado_en],
   ['Fecha de análisis','Fecha del reparto, también para los cobros. No es la fecha de registración del cobro.'],
   ['Parada','Un cliente en un reparto; puede incluir varios pedidos.'],['Cobertura','Paradas con rendición económica / paradas planificadas.'],['Rechazo %','Importe rechazado / importe original de las rendiciones registradas.'],['Cobranza %','Cobros registrados / importe entregado en rendiciones.'],
   ['Sin rendición','Se conserva como pendiente económico aunque la visita figure entregada.'],['Sin cobro','Entregado menos cobros registrados por entrega, mínimo cero; no confirma deuda.'],['Área responsable','Clasificación actual del motivo; no existe una copia histórica del área.'],['Historial','Estado actual de cada rendición; no es una reconstrucción de sus modificaciones.'],['Cierres de caja',d.filtros.reparto_id?'No incluidos: corresponden a todo el conductor/día.':'Por fecha y conductor; no atribuibles a un reparto.'],
   ...Object.entries(d.calidad).map(([k,v])=>[k,typeof v==='boolean'?String(v):v])
  ]]
 ];
}
module.exports={resumir,hojas};
