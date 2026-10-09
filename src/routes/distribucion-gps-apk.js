const crypto=require('crypto');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
// La APK mantiene su URL y payload. Sólo las claves dist_ entran aquí.
module.exports=function(db){
 const recorridos=require('./distribucion-recorridos')(db);
 return async function(req,res,next){
  if(req.method!=='POST'||req.path!=='/automatico'||!String(req.body?.vendedor_id||'').startsWith('dist_'))return next();
  try{
   const r=await db.query(`SELECT m.id,m.empresa_id,m.usuario_id,m.rol FROM distribucion.gps_apk a JOIN distribucion.sesiones s ON s.token_hash=a.sesion_hash JOIN distribucion.miembros m ON m.id=a.miembro_id AND m.id=s.miembro_id JOIN distribucion.empresas e ON e.id=m.empresa_id JOIN public.usuarios u ON u.id=m.usuario_id WHERE a.clave_hash=$1 AND a.activo=true AND s.expira>now() AND m.activo=true AND m.rol='CONDUCTOR' AND e.activo=true AND u.activo=true AND u.deleted_at IS NULL`,[hash(String(req.body.vendedor_id))]);
   if(!r.rowCount)return res.status(401).json({error:'Sesión GPS de distribución vencida o detenida'});
   req.actor=r.rows[0];req.body={...req.body,conductor_id:req.actor.id};req.url='/gps';recorridos(req,res,e=>{if(e)console.error('GPS distribución:',e.message);if(!res.headersSent)res.status(500).json({error:'No se pudo registrar el GPS de distribución'});});
  }catch(e){console.error('GPS distribución:',e.message);res.status(500).json({error:'No se pudo registrar el GPS de distribución'});}
 };
};
