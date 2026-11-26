const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ruta='11111111-1111-4111-8111-111111111111',anterior='22222222-2222-4222-8222-222222222222',nuevo='33333333-3333-4333-8333-333333333333',empresa='44444444-4444-4444-8444-444444444444';
function preparar(options={}){
 const handlers={},queries=[];let released=false;
 const db={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('SELECT id FROM public.empresas'))return {rowCount:1,rows:[{id:empresa}]};return {rows:[],rowCount:0};},connect:async()=>({query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('FOR UPDATE OF r')){assert.match(sql,/u\.empresa_id=\$2/);assert.equal(args[1],empresa);return options.ajena?{rowCount:0,rows:[]}:{rowCount:1,rows:[{id:ruta,nombre:'12',vendedor_id:options.concurrente?nuevo:anterior}]};}
  if(sql.includes('FOR SHARE')){assert.match(sql,/empresa_id=\$2/);return {rowCount:options.inactivo?0:1,rows:[{id:nuevo,legajo:'223',nombre:'Nueva',apellido:'Vendedora'}]};}
  if(sql.includes('FROM public.reemplazos_ruta'))return {rowCount:options.reemplazo?1:0,rows:[]};
  if(sql.includes('UPDATE public.clientes_asignaciones')){assert.match(sql,/activo=true/);if(options.falla)throw Error('falla transaccional');return {rowCount:53};}
  if(sql.includes('UPDATE public.clientes SET'))return {rowCount:40};
  return {rowCount:1,rows:[]};
 },release(){released=true;}})};
 const router={get(p,h){handlers['GET '+p]=h;},put(p,h){handlers['PUT '+p]=h;}};
 const mod={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/comercial-rutas-titular.js'),'utf8'),{module:mod,require:n=>{assert.equal(n,'express');return {Router:()=>router};}});
 mod.exports(db,async()=>({id:anterior,usuario_id:anterior,rol:options.rol||'ADMIN',sectores:options.sinSector?[]:['COMERCIAL'],empresa:'rebesa'}));
 async function ejecutar(body={vendedor_id:nuevo,vendedor_anterior_id:anterior,confirmar:true}){let result,error;await handlers['PUT /acceso/rutas/:id/titular']({params:{id:ruta},body},{json:x=>result=x},e=>error=e);return {result,error};}
 return {ejecutar,queries,released:()=>released};
}
test('cambia ruta, ficha, asignaciones activas y auditoría en una sola transacción',async()=>{const p=preparar(),r=await p.ejecutar();assert.ifError(r.error);assert.equal(r.result.vendedor.legajo,'223');assert.equal(r.result.clientes,40);assert.ok(p.queries.some(x=>x.sql.includes('INSERT INTO public.rutas_cambios_titular_sec')));assert.ok(p.queries.some(x=>x.sql==='COMMIT'));assert.ok(!p.queries.some(x=>/UPDATE\s+(?:public\.)?visitas\b|\bDELETE\b/i.test(x.sql)));assert.equal(p.released(),true);});
for(const [nombre,options,status] of [['chofer',{rol:'CONDUCTOR'},403],['otro sector',{sinSector:true},403],['ruta ajena',{ajena:true},404],['vendedor inactivo o ajeno',{inactivo:true},400],['otro usuario ya cambió titular',{concurrente:true},409],['reemplazo pendiente',{reemplazo:true},409]])test('rechaza '+nombre,async()=>{const p=preparar(options),r=await p.ejecutar();assert.equal(r.error.status,status);assert.ok(!p.queries.some(x=>x.sql.startsWith('UPDATE public.')));});
test('si falla sincronizar una asignación no confirma cambios parciales',async()=>{const p=preparar({falla:true}),r=await p.ejecutar();assert.ok(r.error);assert.ok(p.queries.some(x=>x.sql==='ROLLBACK'));assert.ok(!p.queries.some(x=>x.sql==='COMMIT'));assert.equal(p.released(),true);});
