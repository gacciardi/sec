'use strict';
module.exports=function(db,codificar){
 const router=require('express').Router();
 router.put('/usuarios/:id/clave',async(req,res,next)=>{
  let c;try{
   if(req.actor.rol!=='ADMIN')throw Object.assign(Error('Solo el administrador puede restablecer contraseñas'),{status:403});
   const b=req.body||{};if(typeof b.clave!=='string'||b.clave.length<8||b.clave.length>128||!b.clave.trim()||b.confirmacion!==b.clave)throw Object.assign(Error('Ingresá una contraseña de 8 a 128 caracteres y repetila exactamente igual.'),{status:400});
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))throw Object.assign(Error('Usuario inválido'),{status:400});
   const protegida=codificar(b.clave);c=await db.connect();await c.query('BEGIN');
   const anterior=await c.query('SELECT id,legajo,rol FROM distribucion.miembros WHERE empresa_id=$1 AND id=$2 FOR UPDATE',[req.actor.empresa_id,req.params.id]);if(!anterior.rowCount)throw Object.assign(Error('Usuario no encontrado en esta empresa'),{status:404});
   await c.query('UPDATE distribucion.miembros SET clave_hash=$3 WHERE empresa_id=$1 AND id=$2',[req.actor.empresa_id,req.params.id,protegida]);
   await c.query('DELETE FROM distribucion.sesiones WHERE miembro_id=$1',[req.params.id]);
   await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[req.actor.empresa_id,req.actor.id,'RESTABLECER_CLAVE_USUARIO',JSON.stringify({id:req.params.id,legajo:anterior.rows[0].legajo,sesiones_cerradas:true})]);await c.query('COMMIT');
   res.set('Cache-Control','no-store').json({ok:true,requiere_ingreso:String(req.actor.id)===req.params.id});
  }catch(e){if(c)await c.query('ROLLBACK');next(e);}finally{if(c)c.release();}
 });return router;
};
