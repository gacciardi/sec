const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizarFila,leerHoja,marcarEjecucion}=require('../src/services/clientes-maestro-formato');
test('MK del maestro se convierte en programa Ejecución y atención PR, conservando día y ruta',()=>{
 const original={Codigo:56324,ClienteNombre:'VITA MARKET',ModalidadVendedor:'TAPIA LOURDES',ModadalidadRutaVentaCodigo:3,ModadlidadFrecVenta:'4-Jueves',ModalidadTipoatencion:'Mk',Canal:'(1102)-AUTOSERVICIOS'};
 const f=normalizarFila(original);assert.equal(f.__ejecucion_mk,true);assert.equal(f.modalidad,'PR');assert.equal(f.codigo_cliente,'56324');assert.equal(f.ruta,'3');assert.equal(f.frecuencia,'JU');assert.equal(f.vendedor,'TAPIA LOURDES');assert.equal(original.ModalidadTipoatencion,'Mk');assert.equal(f.semana_ejecucion,undefined);
 for(const k of ['modalidad','Modalidad de atención','modalidad_de_atencion']){const f=normalizarFila({codigo_cliente:'0007',[k]:' mK '});assert.equal(f.__ejecucion_mk,true);assert.equal(f[k],'PR');assert.equal(f.codigo_cliente,'0007');}
 assert.equal(normalizarFila({modalidad:'TA'}).__ejecucion_mk,false);assert.equal(normalizarFila({modalidad:'MKT'}).__ejecucion_mk,false);
});
test('la hoja se elige explícitamente y no se sustituye por la primera',()=>{
 const w={SheetNames:['Noviembre','16-11'],Sheets:{Noviembre:'completa','16-11':'novedades'}},X={utils:{sheet_to_json:s=>[{Codigo:s==='novedades'?56332:1,ModalidadTipoatencion:'Mk'}]}};
 assert.throws(()=>leerHoja(w,'14-11',X),/no existe/);assert.throws(()=>leerHoja(w,'',X),/Elegí la hoja/);assert.equal(leerHoja(w,'16-11',X).filas[0].codigo_cliente,'56332');
});
test('marca cada MK una sola vez como ejecución semanal y no toca otros clientes',async()=>{
 let cambios=0,ddl=0;const db={query:async(sql,a)=>{if(sql.startsWith('ALTER')){ddl++;return {rows:[]};}cambios++;assert(sql.includes('ejecucion_semanal=true'));assert(sql.includes('semana_ejecucion=NULL'));assert.deepEqual(a,[['id1','id2']]);return {rows:[{id:'id1'},{id:'id2'}]};}};
 assert.deepEqual(await marcarEjecucion(db,['id1','id1','id2']),{clientes:2,marcados:2,semanales:2});assert.equal(cambios,1);assert.equal(ddl,1);
 assert.deepEqual(await marcarEjecucion(db,[]),{clientes:0,marcados:0,semanales:0});assert.equal(cambios,1);assert.equal(ddl,1);
});
