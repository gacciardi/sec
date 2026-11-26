'use strict';
// Motor sin efectos externos: no envía mensajes ni modifica entregas.
const FUENTES = new Set(['CELULAR', 'CUSAT']);
const PROPUESTA = Object.freeze({radio_metros:500, antiguedad_maxima_segundos:120, precision_maxima_metros:100, fuente_preferida:'CELULAR'});
function coordenadas(p){return p && typeof p.latitud==='number' && Number.isFinite(p.latitud) && Math.abs(p.latitud)<=90 && typeof p.longitud==='number' && Number.isFinite(p.longitud) && Math.abs(p.longitud)<=180;}
function distanciaMetros(a,b){const rad=n=>n*Math.PI/180;const h=Math.sin(rad(b.latitud-a.latitud)/2)**2+Math.cos(rad(a.latitud))*Math.cos(rad(b.latitud))*Math.sin(rad(b.longitud-a.longitud)/2)**2;return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));}
function configuracion(c={}){const r={...PROPUESTA,...c};for(const [k,min,max] of [['radio_metros',100,20000],['antiguedad_maxima_segundos',10,600],['precision_maxima_metros',1,1000]])if(!Number.isInteger(r[k])||r[k]<min||r[k]>max)throw Error('Configuración inválida: '+k);if(!FUENTES.has(r.fuente_preferida))throw Error('Fuente inválida');return r;}
function elegirPosicion(posiciones,contexto,c={},ahora=Date.now()){
 const cfg=configuracion(c);
 if(!contexto.empresa_id||!contexto.vehiculo_id)throw Error('Falta empresa o vehículo');
 const validas=posiciones.filter(p=>p.empresa_id===contexto.empresa_id && p.vehiculo_id===contexto.vehiculo_id && p.fuente===cfg.fuente_preferida && coordenadas(p) && Number.isFinite(Date.parse(p.fecha)) && (!contexto.fecha||new Date(p.fecha).toLocaleDateString('en-CA',{timeZone:'America/Argentina/Buenos_Aires'})===contexto.fecha) && ahora-Date.parse(p.fecha)>=0 && ahora-Date.parse(p.fecha)<=cfg.antiguedad_maxima_segundos*1000 && ((p.fuente==='CUSAT'&&p.precision_metros==null)||(typeof p.precision_metros==='number' && p.precision_metros>=0 && p.precision_metros<=cfg.precision_maxima_metros)));
 return validas.sort((a,b)=>(a.fuente===cfg.fuente_preferida?0:1)-(b.fuente===cfg.fuente_preferida?0:1)||Date.parse(b.fecha)-Date.parse(a.fecha))[0]||null;
}
function evaluarCercania({contexto,cliente,posiciones,yaAvisado=false,config={},ahora=Date.now(),soloPreparacion=false}){
 const cfg=configuracion(config);
 if(!contexto.empresa_id||!contexto.vehiculo_id||!contexto.reparto_id||!contexto.fecha)throw Error('Falta contexto del reparto');
 if(cliente.empresa_id!==contexto.empresa_id||cliente.reparto_id!==contexto.reparto_id||cliente.fecha!==contexto.fecha)return {apto:false,motivo:'CLIENTE_FUERA_DEL_REPARTO'};
 if(cliente.estado!=='PENDIENTE')return {apto:false,motivo:'CLIENTE_YA_ATENDIDO'};
 if(yaAvisado)return {apto:false,motivo:'YA_AVISADO'};
 if(!coordenadas(cliente))return {apto:false,motivo:'CLIENTE_SIN_COORDENADAS'};
 // No se infiere un consentimiento ni un prefijo de país a partir del Excel.
 if(!/^\+[1-9]\d{7,14}$/.test(cliente.telefono||''))return {apto:false,motivo:'TELEFONO_NO_VALIDADO'};
 if(cliente.acepta_avisos!==true&&!soloPreparacion)return {apto:false,motivo:'AVISOS_NO_HABILITADOS'};
 if(!cliente.codigo_cliente)return {apto:false,motivo:'CLIENTE_SIN_CODIGO'};
 const posicion=elegirPosicion(posiciones,contexto,cfg,ahora);
 if(!posicion)return {apto:false,motivo:'SIN_UBICACION_RECIENTE_Y_PRECISA'};
 const distancia=distanciaMetros(posicion,cliente);
 // Margen conservador: la precisión también debe caber dentro del radio.
 if(distancia+(posicion.precision_metros??0)>cfg.radio_metros)return {apto:false,motivo:'FUERA_DE_ZONA',distancia_metros:Math.round(distancia)};
 return {apto:true,solo_preparacion:soloPreparacion,habilitacion_pendiente:cliente.acepta_avisos!==true,motivo:'EN_ZONA',fuente:posicion.fuente,fecha_posicion:posicion.fecha,distancia_metros:Math.round(distancia),clave_unica:JSON.stringify([contexto.empresa_id,contexto.reparto_id,contexto.fecha,cliente.codigo_cliente])};
}
module.exports={PROPUESTA,configuracion,distanciaMetros,elegirPosicion,evaluarCercania};
