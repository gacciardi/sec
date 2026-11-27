'use strict';
const crypto=require('node:crypto'),fuentes=require('./distribucion-fuentes-gps');
const BASE='https://sec-supervisor.onrender.com/seguir-entrega.html#';
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
const valido=t=>typeof t==='string'&&/^[A-Za-z0-9_-]{43}$/.test(t);
const fail=(m,status=400)=>Object.assign(Error(m),{status});
const uuid=t=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(t||'');
const wrap=f=>(q,s,n)=>Promise.resolve().then(()=>f(q,s)).catch(n);
function posicion(g,fuente,ahora=Date.now()){
 if(!g||g.latitud==null||g.longitud==null)return null;
 const lat=Number(g.latitud),lng=Number(g.longitud),edad=ahora-Date.parse(g.fecha);
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180||!Number.isFinite(edad)||edad<0||edad>120000||!fuentes.permite(fuente,fuente.fuente,g.fecha))return null;
 if(fuente.fuente==='CELULAR'&&(g.precision_metros==null||!Number.isFinite(Number(g.precision_metros))||Number(g.precision_metros)<0||Number(g.precision_metros)>100))return null;
 return {latitud:lat,longitud:lng,actualizado_en:g.fecha};
}
module.exports=function(db,options={}){
 const express=require('express'),publicRouter=express.Router(),officeRouter=express.Router(),env=options.env||process.env;let ready;
 async function preparar(){if(!ready)ready=(async()=>{await fuentes.preparar(db);await db.query(`CREATE TABLE IF NOT EXISTS distribucion.seguimiento_cliente_enlaces(
 token_hash text PRIMARY KEY,empresa_id uuid NOT NULL,reparto_id uuid NOT NULL,codigo_cliente text NOT NULL,
 vehiculo_id uuid NOT NULL,conductor_id uuid NOT NULL,actor_id uuid NOT NULL,creado_en timestamptz NOT NULL DEFAULT now(),
 expira timestamptz NOT NULL,revocado boolean NOT NULL DEFAULT false,
 FOREIGN KEY(empresa_id,reparto_id) REFERENCES distribucion.repartos(empresa_id,id));`);})().catch(e=>{ready=null;throw e;});await ready;}
 // Joining the frozen assignment prevents an old recipient from following a replacement truck or driver.
 const detalle=`SELECT l.*,e.nombre AS empresa_nombre,c.latitud AS cliente_latitud,c.longitud AS cliente_longitud,
 EXISTS(SELECT 1 FROM distribucion.rendicion_entregas re WHERE re.empresa_id=l.empresa_id AND re.reparto_id=l.reparto_id AND re.codigo_cliente=l.codigo_cliente) AS finalizada,
 EXISTS(SELECT 1 FROM distribucion.cierres_caja_conductor cc WHERE cc.empresa_id=l.empresa_id AND cc.conductor_id=l.conductor_id AND cc.fecha=r.fecha) AS caja_cerrada
 FROM distribucion.seguimiento_cliente_enlaces l JOIN distribucion.empresas e ON e.id=l.empresa_id AND e.activo
 JOIN distribucion.repartos r ON r.empresa_id=l.empresa_id AND r.id=l.reparto_id AND r.principal_id=l.vehiculo_id AND r.conductor_id=l.conductor_id
 JOIN distribucion.vehiculos v ON v.empresa_id=l.empresa_id AND v.id=l.vehiculo_id AND v.activo
 JOIN distribucion.miembros m ON m.empresa_id=l.empresa_id AND m.id=l.conductor_id AND m.activo
 JOIN distribucion.clientes dc ON dc.empresa_id=l.empresa_id AND dc.codigo=l.codigo_cliente
 JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL
 WHERE l.token_hash=$1 AND NOT l.revocado AND l.expira>now() AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
 AND c.latitud BETWEEN -90 AND 90 AND c.longitud BETWEEN -180 AND 180
 AND EXISTS(SELECT 1 FROM distribucion.pedidos p WHERE p.empresa_id=l.empresa_id AND p.reparto_id=l.reparto_id AND p.codigo_cliente=l.codigo_cliente)`;
 async function enlace(token){if(!valido(token))throw fail('El seguimiento no está disponible o ya finalizó.',410);await preparar();const d=(await db.query(detalle,[hash(token)])).rows[0];if(!d||d.finalizada||d.caja_cerrada)throw fail('El seguimiento no está disponible o ya finalizó.',410);return d;}
 const intentos=new Map();
 publicRouter.get('/seguimiento-cliente',(q,s,n)=>{const key=q.ip||'desconocido',ahora=Date.now(),v=intentos.get(key);if(v&&v.hasta>ahora){if(++v.n>120)return s.status(429).set({'Cache-Control':'no-store','Retry-After':'60'}).json({error:'Esperá un minuto antes de volver a consultar.'});}else intentos.set(key,{n:1,hasta:ahora+60000});if(intentos.size>10000){for(const [k,v]of intentos)if(v.hasta<ahora)intentos.delete(k);if(intentos.size>10000)intentos.delete(intentos.keys().next().value);}n();},wrap(async(q,s)=>{
  s.set({'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'});
  const d=await enlace(q.get('X-SEC-Seguimiento'));
  const f=(await fuentes.fuentes(db,d.empresa_id,env)).find(f=>f.vehiculo_id===d.vehiculo_id);
  let g=null;if(f?.fuente==='CUSAT')g=(await db.query('SELECT reporte AS fecha,latitud,longitud FROM distribucion.cusat_puntos WHERE empresa_id=$1 AND vehiculo_id=$2 ORDER BY reporte DESC LIMIT 1',[d.empresa_id,d.vehiculo_id])).rows[0];
  else if(f?.fuente==='CELULAR')g=(await db.query('SELECT fecha,latitud,longitud,precision_metros FROM distribucion.gps WHERE empresa_id=$1 AND conductor_id=$2 ORDER BY fecha DESC LIMIT 1',[d.empresa_id,d.conductor_id])).rows[0];
  const p=posicion(g,f);s.json({empresa:d.empresa_nombre,estado:p?'EN_CAMINO':'SIN_SENAL_RECIENTE',camion:p,comercio:{latitud:Number(d.cliente_latitud),longitud:Number(d.cliente_longitud)}});
 }));
 // Public failures never expose database errors, identifiers, or tokens.
 publicRouter.use((e,q,s,n)=>s.status(e.status===410?410:503).set('Cache-Control','no-store').json({error:e.status===410?'El seguimiento no está disponible o ya finalizó.':'No se pudo actualizar la ubicación. Volvé a intentar.'}));
 const oficina=(q,s,n)=>!q.actor?.consulta_comercial&&['ADMIN','SUPERVISOR','OPERADOR'].includes(q.actor?.rol)?n():n(fail('Acceso restringido a oficina de Distribución.',403));
 officeRouter.get('/avisos-clientes/seguimiento/opciones',oficina,wrap(async(q,s)=>{
  const buscar=String(q.query.buscar||'').trim().slice(0,80);const d=await db.query(`SELECT DISTINCT r.id AS reparto_id,r.despacho,p.codigo_cliente,p.nombre_cliente FROM distribucion.repartos r JOIN distribucion.pedidos p ON p.empresa_id=r.empresa_id AND p.reparto_id=r.id JOIN distribucion.clientes dc ON dc.empresa_id=r.empresa_id AND dc.codigo=p.codigo_cliente JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL WHERE r.empresa_id=$1 AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AND r.principal_id IS NOT NULL AND r.conductor_id IS NOT NULL AND c.latitud BETWEEN -90 AND 90 AND c.longitud BETWEEN -180 AND 180 AND ($2='' OR r.despacho::text ILIKE '%'||$2||'%' OR p.codigo_cliente ILIKE '%'||$2||'%' OR p.nombre_cliente ILIKE '%'||$2||'%') AND NOT EXISTS(SELECT 1 FROM distribucion.rendicion_entregas re WHERE re.empresa_id=r.empresa_id AND re.reparto_id=r.id AND re.codigo_cliente=p.codigo_cliente) ORDER BY r.despacho,p.nombre_cliente LIMIT 50`,[q.actor.empresa_id,buscar]);s.set('Cache-Control','no-store').json(d.rows);
 }));
 officeRouter.post('/avisos-clientes/seguimiento',oficina,wrap(async(q,s)=>{
  const b=q.body||{};if(!uuid(b.reparto_id)||typeof b.codigo_cliente!=='string'||!b.codigo_cliente||b.codigo_cliente.length>80)throw fail('Elegí un despacho y cliente de hoy.');await preparar();
  const token=crypto.randomBytes(32).toString('base64url');
  const d=await db.query(`INSERT INTO distribucion.seguimiento_cliente_enlaces(token_hash,empresa_id,reparto_id,codigo_cliente,vehiculo_id,conductor_id,actor_id,expira)
 SELECT $1,r.empresa_id,r.id,$3,r.principal_id,r.conductor_id,$4,LEAST(now()+interval '6 hours',(((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date+1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'))
 FROM distribucion.repartos r JOIN distribucion.empresas e ON e.id=r.empresa_id AND e.activo JOIN distribucion.vehiculos v ON v.empresa_id=r.empresa_id AND v.id=r.principal_id AND v.activo JOIN distribucion.miembros m ON m.empresa_id=r.empresa_id AND m.id=r.conductor_id AND m.activo
 JOIN distribucion.clientes dc ON dc.empresa_id=r.empresa_id AND dc.codigo=$3 JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL
 WHERE r.empresa_id=$2 AND r.id=$5 AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AND c.latitud BETWEEN -90 AND 90 AND c.longitud BETWEEN -180 AND 180
 AND EXISTS(SELECT 1 FROM distribucion.pedidos p WHERE p.empresa_id=r.empresa_id AND p.reparto_id=r.id AND p.codigo_cliente=$3)
 AND NOT EXISTS(SELECT 1 FROM distribucion.rendicion_entregas re WHERE re.empresa_id=r.empresa_id AND re.reparto_id=r.id AND re.codigo_cliente=$3)
 AND NOT EXISTS(SELECT 1 FROM distribucion.cierres_caja_conductor cc WHERE cc.empresa_id=r.empresa_id AND cc.conductor_id=r.conductor_id AND cc.fecha=r.fecha)
 RETURNING expira`,[hash(token),q.actor.empresa_id,b.codigo_cliente,q.actor.id,b.reparto_id]);
  if(!d.rowCount)throw fail('Esta entrega no está disponible para seguimiento.',409);
  s.set('Cache-Control','no-store').json({url:BASE+token,token,expira:d.rows[0].expira});
 }));
 officeRouter.post('/avisos-clientes/seguimiento/revocar',oficina,wrap(async(q,s)=>{if(!valido(q.body?.token))throw fail('Enlace inválido.');await preparar();await db.query('UPDATE distribucion.seguimiento_cliente_enlaces SET revocado=true WHERE empresa_id=$1 AND token_hash=$2',[q.actor.empresa_id,hash(q.body.token)]);s.json({ok:true});}));
 return {publicRouter,officeRouter,enlace,preparar};
};
module.exports.posicion=posicion;module.exports.BASE=BASE;module.exports.valido=valido;
