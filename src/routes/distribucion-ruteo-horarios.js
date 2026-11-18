'use strict';
const MINUTO=60;
function segundosHora(s){const m=String(s||'').match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]||0):null;}
function turno(p,llegada){const servicio=p.minutos_descarga*MINUTO;if(!p.ventanas.length)return llegada+servicio<=86400?{inicio:llegada,fin:llegada+servicio,espera:0,cierre:86400}:null;for(const [abre,cierra]of p.ventanas){const inicio=Math.max(llegada,abre);if(inicio+servicio<=cierra)return {inicio,fin:inicio+servicio,espera:inicio-llegada,cierre:cierra};}return null;}
function prepararParadas(filas){return filas.map(p=>({...p,minutos_descarga:p.minutos_descarga==null?5:Number(p.minutos_descarga),ventanas:[[p.apertura_1,p.cierre_1],[p.apertura_2,p.cierre_2]].filter(([a,b])=>a!=null&&b!=null).map(([a,b])=>[segundosHora(a),segundosHora(b)]).filter(([a,b])=>a!==null&&b!==null&&a<b).sort((a,b)=>a[0]-b[0])}));}
function planificar(paradas,matriz,inicio){
 // Cercanía por tiempo de viaje real. El maestro de horarios orienta, no excluye clientes.
 let restantes=paradas.map((_,i)=>i),actual=0,hora=inicio,viajeTotal=0;const orden=[];
 while(restantes.length){
  const opciones=restantes.map(i=>({i,viaje:matriz[actual]?.[i+1]})).filter(o=>Number.isFinite(o.viaje));
  if(!opciones.length)break;
  opciones.sort((a,b)=>a.viaje-b.viaje||a.i-b.i);
  const o=opciones[0];orden.push(o.i);hora+=o.viaje+paradas[o.i].minutos_descarga*MINUTO;viajeTotal+=o.viaje;actual=o.i+1;restantes=restantes.filter(i=>i!==o.i);
 }
 return {orden,restantes,fin:hora,viajeTotal,esperaTotal:0};
}
function agenda(paradas,duraciones,inicio,medianoche){let hora=inicio;return paradas.map((p,i)=>{const viaje=duraciones[i];if(!Number.isFinite(viaje))throw Error('Google no devolvió todos los tiempos de viaje');const llegada=hora+viaje,fin=llegada+p.minutos_descarga*MINUTO;hora=fin;const dentro=p.ventanas.some(([abre,cierra])=>llegada>=abre&&fin<=cierra),iso=s=>new Date(medianoche+s*1000).toISOString();return {reparto_id:p.reparto_id,codigo_cliente:p.codigo_cliente,nombre_cliente:p.nombre_cliente,llegada:iso(llegada),inicio:iso(llegada),salida:iso(fin),espera_segundos:0,minutos_descarga:p.minutos_descarga,estado:!p.ventanas.length?'SIN_HORARIO':dentro?'DENTRO_DE_HORARIO':'REVISAR_HORARIO'};});}
const esquemas=new WeakMap();
async function asegurarHorarios(db){if(!esquemas.has(db))esquemas.set(db,db.query(`CREATE TABLE IF NOT EXISTS distribucion.horarios_recepcion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),
 codigo_cliente text NOT NULL,
 dia_semana smallint NOT NULL CHECK(dia_semana BETWEEN 0 AND 6),
 apertura_1 time NOT NULL,
 cierre_1 time NOT NULL,
 apertura_2 time,
 cierre_2 time,
 minutos_descarga integer NOT NULL DEFAULT 5 CHECK(minutos_descarga BETWEEN 0 AND 480),
 observaciones text NOT NULL DEFAULT '',
 actualizado_en timestamptz NOT NULL DEFAULT now(),
 UNIQUE(empresa_id,codigo_cliente,dia_semana),
 CHECK(apertura_1<cierre_1),
 CHECK((apertura_2 IS NULL AND cierre_2 IS NULL) OR (apertura_2 IS NOT NULL AND cierre_2 IS NOT NULL AND apertura_2<cierre_2 AND apertura_2>=cierre_1))
);
`).catch(e=>{esquemas.delete(db);throw e;}));await esquemas.get(db);}
module.exports=function(db){
 const informes=require('./distribucion-informes-ruteo')(db),router=require('express').Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next),error=(m,s=400)=>Object.assign(Error(m),{status:s});const cache=new Map();
 async function google(url,key,payload,fields){let response;try{response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':fields},body:JSON.stringify(payload)});}catch{throw error('No se pudo consultar los tiempos de Maps. Intentá recalcular.',502);}const d=await response.json().catch(()=>null);if(!response.ok||!d)throw error('Maps no pudo calcular la ruta. Revisá la disponibilidad de Routes y Route Matrix e intentá nuevamente.',502);return d;}
 router.use(informes.router);
 const wp=p=>({location:{latLng:{latitude:Number(p.latitud),longitude:Number(p.longitud)}}});const segundos=s=>typeof s==='string'&&/^\d+(?:\.\d+)?s$/.test(s)?Number(s.slice(0,-1)):null;
 async function bloqueMatriz(origenes,destinos,key,salida){const d=await google('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',key,{origins:origenes.map(p=>({waypoint:wp(p)})),destinations:destinos.map(p=>({waypoint:wp(p)})),travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',departureTime:new Date(Math.max(Date.now()+60000,Date.parse(salida))).toISOString()},'originIndex,destinationIndex,status,condition,duration');if(!Array.isArray(d))throw error('Maps devolvió una matriz inválida',502);const m=origenes.map(()=>destinos.map(()=>Infinity));for(const e of d){const a=e.originIndex??0,b=e.destinationIndex??0,t=segundos(e.duration);if(a>=0&&a<m.length&&b>=0&&b<destinos.length&&(!e.status?.code)&&e.condition==='ROUTE_EXISTS'&&t!==null)m[a][b]=t;}return m;}
 async function matrizPuntos(puntos,key,salida,empresa){const ck=empresa+'|'+JSON.stringify(puntos.map(p=>[p.reparto_id,p.codigo_cliente,p.latitud,p.longitud]));let c=cache.get(ck);if(c&&c.expira>Date.now())return c.promesa;cache.delete(ck);if(cache.size>=8)cache.delete(cache.keys().next().value);const promesa=(async()=>{const m=puntos.map(()=>puntos.map(()=>Infinity)),tareas=[];for(let i=0;i<puntos.length;i+=25)for(let j=0;j<puntos.length;j+=25)tareas.push({i,j});let siguiente=0;await Promise.all(Array.from({length:Math.min(4,tareas.length)},async()=>{while(siguiente<tareas.length){const {i,j}=tareas[siguiente++],bloque=await bloqueMatriz(puntos.slice(i,i+25),puntos.slice(j,j+25),key,salida);bloque.forEach((r,a)=>r.forEach((v,b)=>m[i+a][j+b]=v));}}));return m;})();cache.set(ck,{promesa,expira:Date.now()+300000});try{return await promesa;}catch(e){cache.delete(ck);throw e;}}
 router.post('/rutas-google/sugerir',wrap(async(req,res)=>{
  if(req.actor.rol!=='CONDUCTOR')throw error('Solo conductores',403);const key=process.env.GOOGLE_MAPS_ROUTES_API_KEY;if(!key)throw error('Falta configurar Google Routes en el servidor',503);
  const origen=req.body?.origen,solicitudes=req.body?.puntos,valido=p=>p&&p.latitud!=null&&p.longitud!=null&&Number.isFinite(Number(p.latitud))&&Number.isFinite(Number(p.longitud))&&Math.abs(Number(p.latitud))<=90&&Math.abs(Number(p.longitud))<=180;
  if(!valido(origen)||!Array.isArray(solicitudes)||!solicitudes.length||solicitudes.length>100||solicitudes.some(p=>!p||typeof p.codigo_cliente!=='string'||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(p.reparto_id||'')))throw error('Puntos de ruta inválidos');const ident=p=>p.reparto_id+'|'+p.codigo_cliente;if(new Set(solicitudes.map(ident)).size!==solicitudes.length)throw error('Hay clientes duplicados en la ruta');
  const ahora=new Date(),dia=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(ahora),medianoche=Date.parse(dia+'T00:00:00-03:00'),inicio=(ahora.getTime()-medianoche)/1000;
  await asegurarHorarios(db);
  const r=await db.query(`SELECT DISTINCT p.reparto_id,p.codigo_cliente,p.nombre_cliente,c.latitud,c.longitud,h.apertura_1,h.cierre_1,h.apertura_2,h.cierre_2,h.minutos_descarga,re.estado AS rendicion,v.estado AS visita FROM distribucion.pedidos p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id LEFT JOIN distribucion.clientes dc ON dc.empresa_id=p.empresa_id AND dc.codigo=p.codigo_cliente LEFT JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL LEFT JOIN distribucion.horarios_recepcion h ON h.empresa_id=p.empresa_id AND h.codigo_cliente=p.codigo_cliente AND h.dia_semana=extract(dow from $3::date) LEFT JOIN distribucion.rendicion_entregas re ON re.empresa_id=p.empresa_id AND re.reparto_id=p.reparto_id AND re.codigo_cliente=p.codigo_cliente LEFT JOIN distribucion.visitas v ON v.empresa_id=p.empresa_id AND v.reparto_id=p.reparto_id AND v.codigo_cliente=p.codigo_cliente WHERE p.empresa_id=$1 AND r.conductor_id=$2 AND p.fecha=$3::date AND p.reparto_id=ANY($4::uuid[])`,[req.actor.empresa_id,req.actor.id,dia,[...new Set(solicitudes.map(p=>p.reparto_id))]]);
  const catalogo=new Map(r.rows.map(p=>[ident(p),p]));if(solicitudes.some(p=>!catalogo.has(ident(p))))throw error('Hay clientes no asignados al conductor para hoy',403);
  const omitidos=[],puntos=prepararParadas(solicitudes.flatMap(p=>{const d=catalogo.get(ident(p));if(d.rendicion||['ENTREGADO','CERRADO','INCIDENCIA','VISITADO'].includes(d.visita)){omitidos.push({...d,motivo:'Cliente ya atendido'});return [];}if(!valido(d)){omitidos.push({...d,motivo:'Sin coordenadas válidas'});return [];}return [d];}));
  const conHorarios=puntos.some(p=>p.ventanas.length);let elegidos=puntos;
  if(conHorarios&&puntos.length){const core=await matrizPuntos(puntos,key,ahora.toISOString(),req.actor.empresa_id),desdeOrigen=[];for(let j=0;j<puntos.length;j+=25)desdeOrigen.push(...(await bloqueMatriz([origen],puntos.slice(j,j+25),key,ahora.toISOString()))[0]);const matriz=[[0,...desdeOrigen],...core.map(f=>[Infinity,...f])],propuesta=planificar(puntos,matriz,inicio);elegidos=propuesta.orden.map(i=>puntos[i]);for(const i of propuesta.restantes)omitidos.push({...puntos[i],motivo:'Maps no devolvió un trayecto disponible para incorporar esta parada; revisar coordenadas y acceso'});}
  let actual=origen,distancia=0,conduccion=0,hora=inicio;const orden=[],polilineas=[],duraciones=[];
  for(let offset=0;offset<elegidos.length;offset+=25){const grupo=elegidos.slice(offset,offset+25),intermedios=grupo.slice(0,-1),destino=grupo.at(-1),ruta=(await google('https://routes.googleapis.com/directions/v2:computeRoutes',key,{origin:wp(actual),destination:wp(destino),intermediates:intermedios.map(wp),travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',...(medianoche+hora*1000>Date.now()+60000?{departureTime:new Date(medianoche+hora*1000).toISOString()}:{}),optimizeWaypointOrder:!conHorarios&&intermedios.length>1,languageCode:'es-AR',units:'METRIC'},'routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.polyline.encodedPolyline,routes.legs.duration')).routes?.[0];
   if(!ruta||!Array.isArray(ruta.legs)||ruta.legs.length!==grupo.length)throw error('Maps no devolvió los tramos completos; recalculá la ruta.',502);const indices=conHorarios?intermedios.map((_,i)=>i):(ruta.optimizedIntermediateWaypointIndex||intermedios.map((_,i)=>i));if(indices.length!==intermedios.length||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=intermedios.length))throw error('Orden de Maps inválido',502);const bloque=[...indices.map(i=>intermedios[i]),destino],tiempos=ruta.legs.map(l=>segundos(l.duration));if(tiempos.some(t=>t===null))throw error('Tiempos de Maps incompletos',502);orden.push(...bloque);duraciones.push(...tiempos);const pasos=agenda(bloque,tiempos,hora,medianoche);hora=(Date.parse(pasos.at(-1).salida)-medianoche)/1000;conduccion+=tiempos.reduce((a,b)=>a+b,0);distancia+=Number(ruta.distanceMeters)||0;if(ruta.polyline?.encodedPolyline)polilineas.push(ruta.polyline.encodedPolyline);actual=destino;
  }
  const cronograma=agenda(orden,duraciones,inicio,medianoche),espera=cronograma.reduce((a,p)=>a+p.espera_segundos,0),servicio=orden.reduce((a,p)=>a+p.minutos_descarga*60,0);
  const resultado={orden:orden.map(p=>({reparto_id:p.reparto_id,codigo_cliente:p.codigo_cliente})),cronograma,omitidos:omitidos.map(p=>({reparto_id:p.reparto_id,codigo_cliente:p.codigo_cliente,nombre_cliente:p.nombre_cliente,motivo:p.motivo})),sin_horario:puntos.filter(p=>!p.ventanas.length).length,distancia_metros:distancia,duracion_segundos:conduccion,espera_segundos:espera,servicio_segundos:servicio,duracion_total_segundos:conduccion+espera+servicio,polilineas,metodo:conHorarios?'SEC_PROXIMIDAD_AVISOS_HORARIO':'GOOGLE_ROUTES_TRAFFIC_AWARE',nota:conHorarios?'Orden por cercanía según tiempos de Maps. Los horarios son orientativos: no excluyen clientes ni agregan esperas automáticas. Revisá los avisos y confirmá la recepción con el cliente.':'Sin horarios cargados para estas paradas: se mantiene el cálculo de Maps y se suma el tiempo de atención. Sin horario significa disponible de inmediato.'};
  const {polilineas:geometriaNoArchivada,...detalleOficina}=resultado;
  const informe={...detalleOficina,fecha:dia,generado_en:ahora.toISOString(),repartos:[...new Set(solicitudes.map(p=>p.reparto_id))]};
  try{await informes.guardar(req.actor,informe);resultado.informe_oficina_guardado=true;}catch(e){console.error('Informe de ruteo no guardado:',e.code||e.message);resultado.informe_oficina_guardado=false;}
  res.json(resultado);
 }));return router;
};module.exports.planificar=planificar;module.exports.prepararParadas=prepararParadas;module.exports.turno=turno;module.exports.agenda=agenda;

module.exports.asegurarHorarios=asegurarHorarios;
