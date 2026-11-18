'use strict';
module.exports=function(db,obtenerActor){
 if(!obtenerActor){const master=require('./distribucion-master')(db),credenciales=require('../services/gestion-accesos');obtenerActor=require('./distribucion-acceso-sec')(db,{master,...credenciales}).actor;}
 return async function(req,res,next){try{
  const crud=req.method==='POST'&&req.path==='/'||['PUT','DELETE'].includes(req.method)&&/^\/[0-9a-f-]{36}\/?$/i.test(req.path),listado=req.method==='GET'&&req.path==='/administracion';if(!crud&&!listado)return next();
  const a=await obtenerActor(req);if(a.rol!=='ADMIN'||!a.es_master&&!a.sectores?.includes('COMERCIAL'))return res.status(403).json({error:'Solo Master y administradores del sector Comercial pueden administrar este padrón.'});
  const e=await db.query('SELECT id FROM public.empresas WHERE lower(codigo)=lower($1) AND activo=true',[a.empresa_codigo||a.empresa]);if(e.rowCount!==1)return res.status(403).json({error:'Empresa no habilitada'});req.administracionSEC={...a,empresa_publica_id:e.rows[0].id};
  if(['PUT','DELETE'].includes(req.method)){const id=req.path.split('/')[1],u=await db.query(`SELECT id FROM public.usuarios WHERE id=$1 AND deleted_at IS NULL AND ($3::boolean OR (empresa_id=$2 AND sector_id IN(SELECT id FROM public.sectores WHERE empresa_id=$2 AND upper(codigo)='COMERCIAL' AND activo=true)))`,[id,e.rows[0].id,!!a.es_master]);if(u.rowCount!==1)return res.status(403).json({error:'No podés modificar usuarios ajenos a tu empresa'});}
  if(req.method==='POST'){const permisos=require('./distribucion-permisos-sectores')(db),sectores=permisos.validar(req.body?.sectores);await permisos.iniciar();if(!a.es_master&&sectores.some(s=>!a.sectores.includes(s)))return res.status(403).json({error:'No podés crear usuarios de otro sector'});const codigo=sectores[0];req.administracionSEC.sectoresParaCrear=sectores;const sector=await db.query("SELECT id FROM public.sectores WHERE empresa_id=$1 AND upper(codigo)=$2 AND activo=true",[e.rows[0].id,codigo]);if(sector.rowCount!==1)return res.status(409).json({error:'Sector Comercial no habilitado en esta empresa'});req.administracionSEC.sector_id=sector.rows[0].id;}
  next();
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'No se pudo verificar el permiso de administración'});}};
};
