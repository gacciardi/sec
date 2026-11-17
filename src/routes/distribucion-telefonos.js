'use strict';
const crypto=require('node:crypto');
const normalizar=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
function telefono(v){const t=String(v??'').trim().replace(/[\s().-]/g,'');return /^\+?[1-9]\d{7,14}$/.test(t)?'+'+t.replace(/^\+/,''):null;}
function preparar(filas,clientes){
 const nombres=new Map();for(const c of clientes){const n=normalizar(c.nombre);if(!nombres.has(n))nombres.set(n,[]);nombres.get(n).push(c);}
 const salida=filas.map((f,i)=>{const n=normalizar(f.nombre),tel=telefono(f.telefono),coincidencias=nombres.get(n)||[],unico=n.split(' ').length>=2&&coincidencias.length===1;return {fila:f.fila||i+2,nombre:String(f.nombre??'').slice(0,200),original:String(f.telefono??'').slice(0,100),telefono:tel,cliente_id:unico?coincidencias[0].id:null,motivo:!n?'Sin nombre':!tel?'Revisar teléfono con código de país':unico?'Coincidencia exacta':coincidencias.length>1?'Nombre repetido en SEC':'Elegir cliente',seleccionado:!!(tel&&unico)};});
 const porCliente=new Map();for(const r of salida)if(r.cliente_id){if(!porCliente.has(r.cliente_id))porCliente.set(r.cliente_id,[]);porCliente.get(r.cliente_id).push(r);}
 for(const grupo of porCliente.values())if(grupo.length>1){for(const r of grupo){r.seleccionado=false;r.motivo=new Set(grupo.map(x=>x.telefono)).size>1?'Varios teléfonos: elegir uno':'Contacto repetido: elegir una fila';}}
 return salida;
}
module.exports=function(db){
 const express=require('express'),multer=require('multer'),ExcelJS=require('exceljs');
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024}});
 const error=(s,status=400)=>Object.assign(Error(s),{status});
 router.use('/telefonos-clientes',(req,res,next)=>{res.set('Cache-Control','no-store');return ['ADMIN','SUPERVISOR','OPERADOR'].includes(req.actor.rol)?next():next(error('Acceso restringido',403));});
 let inicializacion;
 async function iniciar(){if(!inicializacion)inicializacion=db.query(`CREATE TABLE IF NOT EXISTS distribucion.telefonos_clientes(empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),cliente_id uuid NOT NULL REFERENCES public.clientes(id),telefono text NOT NULL,actualizado_en timestamptz NOT NULL DEFAULT now(),actor_id uuid NOT NULL,PRIMARY KEY(empresa_id,cliente_id));CREATE TABLE IF NOT EXISTS distribucion.telefonos_importaciones(id uuid PRIMARY KEY,empresa_id uuid NOT NULL REFERENCES distribucion.empresas(id),actor_id uuid NOT NULL,filas jsonb NOT NULL,expira timestamptz NOT NULL DEFAULT now()+interval '2 hours',confirmada_en timestamptz);`).catch(e=>{inicializacion=null;throw e;});await inicializacion;}
 async function catalogo(c,empresa){await iniciar();return (await c.query(`SELECT c.id,dc.codigo,c.nombre,c.direccion,c.localidad,t.telefono AS telefono_actual FROM distribucion.clientes dc JOIN public.clientes c ON c.id=dc.cliente_id LEFT JOIN distribucion.telefonos_clientes t ON t.empresa_id=dc.empresa_id AND t.cliente_id=dc.cliente_id WHERE dc.empresa_id=$1 AND c.deleted_at IS NULL ORDER BY c.nombre,c.id`,[empresa])).rows;}
 router.get('/telefonos-clientes/catalogo',wrap(async(req,res)=>res.json(await catalogo(db,req.actor.empresa_id))));
 router.get('/telefonos-clientes',wrap(async(req,res)=>{await iniciar();const buscar=String(req.query.buscar||'').trim().slice(0,150),offset=Math.max(0,parseInt(req.query.offset,10)||0);const where=`FROM distribucion.telefonos_clientes t JOIN distribucion.clientes dc ON dc.empresa_id=t.empresa_id AND dc.cliente_id=t.cliente_id JOIN public.clientes c ON c.id=t.cliente_id WHERE t.empresa_id=$1 AND c.deleted_at IS NULL AND ($2='' OR c.nombre ILIKE '%'||$2||'%' OR dc.codigo ILIKE '%'||$2||'%' OR t.telefono ILIKE '%'||$2||'%')`;const total=await db.query('SELECT count(*)::int AS total '+where,[req.actor.empresa_id,buscar]);const r=await db.query('SELECT dc.codigo,c.nombre,c.direccion,t.telefono,t.actualizado_en '+where+' ORDER BY c.nombre,c.id LIMIT 50 OFFSET $3',[req.actor.empresa_id,buscar,offset]);res.json({filas:r.rows,total:total.rows[0].total});}));
 router.post('/telefonos-clientes/revisar',upload.single('archivo'),wrap(async(req,res)=>{
  if(!req.file||!req.file.originalname.toLowerCase().endsWith('.xlsx'))throw error('Seleccioná un archivo Excel .xlsx con Nombre y Telefono');
  let libro;try{libro=new ExcelJS.Workbook();await libro.xlsx.load(req.file.buffer);}catch{throw error('No se pudo leer el Excel');}
  const hoja=libro.worksheets[0];if(!hoja||hoja.rowCount>10001)throw error('El archivo debe contener hasta 10.000 contactos');
  const texto=celda=>{if(celda.type===ExcelJS.ValueType.Formula)throw error('El archivo contiene fórmulas; convertí las columnas a valores');return celda.text;};
  const encabezados=new Map();hoja.getRow(1).eachCell((c,i)=>encabezados.set(normalizar(texto(c)),i));const ni=encabezados.get('NOMBRE'),ti=encabezados.get('TELEFONO');if(!ni||!ti)throw error('Faltan las columnas Nombre y Telefono');
  const filas=[];for(let i=2;i<=hoja.rowCount;i++){const row=hoja.getRow(i),nombre=texto(row.getCell(ni)),tel=texto(row.getCell(ti));if(nombre||tel)filas.push({fila:i,nombre,telefono:tel});}
  if(!filas.length)throw error('El listado está vacío');const clientes=await catalogo(db,req.actor.empresa_id),revision=preparar(filas,clientes);await iniciar();const id=crypto.randomUUID();await db.query('DELETE FROM distribucion.telefonos_importaciones WHERE expira<now() AND empresa_id=$1',[req.actor.empresa_id]);await db.query('INSERT INTO distribucion.telefonos_importaciones(id,empresa_id,actor_id,filas) VALUES($1,$2,$3,$4)',[id,req.actor.empresa_id,req.actor.id,JSON.stringify(revision)]);res.json({id,filas:revision,clientes});
 }));
 router.post('/telefonos-clientes/confirmar',wrap(async(req,res)=>{
  const b=req.body;if(!/^[a-f0-9-]{36}$/.test(b.id||'')||!Array.isArray(b.selecciones)||!b.selecciones.length||b.selecciones.length>10000)throw error('Seleccioná contactos de una revisión válida');await iniciar();const c=await db.connect();try{await c.query('BEGIN');
   const r=await c.query('SELECT * FROM distribucion.telefonos_importaciones WHERE id=$1 AND empresa_id=$2 AND actor_id=$3 AND expira>now() FOR UPDATE',[b.id,req.actor.empresa_id,req.actor.id]);if(!r.rowCount)throw error('La revisión venció; volvé a cargar el Excel',409);if(r.rows[0].confirmada_en)throw error('Esta importación ya fue confirmada',409);
   const filas=r.rows[0].filas,clientes=new Set((await catalogo(c,req.actor.empresa_id)).map(x=>x.id)),vistos=new Set(),contactos=new Set(),selecciones=[];
   for(const s of b.selecciones){const f=filas.find(x=>x.fila===s.fila);if(!f||!f.telefono||!clientes.has(s.cliente_id)||vistos.has(s.fila)||contactos.has(s.cliente_id))throw error('Revisá la selección: un teléfono principal por cliente, sin duplicados');vistos.add(s.fila);contactos.add(s.cliente_id);selecciones.push({cliente_id:s.cliente_id,telefono:f.telefono});}
   // Serializar importaciones de la empresa, sin exponer contactos a otros perfiles.
   await c.query('SELECT id FROM distribucion.empresas WHERE id=$1 FOR UPDATE',[req.actor.empresa_id]);
   await c.query(`INSERT INTO distribucion.telefonos_clientes(empresa_id,cliente_id,telefono,actor_id) SELECT $1::uuid,t.cliente_id,t.telefono,$2::uuid FROM jsonb_to_recordset($3::jsonb) AS t(cliente_id uuid,telefono text) ON CONFLICT(empresa_id,cliente_id) DO UPDATE SET telefono=excluded.telefono,actor_id=excluded.actor_id,actualizado_en=now()`,[req.actor.empresa_id,req.actor.id,JSON.stringify(selecciones)]);
   await c.query('UPDATE distribucion.telefonos_importaciones SET confirmada_en=now(),filas=$2 WHERE id=$1',[b.id,JSON.stringify([])]);await c.query('INSERT INTO distribucion.auditoria(empresa_id,actor_id,accion,detalle) VALUES($1,$2,$3,$4)',[req.actor.empresa_id,req.actor.id,'IMPORTAR_TELEFONOS_CLIENTES',JSON.stringify({cantidad:selecciones.length,importacion_id:b.id})]);await c.query('COMMIT');res.json({guardados:selecciones.length});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 return router;
};
module.exports.normalizar=normalizar;module.exports.telefono=telefono;module.exports.preparar=preparar;
