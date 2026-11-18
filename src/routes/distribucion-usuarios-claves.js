'use strict';
module.exports=function(db,codificar,esMaster=async()=>false){
 const router=require('express').Router();
 router.put('/usuarios/:id/clave',async(req,res,next)=>{
  let c;try{
   if(req.actor.rol!=='ADMIN')throw Object.assign(Error('Solo el administrador puede restablecer contraseñas'),{status:403});
   const b=req.body||{};if(typeof b.clave!=='string'||b.clave.length<8||b.clave.length>128||!b.clave.trim()||b.confirmacion!==b.clave)throw Object.assign(Error('Ingresá una contraseña de 8 a 128 caracteres y repetila exactamente igual.'),{status:400});
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))throw Object.assign(Error('Usuario inválido'),{status:400});
   const objetivoMaster=await esMaster({empresa_id:req.actor.empresa_id,id:req.params.id});if(objetivoMaster&&!req.actor.es_master)throw Object.assign(Error('Solo el Administrador Master puede cambiar su contraseña'),{status:403});if(objetivoMaster&&b.clave.length<12)throw Object.assign(Error('La contraseña Master debe tener al menos 12 caracteres'),{status:400});
   const empresaObjetivo=objetivoMaster&&req.actor.es_master?(req.actor.empresa_origen_id||req.actor.empresa_id):req.actor.empresa_id;
   const protegida=codificar(b.clave);c=await db.connect();await c.query('BEGIN');
   const anterior=await c.query('SELECT id,legajo,rol FROM distribucion.miembros WHERE empresa_id=$1 AND id=$2 FOR UPDATE',[empresaObjetivo,req.params.id]);if(!anterior.rowCount)throw Object.assign(Error('Usuario no encontrado en esta empresa'),{status:404});
   await c.query('UPDATE distribucion.miembros SET clave_hash=$3 WHERE empresa_id=$1 AND id=$2',[empresaObjetivo,req.params.id,protegida]);
   await c.query('DELETE FROM distribucion.sesiones WHERE miembro_id=$1',[req.params.id]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[empresaObjetivo,req.actor.id,'RESTABLECER_CLAVE_USUARIO',JSON.stringify({id:req.params.id,legajo:anterior.rows[0].legajo,sesiones_cerradas:true})]);await c.query('COMMIT');
   res.set('Cache-Control','no-store').json({ok:true,requiere_ingreso:String(req.actor.id)===req.params.id});
  }catch(e){if(c)await c.query('ROLLBACK');next(e);}finally{if(c)c.release();}
 });return router;
};
