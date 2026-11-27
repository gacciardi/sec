'use strict';
const clave=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const leer=(f,nombres)=>{for(const n of nombres){const k=Object.keys(f).find(k=>clave(k)===clave(n));if(k!==undefined&&f[k]!==null&&String(f[k]).trim()!=='')return f[k];}return null;};
const codigo=v=>v==null?null:String(v).trim().replace(/\.0$/,'');
function frecuencia(v){if(v==null)return null;const original=String(v).trim(),n=clave(original.replace(/^\d+\s*-\s*/,''));return {lunes:'LU',martes:'MA',miercoles:'MI',jueves:'JU',viernes:'VI',sabado:'SA',domingo:'DO'}[n]||original;}
function normalizarFila(f){
 const fila={...f};
 const alias={codigo_cliente:['codigo_cliente','Codigo'],nombre:['nombre','ClienteNombre'],direccion:['direccion'],localidad:['localidad'],vendedor:['vendedor','vendedor_nombre','nombre_vendedor','ModalidadVendedor'],ruta:['ruta','ModadalidadRutaVentaCodigo','ModalidadRutaVentaCodigo'],frecuencia:['frecuencia','ModadlidadFrecVenta','ModalidadFrecVenta'],canal:['canal']};
 for(const [campo,nombres]of Object.entries(alias)){const valor=leer(f,nombres);if(valor!==null){fila[campo]=campo==='codigo_cliente'||campo==='ruta'?codigo(valor):campo==='frecuencia'?frecuencia(valor):campo==='canal'?String(valor).replace(/^\s*\(\d+\)\s*-\s*/,'').trim():valor;if(campo==='canal'&&String(fila[campo]).toUpperCase()==='AUTOSERVICIOS')fila[campo]='AUTOSERVICIO';for(const k of Object.keys(f))if(nombres.some(n=>clave(n)===clave(k)))fila[k]=fila[campo];}}
 const modalidad=leer(f,['Modalidad de atencion','modalidad_de_atencion','modalidad','modo','tipo_modalidad','ModalidadTipoatencion']);
 fila.__ejecucion_mk=String(modalidad??'').trim().toUpperCase()==='MK';
 // MK is a program flag, not a new attention modality in clientes_asignaciones.
 if(modalidad!==null){fila.modalidad=fila.__ejecucion_mk?'PR':String(modalidad).trim().toUpperCase();if(fila.__ejecucion_mk)for(const k of Object.keys(fila))if(['modalidaddeatencion','modalidad','modo','tipomodalidad','modalidadtipoatencion'].includes(clave(k)))fila[k]='PR';}
 return fila;
}
function leerHoja(workbook,hojaSolicitada,XLSX){
 const nombre=typeof hojaSolicitada==='string'?hojaSolicitada.trim():'';
 if(!nombre&&workbook.SheetNames.length!==1)throw Object.assign(Error('Elegí la hoja del Excel que querés importar.'),{status:400});
 const hoja=nombre||workbook.SheetNames[0];if(!workbook.SheetNames.includes(hoja))throw Object.assign(Error('La hoja seleccionada no existe en este Excel.'),{status:400});
 return {hoja,filas:XLSX.utils.sheet_to_json(workbook.Sheets[hoja],{defval:null,raw:false}).map((f,i)=>({...normalizarFila(f),__numero_fila_origen:i+2}))};
}
async function prepararEjecucion(db){await db.query('ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ejecucion_semanal boolean NOT NULL DEFAULT false');}
async function asegurarCanalesMaestro(db,filas){
 const nombres=[...new Set(filas.map(f=>String(f.canal||'').trim().toUpperCase()).filter(n=>['MAXIKIOSCOS','HELADERIAS'].includes(n)))];
 if(!nombres.length)return [];
 // Canales aprobados para el maestro de REBESA. Se hereda la permanencia
 // de Kioscos y Almacenes, respectivamente, sin inventar otras categorías.
 const d=await db.query(`INSERT INTO canales(nombre,permanencia_minima)
 SELECT nuevos.nombre,COALESCE((SELECT c.permanencia_minima FROM canales c WHERE upper(trim(c.nombre))=nuevos.base AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1),5)
 FROM (VALUES ('MAXIKIOSCOS','KIOSCOS'),('HELADERIAS','ALMACENES')) nuevos(nombre,base)
 WHERE nuevos.nombre=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM canales c WHERE upper(trim(c.nombre))=nuevos.nombre AND c.deleted_at IS NULL)
 ON CONFLICT(nombre) DO NOTHING RETURNING nombre`,[nombres]);
 return d.rows.map(c=>c.nombre);
}
async function marcarEjecucion(db,ids){
 const unicos=[...new Set(ids)];if(!unicos.length)return {clientes:0,marcados:0,semanales:0};
 await prepararEjecucion(db);
 const d=await db.query(`UPDATE clientes SET es_ejecucion=true,ejecucion_semanal=true,semana_ejecucion=NULL,updated_at=CASE WHEN es_ejecucion IS DISTINCT FROM true OR ejecucion_semanal IS DISTINCT FROM true OR semana_ejecucion IS NOT NULL THEN now() ELSE updated_at END WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL RETURNING id`,[unicos]);
 return {clientes:unicos.length,marcados:d.rows.length,semanales:d.rows.length};
}
module.exports={normalizarFila,leerHoja,marcarEjecucion,prepararEjecucion,asegurarCanalesMaestro,frecuencia};
