const express=require('express'),crypto=require('node:crypto'),multer=require('multer');
const db=require('../config/database'),importador=require('./distribucion-importador');
const router=express.Router(),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
function clave(s){const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(s,salt,64).toString('hex');}
function verifica(s,h){try{const [salt,value]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(s,salt,64),Buffer.from(value,'hex'));}catch{return false;}}
function error(msg,status=400){return Object.assign(new Error(msg),{status});}
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
async function transaction(fn){const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function audit(c,a,action,detail){await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[a.empresa_id,a.id,action,JSON.stringify(detail)]);}
function credenciales(b){for(const k of ['legajo','nombre','apellido'])if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>(k==='legajo'?20:100))throw error('Completar '+k);if(typeof b.clave!=='string'||b.clave.length<8||b.clave.length>128)throw error('Clave: entre 8 y 128 caracteres');}
async function alta(c,empresa,b,rol){
 credenciales(b);
 const enlace=await c.query(`
  SELECT e.id AS empresa_id,s.id AS sector_id
  FROM distribucion.empresas de
  JOIN public.empresas e ON lower(e.codigo)=lower(de.codigo)
  JOIN public.sectores s ON s.empresa_id=e.id
  WHERE de.id=$1 AND de.activo=true AND e.activo=true
    AND s.activo=true AND upper(s.codigo)='DISTRIBUCION'
 `,[empresa]);
 if(enlace.rowCount!==1)throw error('Empresa o sector Distribucion no disponible',409);
 const vinculo=enlace.rows[0];
 const u=await c.query(`
  INSERT INTO public.usuarios
   (nombre,apellido,email,rol,legajo,activo,empresa_id,sector_id)
  VALUES($1,$2,$3,'CONDUCTOR',$4,$5,$6,$7) RETURNING id
 `,[b.nombre.trim(),b.apellido.trim(),
    b.email||`${crypto.randomUUID()}@sec.invalid`,
    b.legajo.trim(),b.activo!==false,
    vinculo.empresa_id,vinculo.sector_id]);
 const r=await c.query(`
  INSERT INTO distribucion.miembros
   (empresa_id,usuario_id,legajo,nombre,apellido,telefono,rol,clave_hash,activo)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  RETURNING id,legajo,nombre,apellido,telefono,rol,activo
 `,[empresa,u.rows[0].id,b.legajo.trim(),b.nombre.trim(),
    b.apellido.trim(),b.telefono||'',rol,clave(b.clave),b.activo!==false]);
 return r.rows[0];
}
// Una sola inicialización por empresa, protegida por una clave del servidor.
router.post('/inicializar',wrap(async(req,res)=>{
 const secret=process.env.SEC_DISTRIBUCION_BOOTSTRAP;
 if(!secret||req.get('Authorization')!==`Bearer ${secret}`)throw error('Acceso no autorizado',401);
 const actor=await transaction(async c=>{const e=await c.query('SELECT id FROM distribucion.empresas WHERE codigo=$1 AND activo=true FOR UPDATE',[req.body.empresa]);if(!e.rowCount)throw error('Empresa no encontrada');const exists=await c.query("SELECT 1 FROM distribucion.miembros WHERE empresa_id=$1 AND rol='ADMIN'",[e.rows[0].id]);if(exists.rowCount)throw error('Empresa ya inicializada',409);const a=await alta(c,e.rows[0].id,req.body,'ADMIN');await audit(c,{empresa_id:e.rows[0].id,id:a.id},'INICIALIZACION',{legajo:a.legajo});return a;});res.status(201).json(actor);
}));
const attempts=new Map();
router.post('/login',wrap(async(req,res)=>{
 const k=req.ip,old=attempts.get(k)||{n:0,until:Date.now()+60000};if(old.until<Date.now()){old.n=0;old.until=Date.now()+60000;}old.n++;attempts.set(k,old);if(attempts.size>10000)for(const [key,v]of attempts)if(v.until<Date.now())attempts.delete(key);if(old.n>20)throw error('Esperar un minuto antes de reintentar',429);
 const b=req.body;if(typeof b.clave!=='string'||b.clave.length>128)throw error('Credenciales incorrectas',401);
 const r=await db.query(`SELECT m.*,e.codigo FROM distribucion.miembros m JOIN distribucion.empresas e ON e.id=m.empresa_id JOIN public.usuarios u ON u.id=m.usuario_id WHERE e.codigo=$1 AND e.activo=true AND m.legajo=$2 AND m.activo=true AND u.activo=true AND u.deleted_at IS NULL`,[b.empresa,b.legajo]);
 const a=r.rows[0];if(!a||!verifica(b.clave,a.clave_hash))throw error('Credenciales incorrectas',401);
 const token=crypto.randomBytes(32).toString('hex');await db.query("INSERT INTO distribucion.sesiones VALUES($1,$2,now()+interval '12 hours')",[hash(token),a.id]);res.json({token,usuario:{id:a.id,empresa:a.codigo,rol:a.rol,nombre:a.nombre,apellido:a.apellido,legajo:a.legajo}});
}));
router.use(async(req,res,next)=>{try{
 const token=(req.get('Authorization')||'').replace(/^Bearer /,'');const r=await db.query(`SELECT m.id,m.usuario_id,m.empresa_id,m.rol FROM distribucion.sesiones s JOIN distribucion.miembros m ON m.id=s.miembro_id JOIN distribucion.empresas e ON e.id=m.empresa_id JOIN public.usuarios u ON u.id=m.usuario_id WHERE s.token_hash=$1 AND s.expira>now() AND m.activo=true AND e.activo=true AND u.activo=true AND u.deleted_at IS NULL`,[hash(token)]);if(!r.rowCount)throw error('Iniciar sesión',401);req.actor=r.rows[0];next();
}catch(e){next(e);}});
const admin=(req,res,next)=>['ADMIN','SUPERVISOR'].includes(req.actor.rol)?next():next(error('Acceso restringido',403));
router.post('/logout',wrap(async(req,res)=>{await db.query('DELETE FROM distribucion.sesiones WHERE token_hash=$1',[hash((req.get('Authorization')||'').replace(/^Bearer /,''))]);res.json({ok:true});}));
router.post('/gps-apk/iniciar',wrap(async(req,res)=>{
 if(req.actor.rol!=='CONDUCTOR')throw error('Ingresar como conductor',403);
 const key='dist_'+crypto.randomBytes(32).toString('hex'),session=hash((req.get('Authorization')||'').replace(/^Bearer /,''));
 await transaction(async c=>{await c.query('UPDATE distribucion.gps_apk SET activo=false WHERE miembro_id=$1',[req.actor.id]);await c.query('INSERT INTO distribucion.gps_apk(clave_hash,sesion_hash,miembro_id) VALUES($1,$2,$3)',[hash(key),session,req.actor.id]);await audit(c,req.actor,'INICIO_GPS_APK',{});});res.json({clave:key});
}));
router.post('/gps-apk/detener',wrap(async(req,res)=>{await db.query('UPDATE distribucion.gps_apk SET activo=false WHERE miembro_id=$1',[req.actor.id]);res.json({ok:true});}));
router.get('/me',wrap(async(req,res)=>{res.json(req.actor);}));
router.get('/conductores',admin,wrap(async(req,res)=>{const r=await db.query("SELECT id,legajo,nombre,apellido,telefono,activo FROM distribucion.miembros WHERE empresa_id=$1 AND rol='CONDUCTOR' ORDER BY apellido,nombre",[req.actor.empresa_id]);res.json(r.rows);}));
router.post('/conductores',admin,wrap(async(req,res)=>{const r=await transaction(async c=>{const m=await alta(c,req.actor.empresa_id,req.body,'CONDUCTOR');await audit(c,req.actor,'ALTA_CONDUCTOR',{id:m.id,legajo:m.legajo});return m;});res.status(201).json(r);}));
router.put('/conductores/:id',admin,wrap(async(req,res)=>{
 const b=req.body;for(const k of ['legajo','nombre','apellido'])if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>(k==='legajo'?20:100))throw error('Completar '+k);if(typeof b.activo!=='boolean')throw error('Estado inválido');if(b.clave&&(b.clave.length<8||b.clave.length>128))throw error('Clave inválida');
 const r=await transaction(async c=>{const old=await c.query("SELECT id,usuario_id FROM distribucion.miembros WHERE id=$1 AND empresa_id=$2 AND rol='CONDUCTOR' FOR UPDATE",[req.params.id,req.actor.empresa_id]);if(!old.rowCount)throw error('Conductor no encontrado',404);const row=await c.query(`UPDATE distribucion.miembros SET legajo=$3,nombre=$4,apellido=$5,telefono=$6,activo=$7,clave_hash=coalesce($8,clave_hash) WHERE id=$1 AND empresa_id=$2 RETURNING id,legajo,nombre,apellido,telefono,activo`,[req.params.id,req.actor.empresa_id,b.legajo.trim(),b.nombre.trim(),b.apellido.trim(),b.telefono||'',b.activo,b.clave?clave(b.clave):null]);await c.query('UPDATE public.usuarios SET nombre=$2,apellido=$3,activo=$4,legajo=$5,updated_at=now() WHERE id=$1',[old.rows[0].usuario_id,b.nombre.trim(),b.apellido.trim(),b.activo,b.legajo.trim()]);if(b.clave||!b.activo)await c.query('DELETE FROM distribucion.sesiones WHERE miembro_id=$1',[req.params.id]);await audit(c,req.actor,'MODIFICACION_CONDUCTOR',{id:req.params.id,activo:b.activo});return row.rows[0];});res.json(r);
}));
router.get('/repartos',wrap(async(req,res)=>{const r=await db.query(`SELECT r.*,m.nombre||' '||m.apellido AS conductor,v.interno,v.patente,s.interno AS interno_semi,s.patente AS patente_semi FROM distribucion.repartos r LEFT JOIN distribucion.miembros m ON m.id=r.conductor_id AND m.empresa_id=r.empresa_id LEFT JOIN distribucion.vehiculos v ON v.id=r.principal_id AND v.empresa_id=r.empresa_id LEFT JOIN distribucion.vehiculos s ON s.id=r.semi_id AND s.empresa_id=r.empresa_id WHERE r.empresa_id=$1 AND (($3::uuid IS NOT NULL AND r.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) OR ($3::uuid IS NULL AND ($2::date IS NULL OR r.fecha=$2::date))) AND ($3::uuid IS NULL OR r.conductor_id=$3::uuid) ORDER BY r.fecha DESC,r.despacho`,[req.actor.empresa_id,req.query.fecha||null,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);res.json(r.rows);}));
router.get('/pedidos',wrap(async(req,res)=>{const r=await db.query(`SELECT p.*,r.despacho,r.conductor_nombre,r.conductor_id,c.latitud,c.longitud,c.direccion,c.radio_geocerca FROM distribucion.pedidos p JOIN distribucion.repartos r ON r.id=p.reparto_id AND r.empresa_id=p.empresa_id LEFT JOIN distribucion.clientes dc ON dc.empresa_id=p.empresa_id AND dc.codigo=p.codigo_cliente LEFT JOIN public.clientes c ON c.id=dc.cliente_id AND c.deleted_at IS NULL WHERE p.empresa_id=$1 AND (($3::uuid IS NOT NULL AND p.fecha=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) OR ($3::uuid IS NULL AND ($2::date IS NULL OR p.fecha=$2::date))) AND ($3::uuid IS NULL OR r.conductor_id=$3::uuid) ORDER BY p.fecha DESC,r.despacho,p.codigo_cliente`,[req.actor.empresa_id,req.query.fecha||null,req.actor.rol==='CONDUCTOR'?req.actor.id:null]);res.json(r.rows);}));
router.post('/importar',admin,upload.single('archivo'),wrap(async(req,res)=>{
 if(!req.file)throw error('Seleccionar Excel');const out=importador.pedidos(req.file.buffer,req.actor.empresa_id,{});if(out.errores.length)return res.status(422).json({error:'Archivo sin importar',filas:out.errores});
 const grouped=new Map();for(const p of out.pedidos){const k=p.fecha+'|'+(p.despacho||'SIN_DESPACHO');const g=grouped.get(k)||new Set();if(p.conductor)g.add(p.conductor);grouped.set(k,g);}if([...grouped.values()].some(v=>v.size>1))throw error('Un despacho tiene varios conductores: revisar el archivo');
 await transaction(async c=>{for(const p of out.pedidos){const reparto=await c.query(`INSERT INTO distribucion.repartos(empresa_id,fecha,despacho,conductor_nombre) VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id,fecha,despacho) DO UPDATE SET conductor_nombre=excluded.conductor_nombre RETURNING id`,[req.actor.empresa_id,p.fecha,p.despacho||'SIN_DESPACHO',p.conductor]);await c.query(`INSERT INTO distribucion.pedidos(empresa_id,reparto_id,fecha,numero,codigo_cliente,nombre_cliente,cantidad,importe) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(empresa_id,fecha,numero) DO UPDATE SET reparto_id=excluded.reparto_id,codigo_cliente=excluded.codigo_cliente,nombre_cliente=excluded.nombre_cliente,cantidad=excluded.cantidad,importe=excluded.importe`,[req.actor.empresa_id,reparto.rows[0].id,p.fecha,p.pedido,p.codigo,p.cliente,p.cantidad,p.importe]);}await audit(c,req.actor,'IMPORTACION_PEDIDOS',{cantidad:out.pedidos.length});});res.json({importados:out.pedidos.length});
}));
router.get('/vehiculos',admin,wrap(async(req,res)=>{const r=await db.query('SELECT id,interno,patente,tipo,activo FROM distribucion.vehiculos WHERE empresa_id=$1 ORDER BY interno',[req.actor.empresa_id]);res.json(r.rows);}));
router.post('/vehiculos/importar',admin,upload.single('archivo'),wrap(async(req,res)=>{if(!req.file)throw error('Seleccionar tabla');const rows=importador.vehiculos(req.file.buffer,req.actor.empresa_id);await transaction(async c=>{for(const v of rows)await c.query(`INSERT INTO distribucion.vehiculos(empresa_id,interno,patente,tipo) VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id,interno) DO UPDATE SET patente=excluded.patente,tipo=excluded.tipo`,[req.actor.empresa_id,v.interno,v.patente,v.tipo]);await audit(c,req.actor,'IMPORTACION_VEHICULOS',{cantidad:rows.length});});res.json({importados:rows.length});}));
router.put('/repartos/:id',admin,wrap(async(req,res)=>{const b=req.body;await transaction(async c=>{const old=await c.query('SELECT * FROM distribucion.repartos WHERE id=$1 AND empresa_id=$2 FOR UPDATE',[req.params.id,req.actor.empresa_id]);if(!old.rowCount)throw error('Reparto no encontrado',404);if(b.conductor_id){const r=await c.query("SELECT 1 FROM distribucion.miembros WHERE id=$1 AND empresa_id=$2 AND rol='CONDUCTOR' AND activo=true",[b.conductor_id,req.actor.empresa_id]);if(!r.rowCount)throw error('Conductor inválido');}let principal=null,semi=null;if(b.principal_id){const r=await c.query("SELECT * FROM distribucion.vehiculos WHERE id=$1 AND empresa_id=$2 AND tipo IN('camion','tractor') AND activo=true",[b.principal_id,req.actor.empresa_id]);principal=r.rows[0];if(!principal)throw error('Vehículo inválido');}if(b.semi_id){const r=await c.query("SELECT * FROM distribucion.vehiculos WHERE id=$1 AND empresa_id=$2 AND tipo='semi' AND activo=true",[b.semi_id,req.actor.empresa_id]);semi=r.rows[0];if(!semi||principal?.tipo!=='tractor')throw error('El semi requiere un tractor');}if(principal?.tipo==='tractor'&&!semi)throw error('Seleccionar semi');await c.query('UPDATE distribucion.repartos SET conductor_id=$3,principal_id=$4,semi_id=$5 WHERE id=$1 AND empresa_id=$2',[req.params.id,req.actor.empresa_id,b.conductor_id||null,b.principal_id||null,b.semi_id||null]);await audit(c,req.actor,'ASIGNACION_REPARTO',{id:req.params.id,anterior:old.rows[0],actual:b});});res.json({ok:true});}));
router.get('/auditoria',admin,wrap(async(req,res)=>{const r=await db.query('SELECT a.id,a.fecha,a.accion,a.detalle,m.nombre,m.apellido FROM distribucion.auditoria a LEFT JOIN distribucion.miembros m ON m.id=a.actor_id AND m.empresa_id=a.empresa_id WHERE a.empresa_id=$1 ORDER BY a.id DESC LIMIT 500',[req.actor.empresa_id]);res.json(r.rows);}));
router.use(require('./distribucion-recorridos')(db));
router.use((e,req,res,next)=>{console.error('Distribución:',e.code||e.message);res.status(e.code==='23505'?409:e.status||500).json({error:e.code==='23505'?'Registro duplicado en esta empresa':e.status?e.message:'Error de Distribución; consultar el registro del servidor'});});
module.exports=router;
module.exports._test={hash,clave,verifica,credenciales};
