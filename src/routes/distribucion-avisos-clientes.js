'use strict';
const motor=require('../services/distribucion-aviso-cercania'),fuentes=require('./distribucion-fuentes-gps');
const TEXTO='Hola {cliente}. El camión de {empresa} está cerca de tu comercio para realizar la entrega de hoy. Por favor, preparate para recibir el pedido. Gracias.';
const error=(s,status=400)=>Object.assign(Error(s),{status});
function validar(b){if(!Number.isInteger(b?.radio_metros)||b.radio_metros<100||b.radio_metros>5000||typeof b.detectar!=='boolean'||typeof b.texto!=='string'||!b.texto.trim()||b.texto.length>600||!Number.isInteger(b.version)||b.version<0)throw error('Revisá el radio (100 a 5.000 metros), el texto y la versión.');return {...b,texto:b.texto.trim()};}
module.exports=function(db,prepararSeguimiento,options={}){
 const router=require('express').Router(),env=options.env||process.env;let listo=null,ocupado=false;
 async function preparar(){if(!listo)listo=(async()=>{await prepararSeguimiento();await db.query(`
 CREATE TABLE IF NOT EXISTS distribucion.avisos_cercania_config(
 empresa_id uuid PRIMARY KEY REFERENCES distribucion.empresas(id),radio_metros integer NOT NULL DEFAULT 500 CHECK(radio_metros BETWEEN 100 AND 5000),
 detectar boolean NOT NULL DEFAULT true,texto text NOT NULL,version integer NOT NULL DEFAULT 1,actualizado_en timestamptz NOT NULL DEFAULT now(),ultima_evaluacion timestamptz,ultimo_error text);
 CREATE TABLE IF NOT EXISTS distribucion.avisos_cercania_preparados(
 empresa_id uuid NOT NULL,reparto_id uuid NOT NULL,codigo_cliente text NOT NULL,cliente_nombre text NOT NULL,despacho text NOT NULL,
 vehiculo_id uuid NOT NULL,interno text,conductor_id uuid NOT NULL,telefono text NOT NULL,fuente text NOT NULL,
 fecha date NOT NULL,detectado_en timestamptz NOT NULL DEFAULT now(),fecha_posicion timestamptz NOT NULL,distancia_metros integer NOT NULL,
 mensaje text NOT NULL,estado text NOT NULL DEFAULT 'PREPARADO_SIN_META' CHECK(estado='PREPARADO_SIN_META'),
 PRIMARY KEY(empresa_id,reparto_id,codigo_cliente),FOREIGN KEY(empresa_id,reparto_id) REFERENCES distribucion.repartos(empresa_id,id));
 `);if(env.CUSAT_EMPRESA_CODIGO)await db.query(`INSERT INTO distribucion.avisos_cercania_config(empresa_id,texto) SELECT e.id,$2 FROM distribucion.empresas e WHERE e.activo AND lower(e.codigo)=lower($1) AND EXISTS(SELECT 1 FROM distribucion.vehiculos v WHERE v.empresa_id=e.id AND v.activo AND v.tipo IN('camion','tractor')) ON CONFLICT DO NOTHING`,[env.CUSAT_EMPRESA_CODIGO,TEXTO]);})().catch(e=>{listo=null;throw e;});await listo;}
 async function config(empresaId){const r=await db.query('SELECT * FROM distribucion.avisos_cercania_config WHERE empresa_id=$1',[empresaId]);return r.rows[0]||{empresa_id:empresaId,radio_metros:500,detectar:false,texto:TEXTO,version:0};}
 async function evaluar(empresaId){const c=await db.connect();try{await c.query('BEGIN');const lock=await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS obtenido',['avisos-cercania:'+empresaId]);if(!lock.rows[0].obtenido){await c.query('ROLLBACK');return;}
  const cfg=(await c.query('SELECT a.*,e.nombre AS empresa_nombre,(now() AT TIME ZONE \'America/Argentina/Buenos_Aires\')::date::text AS dia FROM distribucion.avisos_cercania_config a JOIN distribucion.empresas e ON e.id=a.empresa_id AND e.activo WHERE a.empresa_id=$1 FOR SHARE OF a',[empresaId])).rows[0];if(!cfg?.detectar){await c.query('COMMIT');return;}
  const tel=await c.query("SELECT to_regclass('distribucion.telefonos_clientes') AS tabla");if(!tel.rows[0].tabla){await c.query('COMMIT');return;}
  await c.query("SELECT id FROM distribucion.vehiculos WHERE empresa_id=$1 AND tipo IN('camion','tractor') ORDER BY id FOR SHARE",[empresaId]);
  const origenes=new Map((await fuentes.fuentes(c,empresaId,env)).map(f=>[f.vehiculo_id,f]));
  const [planes,cusat,celulares]=await Promise.all([
   c.query(`SELECT DISTINCT ON(r.id,p.codigo_cliente) r.id AS reparto_id,r.conductor_id,r.principal_id,r.despacho,v.interno,p.codigo_cliente,p.nombre_cliente,c.latitud,c.longitud,t.telefono
    FROM distribucion.repartos r JOIN distribucion.pedidos p ON p.reparto_id=r.id AND p.empresa_id=r.empresa_id
    JOIN distribucion.vehiculos v ON v.id=r.principal_id AND v.empresa_id=r.empresa_id AND v.activo AND v.tipo IN('camion','tractor')
    JOIN distribucion.miembros m ON m.id=r.conductor_id AND m.empresa_id=r.empresa_id AND m.activo
    JOIN distribucion.clientes dc ON dc.empresa_id=r.empresa_id AND dc.codigo=p.codigo_cliente
    JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL
    JOIN distribucion.telefonos_clientes t ON t.empresa_id=r.empresa_id AND t.cliente_id=c.id
    LEFT JOIN distribucion.visitas vi ON vi.empresa_id=r.empresa_id AND vi.reparto_id=r.id AND vi.codigo_cliente=p.codigo_cliente
    LEFT JOIN distribucion.rendicion_entregas re ON re.empresa_id=r.empresa_id AND re.reparto_id=r.id AND re.codigo_cliente=p.codigo_cliente
    LEFT JOIN distribucion.cusat_pasos paso ON paso.empresa_id=r.empresa_id AND paso.reparto_id=r.id AND paso.codigo_cliente=p.codigo_cliente
    WHERE r.empresa_id=$1 AND r.fecha=$2::date AND vi.id IS NULL AND re.id IS NULL AND paso.reparto_id IS NULL ORDER BY r.id,p.codigo_cliente,p.numero`,[empresaId,cfg.dia]),
   c.query(`SELECT DISTINCT ON(vehiculo_id) vehiculo_id,reporte AS fecha,latitud,longitud FROM distribucion.cusat_puntos WHERE empresa_id=$1 AND reporte>=now()-interval '2 minutes' ORDER BY vehiculo_id,reporte DESC`,[empresaId]),
   c.query(`SELECT DISTINCT ON(conductor_id) conductor_id,fecha,latitud,longitud,precision_metros FROM distribucion.gps WHERE empresa_id=$1 AND fecha>=now()-interval '2 minutes' ORDER BY conductor_id,fecha DESC`,[empresaId])]);
  const sat=new Map(cusat.rows.map(p=>[p.vehiculo_id,p])),mov=new Map(celulares.rows.map(p=>[p.conductor_id,p]));
  for(const p of planes.rows){const f=origenes.get(p.principal_id),g=f?.fuente==='CUSAT'?sat.get(p.principal_id):f?.fuente==='CELULAR'?mov.get(p.conductor_id):null;if(!g||!fuentes.permite(f,f.fuente,g.fecha)||p.latitud==null||p.longitud==null)continue;
   const contexto={empresa_id:empresaId,vehiculo_id:p.principal_id,reparto_id:p.reparto_id,fecha:cfg.dia},cliente={...contexto,codigo_cliente:p.codigo_cliente,latitud:Number(p.latitud),longitud:Number(p.longitud),estado:'PENDIENTE',telefono:p.telefono,acepta_avisos:false};
   const resultado=motor.evaluarCercania({contexto,cliente,posiciones:[{...g,empresa_id:empresaId,vehiculo_id:p.principal_id,fuente:f.fuente,latitud:Number(g.latitud),longitud:Number(g.longitud)}],config:{radio_metros:cfg.radio_metros,fuente_preferida:f.fuente},soloPreparacion:true});if(!resultado.apto)continue;
   const mensaje=cfg.texto.replaceAll('{cliente}',p.nombre_cliente||'cliente').replaceAll('{empresa}',cfg.empresa_nombre);
   await c.query(`INSERT INTO distribucion.avisos_cercania_preparados(empresa_id,reparto_id,codigo_cliente,cliente_nombre,despacho,vehiculo_id,interno,conductor_id,telefono,fuente,fecha,fecha_posicion,distancia_metros,mensaje) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14) ON CONFLICT DO NOTHING`,[empresaId,p.reparto_id,p.codigo_cliente,p.nombre_cliente||'',p.despacho,p.principal_id,p.interno,p.conductor_id,p.telefono,f.fuente,cfg.dia,g.fecha,resultado.distancia_metros,mensaje]);
  }await c.query('UPDATE distribucion.avisos_cercania_config SET ultima_evaluacion=now(),ultimo_error=NULL WHERE empresa_id=$1',[empresaId]);await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');await db.query('UPDATE distribucion.avisos_cercania_config SET ultimo_error=$2 WHERE empresa_id=$1',[empresaId,'No se pudieron actualizar los avisos de cercanía.']).catch(()=>{});throw e;}finally{c.release();}}
 async function ciclo(){if(ocupado)return;ocupado=true;try{await preparar();const empresas=await db.query('SELECT empresa_id FROM distribucion.avisos_cercania_config WHERE detectar=true');for(const e of empresas.rows)try{await evaluar(e.empresa_id);}catch{console.error('Avisos de cercanía: no se pudo preparar la consulta de una empresa.');}}catch{console.error('Avisos de cercanía: preparación pendiente.');}finally{ocupado=false;}}
 const acceso=(q,s,n)=>!q.actor?.consulta_comercial&&['ADMIN','SUPERVISOR','OPERADOR'].includes(q.actor?.rol)?n():n(error('Acceso restringido a oficina de Distribución.',403));
 router.get('/avisos-clientes',acceso,async(q,s,n)=>{try{await preparar();const dia=String(q.query.fecha||new Date().toLocaleDateString('en-CA',{timeZone:'America/Argentina/Buenos_Aires'}));if(!/^\d{4}-\d{2}-\d{2}$/.test(dia))throw error('Fecha inválida.');const offset=Math.max(0,parseInt(q.query.offset,10)||0),[cfg,total,filas]=await Promise.all([config(q.actor.empresa_id),db.query('SELECT count(*)::int AS total FROM distribucion.avisos_cercania_preparados WHERE empresa_id=$1 AND fecha=$2::date',[q.actor.empresa_id,dia]),db.query('SELECT * FROM distribucion.avisos_cercania_preparados WHERE empresa_id=$1 AND fecha=$2::date ORDER BY detectado_en DESC LIMIT 50 OFFSET $3',[q.actor.empresa_id,dia,offset])]);s.set('Cache-Control','no-store').json({config:cfg,conexion_meta:false,modo:'PREPARACION',total:total.rows[0].total,filas:filas.rows});}catch(e){n(e);}});
 router.put('/avisos-clientes/config',acceso,async(q,s,n)=>{try{const b=validar(q.body);await preparar();const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['avisos-config:'+q.actor.empresa_id]);const old=await configTx(c,q.actor.empresa_id);if((old?.version||0)!==b.version)throw error('La configuración cambió en otra PC. Volvé a consultar.',409);await c.query(`INSERT INTO distribucion.avisos_cercania_config(empresa_id,radio_metros,detectar,texto) VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id) DO UPDATE SET radio_metros=excluded.radio_metros,detectar=excluded.detectar,texto=excluded.texto,version=distribucion.avisos_cercania_config.version+1,actualizado_en=now()`,[q.actor.empresa_id,b.radio_metros,b.detectar,b.texto]);await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[q.actor.empresa_id,q.actor.id,'CONFIGURAR_AVISOS_CERCANIA',JSON.stringify({radio_metros:b.radio_metros,detectar:b.detectar,modo:'PREPARACION'})]);await c.query('COMMIT');s.json({ok:true});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}catch(e){n(e);}});
 async function configTx(c,id){return (await c.query('SELECT * FROM distribucion.avisos_cercania_config WHERE empresa_id=$1 FOR UPDATE',[id])).rows[0];}
 if(options.iniciar!==false){setTimeout(ciclo,5000).unref();setInterval(ciclo,30000).unref();}
 router.ciclo=ciclo;router.evaluar=evaluar;return router;
};
module.exports.validar=validar;module.exports.TEXTO=TEXTO;
