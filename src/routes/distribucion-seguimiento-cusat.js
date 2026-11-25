const express=require('express');
function distancia(a,b,c,d){const r=x=>x*Math.PI/180,t=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;return 6371000*2*Math.atan2(Math.sqrt(t),Math.sqrt(Math.max(0,1-t)));}
function cercano(u,p,ahora){
 if(!u.reporte||u.latitud==null||u.longitud==null||p.latitud==null||p.longitud==null)return false;
 const edad=ahora-Date.parse(u.reporte),radio=Number(p.radio_geocerca)>0?Number(p.radio_geocerca):30;
 return Number.isFinite(edad)&&edad>=0&&edad<=300000&&Number.isFinite(Number(p.latitud))&&Number.isFinite(Number(p.longitud))&&distancia(u.latitud,u.longitud,Number(p.latitud),Number(p.longitud))<=radio;
}
module.exports=function(db,consultar,options={}){
 const router=express.Router(),env=options.env||process.env,reloj=options.ahora||Date.now;let preparado=null,ocupado=false;
 async function preparar(){if(!preparado)preparado=db.query(`
 CREATE TABLE IF NOT EXISTS distribucion.cusat_puntos(
 empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),vehiculo_id uuid NOT NULL,
 reporte timestamptz NOT NULL,latitud double precision NOT NULL,longitud double precision NOT NULL,velocidad double precision,
 recibido timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(empresa_id,vehiculo_id,reporte),
 FOREIGN KEY(empresa_id,vehiculo_id) REFERENCES distribucion.vehiculos(empresa_id,id));
 CREATE TABLE IF NOT EXISTS distribucion.cusat_pasos(
 empresa_id uuid NOT NULL,reparto_id uuid NOT NULL,codigo_cliente text NOT NULL,vehiculo_id uuid NOT NULL,conductor_id uuid NOT NULL,
 primera_fecha timestamptz NOT NULL,ultima_fecha timestamptz NOT NULL,latitud double precision NOT NULL,longitud double precision NOT NULL,
 PRIMARY KEY(empresa_id,reparto_id,codigo_cliente),FOREIGN KEY(empresa_id,reparto_id) REFERENCES distribucion.repartos(empresa_id,id));
 CREATE TABLE IF NOT EXISTS distribucion.cusat_seguimiento_estado(
 empresa_id uuid PRIMARY KEY REFERENCES distribucion.empresas(id),ultima_consulta timestamptz,ultimo_exito timestamptz,error text);
 `).catch(e=>{preparado=null;throw e;});await preparado;}
 async function procesar(empresaId){
 const c=await db.connect();try{
  await c.query('BEGIN');const lock=await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS obtenido',['cusat-seguimiento:'+empresaId]);if(!lock.rows[0].obtenido){await c.query('ROLLBACK');return;}
  const datos=await consultar(empresaId),ahora=reloj();
  const planes=await c.query(`SELECT DISTINCT r.id AS reparto_id,r.conductor_id,r.principal_id,p.codigo_cliente,c.latitud,c.longitud,c.radio_geocerca
   FROM distribucion.repartos r JOIN distribucion.pedidos p ON p.reparto_id=r.id AND p.empresa_id=r.empresa_id
   JOIN distribucion.miembros m ON m.empresa_id=r.empresa_id AND m.id=r.conductor_id AND m.activo=true
   LEFT JOIN distribucion.clientes dc ON dc.empresa_id=p.empresa_id AND dc.codigo=p.codigo_cliente
   LEFT JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL
   WHERE r.empresa_id=$1 AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,[empresaId]);
  for(const u of datos.unidades){
   if(!u.reporte||u.latitud==null||u.longitud==null||ahora-Date.parse(u.reporte)<0||ahora-Date.parse(u.reporte)>300000)continue;
   const punto=await c.query(`INSERT INTO distribucion.cusat_puntos(empresa_id,vehiculo_id,reporte,latitud,longitud,velocidad) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING reporte`,[empresaId,u.id,u.reporte,u.latitud,u.longitud,u.velocidad]);
   if(!punto.rowCount)continue;
   for(const p of planes.rows.filter(p=>p.principal_id===u.id)){
    if(!cercano(u,p,ahora))continue;
    // El paso GPS es evidencia de proximidad, nunca una entrega ni un cobro.
    await c.query(`INSERT INTO distribucion.cusat_pasos(empresa_id,reparto_id,codigo_cliente,vehiculo_id,conductor_id,primera_fecha,ultima_fecha,latitud,longitud)
     VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) ON CONFLICT(empresa_id,reparto_id,codigo_cliente) DO UPDATE SET ultima_fecha=GREATEST(distribucion.cusat_pasos.ultima_fecha,excluded.ultima_fecha)`,[empresaId,p.reparto_id,p.codigo_cliente,u.id,p.conductor_id,u.reporte,u.latitud,u.longitud]);
   }
  }
  await c.query(`INSERT INTO distribucion.cusat_seguimiento_estado(empresa_id,ultima_consulta,ultimo_exito,error) VALUES($1,now(),now(),NULL) ON CONFLICT(empresa_id) DO UPDATE SET ultima_consulta=now(),ultimo_exito=now(),error=NULL`,[empresaId]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');await db.query(`INSERT INTO distribucion.cusat_seguimiento_estado(empresa_id,ultima_consulta,error) VALUES($1,now(),$2) ON CONFLICT(empresa_id) DO UPDATE SET ultima_consulta=now(),error=excluded.error`,[empresaId,'No se pudo actualizar Cusat. Se conserva el último registro.']);throw e;}finally{c.release();}
 }
 async function ciclo(){if(ocupado||!env.CUSAT_EMPRESA_CODIGO||!env.CUSAT_API_CODE||!env.CUSAT_PHONE)return;ocupado=true;try{await preparar();const empresas=await db.query(`SELECT e.id FROM distribucion.empresas e WHERE e.activo=true AND lower(e.codigo)=lower($1) AND EXISTS(SELECT 1 FROM distribucion.vehiculos v WHERE v.empresa_id=e.id AND v.activo=true AND v.tipo IN('camion','tractor'))`,[env.CUSAT_EMPRESA_CODIGO]);for(const e of empresas.rows)await procesar(e.id);}catch{console.error('Seguimiento Cusat: no se pudo completar la actualización.');}finally{ocupado=false;}}
 if(options.iniciar!==false&&env.CUSAT_API_CODE&&env.CUSAT_PHONE&&env.CUSAT_EMPRESA_CODIGO){setTimeout(ciclo,3000).unref();setInterval(ciclo,60000).unref();}
 router.get('/seguimiento/cusat',async(q,s,n)=>{try{
  if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(q.actor?.rol)||q.actor?.consulta_comercial)return s.status(403).json({error:'Acceso restringido a Distribución.'});
  const fecha=q.query.fecha||new Date(reloj()).toLocaleDateString('en-CA',{timeZone:'America/Argentina/Buenos_Aires'});if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha))return s.status(400).json({error:'Fecha inválida.'});
  await preparar();const args=[q.actor.empresa_id,fecha];
  const [puntos,pasos,estado]=await Promise.all([
   db.query(`SELECT DISTINCT ON(p.vehiculo_id) p.*,v.interno,v.patente,'CUSAT' AS origen FROM distribucion.cusat_puntos p JOIN distribucion.vehiculos v ON v.id=p.vehiculo_id AND v.empresa_id=p.empresa_id WHERE p.empresa_id=$1 AND (p.reporte AT TIME ZONE 'America/Argentina/Buenos_Aires')::date=$2::date ORDER BY p.vehiculo_id,p.reporte DESC`,args),
   db.query(`SELECT p.*,'CUSAT' AS origen FROM distribucion.cusat_pasos p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id WHERE p.empresa_id=$1 AND r.fecha=$2::date`,args),
   db.query('SELECT ultima_consulta,ultimo_exito,error FROM distribucion.cusat_seguimiento_estado WHERE empresa_id=$1',[q.actor.empresa_id])]);
  s.set('Cache-Control','no-store').json({puntos:puntos.rows,pasos:pasos.rows,estado:estado.rows[0]||null});
 }catch{n(Object.assign(Error('No se pudo consultar el seguimiento GPS.'),{status:503}));}});
 router.ciclo=ciclo;router.procesar=procesar;return router;
};
module.exports.cercano=cercano;
