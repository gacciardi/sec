'use strict';
const express=require('express'),crypto=require('node:crypto');
const {hash,clave,fallo}=require('../services/gestion-accesos');
module.exports=function(db){
 const router=express.Router(),limites=new Map(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 router.post('/ingreso-conductor',wrap(async(req,res)=>{
  const b=req.body||{};if(typeof b.legajo!=='string'||!b.legajo.trim()||b.legajo.length>20||b.empresa!==undefined&&(typeof b.empresa!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.empresa)))throw fallo('Legajo o empresa inválidos');
  const ahora=Date.now(),ip=req.ip||'local';for(const [k,v]of limites)if(v.fin<ahora)limites.delete(k);if(limites.size>=10000&&!limites.has(ip))throw fallo('Reintentar más tarde',429);const limite=limites.get(ip)||{n:0,fin:ahora+60000};limites.set(ip,limite);if(++limite.n>15)throw fallo('Esperar un minuto antes de reintentar',429);
  const c=await db.connect();try{await c.query('BEGIN');
   const q=await c.query(`SELECT m.id,m.empresa_id,m.legajo,m.nombre,m.apellido,e.codigo AS empresa FROM distribucion.miembros m JOIN distribucion.empresas e ON e.id=m.empresa_id JOIN public.empresas pe ON lower(pe.codigo)=lower(e.codigo) JOIN public.usuarios u ON u.id=m.usuario_id AND u.empresa_id=pe.id WHERE m.legajo=$1 AND ($2::text IS NULL OR e.codigo=$2) AND m.rol='CONDUCTOR' AND u.rol='CONDUCTOR' AND m.activo AND u.activo AND u.deleted_at IS NULL AND e.activo AND pe.activo FOR SHARE OF m,u,e,pe`,[b.legajo.trim(),b.empresa||null]);
   if(q.rowCount!==1)throw fallo(q.rowCount>1?'Indicá la empresa para ese legajo':'Conductor no habilitado en Distribución. Un administrador debe vincular su legajo con la empresa.',409);
   const a=q.rows[0],token=crypto.randomBytes(32).toString('hex'),gps='dist_'+crypto.randomBytes(32).toString('hex');
   await c.query("INSERT INTO distribucion.sesiones VALUES($1,$2,now()+interval '12 hours')",[hash(token),a.id]);
   await c.query('UPDATE distribucion.gps_apk SET activo=false WHERE miembro_id=$1',[a.id]);await c.query('INSERT INTO distribucion.gps_apk(clave_hash,sesion_hash,miembro_id) VALUES($1,$2,$3)',[hash(gps),hash(token),a.id]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[a.empresa_id,a.id,'INGRESO_CONDUCTOR_LEGAJO',JSON.stringify({legajo:a.legajo})]);await c.query('COMMIT');res.set('Cache-Control','no-store').json({token,gps_clave:gps,usuario:{...a,rol:'CONDUCTOR'}});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));return router;
};
// Se monta después de la autenticación; sólo ADMIN puede vincular el padrón operativo.
module.exports.vinculos=function(db){
 const router=express.Router();router.post('/conductores/vincular-persona',async(req,res,next)=>{
  let c;try{if(req.actor.rol!=='ADMIN')throw fallo('Solo el administrador puede vincular personas',403);const b=req.body||{};if(typeof b.legajo!=='string'||!b.legajo.trim()||b.legajo.length>20||b.confirmar_empresa!==true)throw fallo('Indicá el legajo y confirmá su pertenencia a esta empresa');c=await db.connect();await c.query('BEGIN');
   const e=await c.query('SELECT pe.id FROM public.empresas pe JOIN distribucion.empresas de ON lower(de.codigo)=lower(pe.codigo) WHERE de.id=$1 AND de.activo AND pe.activo FOR UPDATE OF pe,de',[req.actor.empresa_id]);if(e.rowCount!==1)throw fallo('Empresa no disponible',409);const empresa=e.rows[0].id;
   const q=await c.query("SELECT id,nombre,apellido,legajo,empresa_id FROM public.usuarios WHERE legajo=$1 AND rol='CONDUCTOR' AND activo AND deleted_at IS NULL AND (empresa_id IS NULL OR empresa_id=$2) FOR UPDATE",[b.legajo.trim(),empresa]);if(q.rowCount!==1)throw fallo('No se encontró un conductor inequívoco para esta empresa',409);const p=q.rows[0];
   await c.query('UPDATE public.usuarios SET empresa_id=$2 WHERE id=$1 AND empresa_id IS NULL',[p.id,empresa]);
   const m=await c.query(`INSERT INTO distribucion.miembros(empresa_id,usuario_id,legajo,nombre,apellido,rol,clave_hash,activo) VALUES($1,$2,$3,$4,$5,'CONDUCTOR',$6,true) RETURNING id`,[req.actor.empresa_id,p.id,p.legajo,p.nombre,p.apellido,clave(crypto.randomBytes(32).toString('hex'))]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[req.actor.empresa_id,req.actor.id,'VINCULAR_PERSONAL_CONDUCTOR',JSON.stringify({persona_id:p.id,legajo:p.legajo})]);await c.query('COMMIT');res.status(201).json({id:m.rows[0].id,legajo:p.legajo});
  }catch(e){if(c)await c.query('ROLLBACK');if(e.code==='23505')e=fallo('El conductor ya está vinculado o su legajo está repetido',409);next(e);}finally{if(c)c.release();}
 });return router;
};
