const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const formato=require('../src/services/clientes-maestro-formato');
async function ejecutar({hoja='16-11',fallar=false}={}){
 const queries=[],clientes=new Map(),asignaciones=[],routes={'3':{id:'ruta3',nombre:'3',vendedor_id:'lourdes',activo:true,tipo_atencion:'PRESENCIAL'},'21':{id:'ruta21',nombre:'21',vendedor_id:'tele',activo:true,tipo_atencion:'TELEVENTA'}};
 const rows=[{Codigo:'100',ClienteNombre:'Prueba MK',ModalidadTipoatencion:'TA',ModalidadVendedor:'Persona Tele',ModadalidadRutaVentaCodigo:'21',ModadlidadFrecVenta:'4-Jueves'},{Codigo:'100',ClienteNombre:'Prueba MK',ModalidadTipoatencion:'Mk',ModalidadVendedor:'Lourdes Prueba',ModadalidadRutaVentaCodigo:'3',ModadlidadFrecVenta:'4-Jueves'},{Codigo:'200',ClienteNombre:'Prueba normal',ModalidadTipoatencion:'PR',ModalidadVendedor:'Lourdes Prueba',ModadalidadRutaVentaCodigo:'3',ModadlidadFrecVenta:'5-Viernes'}];
 const query=async(sql,args=[])=>{
  queries.push({sql,args});const flat=sql.replace(/\s+/g,' ').trim();
  if(flat.includes('pg_try_advisory_xact_lock'))return {rows:[{obtenido:true}]};
  if(flat.includes('FROM usuarios'))return {rows:[{id:'lourdes',nombre:'Lourdes',apellido:'Prueba',legajo:'1',activo:true},{id:'tele',nombre:'Persona',apellido:'Tele',legajo:'2',activo:true}]};
  if(flat==='SELECT id,nombre,tipo_atencion,vendedor_id FROM rutas')return {rows:Object.values(routes)};
  if(flat.startsWith('SELECT id FROM frecuencias'))return {rows:[{id:args[0]}]};
  if(flat.startsWith('SELECT id, nombre, vendedor_id, activo FROM rutas'))return {rows:[routes[args[0]]]};
  if(flat.startsWith('SELECT * FROM clientes'))return {rows:clientes.has(args[0])?[clientes.get(args[0])]:[]};
  if(flat.startsWith('INSERT INTO clientes (')){const c={id:'cliente'+args[0],codigo_cliente:args[0],activo:true,ruta_id:args[9],frecuencia_id:args[7],radio_geocerca:30};clientes.set(args[0],c);return {rows:[{id:c.id}]};}
  if(flat.startsWith('SELECT id FROM clientes_asignaciones'))return {rows:[]};
  if(flat.startsWith('INSERT INTO clientes_asignaciones')){asignaciones.push(args);return {rows:[]};}
  if(flat.startsWith('UPDATE clientes SET es_ejecucion=true')){if(fallar)throw Error('falla de prueba');return {rows:args[0].map(id=>({id}))};}
  if(flat.startsWith('UPDATE rutas'))return {rows:[{id:args[1],nombre:'3',vendedor_id:args[0]}]};
  if(flat.includes('COUNT(*)::int AS total'))return {rows:[{total:0}]};
  return {rows:[],rowCount:0};
 };
 const pool={query,connect:async()=>({query,release(){}})},x={readFile:()=>({SheetNames:['Noviembre','16-11'],Sheets:{Noviembre:'otra','16-11':'correcta'}}),utils:{sheet_to_json:s=>s==='correcta'?rows:[]}};
 const filename=path.join(__dirname,'../src/routes/clientes-import.routes.js'),mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;
 const real=require;mod.require=n=>n==='../config/database'?pool:n==='../services/clientes-maestro-formato'?formato:n==='xlsx'?x:n==='multer'?()=>({single:()=>()=>{}}):n==='fs'?{existsSync:()=>true,unlinkSync(){}}:real(n);mod._compile(fs.readFileSync(filename,'utf8'),filename);
 const route=mod.exports.stack.find(l=>l.route?.path==='/').route;let status=200,result;const res={status(n){status=n;return this;},json(d){result=d;return this;}};
 await route.stack[1].handle({file:{path:'prueba.xlsx'},body:{hoja,suspender_ausentes:'false'}},res);
 return {status,result,queries,asignaciones};
}
test('importación parcial conserva PR y Televentas, marca MK semanal y no suspende ausentes',async()=>{
 const d=await ejecutar();assert.equal(d.status,200);assert.equal(d.result.hojaImportada,'16-11');assert.equal(d.result.ejecucionMK.marcados,1);assert.equal(d.result.ejecucionMK.semanales,1);assert.equal(d.result.suspensionDeAusentesOmitida,true);
 assert.deepEqual(d.asignaciones.map(a=>a[1]).sort(),['PR','PR','TA']);
 const update=d.queries.find(q=>q.sql.startsWith('UPDATE clientes SET es_ejecucion=true'));assert.deepEqual(update.args,[['cliente100']]);assert(!d.queries.some(q=>q.sql.includes('<> ALL($1::text[])')));assert(d.queries.some(q=>q.sql==='COMMIT'));
});
test('hoja inexistente no procesa clientes y revierte la transacción',async()=>{const d=await ejecutar({hoja:'14-11'});assert.equal(d.status,400);assert.equal(d.asignaciones.length,0);assert(d.queries.some(q=>q.sql==='ROLLBACK'));});
test('error al marcar MK revierte también las altas y asignaciones',async()=>{const d=await ejecutar({fallar:true});assert.equal(d.status,500);assert(d.queries.some(q=>q.sql==='ROLLBACK'));assert(!d.queries.some(q=>q.sql==='COMMIT'));});
