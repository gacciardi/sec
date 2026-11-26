const {test}=require('node:test');const assert=require('node:assert/strict');
const {evaluarCercania,elegirPosicion}=require('../src/services/distribucion-aviso-cercania');
const ahora=Date.parse('2026-11-17T13:00:00Z');
const contexto={empresa_id:'empresa-a',vehiculo_id:'camion-a',reparto_id:'reparto-a',fecha:'2026-11-17'};
const cliente={...contexto,codigo_cliente:'123',estado:'PENDIENTE',telefono:'+5491112345678',acepta_avisos:true,latitud:-34.60,longitud:-58.38};
const posicion={...contexto,fuente:'CELULAR',fecha:new Date(ahora-10000).toISOString(),precision_metros:20,latitud:-34.60,longitud:-58.38};
const base={contexto,cliente,posiciones:[posicion],ahora};
test('cliente pendiente en zona genera candidato sin efectuar envío',()=>assert.equal(evaluarCercania(base).apto,true));
test('no mezcla empresas ni vehículos',()=>{for(const cambio of [{empresa_id:'otra'},{vehiculo_id:'otro'}])assert.equal(evaluarCercania({...base,posiciones:[{...posicion,...cambio}]}).apto,false);});
test('descarta GPS atrasado, futuro, sin precisión o inválido',()=>{for(const cambio of [{fecha:new Date(ahora-121000).toISOString()},{fecha:new Date(ahora+1).toISOString()},{precision_metros:null},{latitud:null}])assert.equal(evaluarCercania({...base,posiciones:[{...posicion,...cambio}]}).apto,false);});
test('no avisa atendidos, duplicados, sin teléfono o sin habilitación',()=>{for(const cambio of [{estado:'ENTREGADO'},{telefono:'123'},{acepta_avisos:false},{fecha:'2026-11-16'}])assert.equal(evaluarCercania({...base,cliente:{...cliente,...cambio}}).apto,false);assert.equal(evaluarCercania({...base,yaAvisado:true}).apto,false);});
test('respeta fuente elegida sin respaldo automático',()=>{const cusat={...posicion,fuente:'CUSAT'};assert.equal(elegirPosicion([cusat,posicion],contexto,{},ahora).fuente,'CELULAR');assert.equal(elegirPosicion([cusat,{...posicion,fecha:'2020-01-01'}],contexto,{},ahora),null);assert.equal(elegirPosicion([cusat],contexto,{fuente_preferida:'CUSAT'},ahora).fuente,'CUSAT');});
test('radio editable y margen de precisión',()=>{const p={...posicion,latitud:-34.605};assert.equal(evaluarCercania({...base,posiciones:[p],config:{radio_metros:1000}}).apto,true);assert.equal(evaluarCercania({...base,posiciones:[p],config:{radio_metros:500}}).apto,false);});

test('Cusat sin campo de precisión puede preparar aviso con GPS reciente sin inventar precisión',()=>{const r=evaluarCercania({...base,cliente:{...cliente,acepta_avisos:false},posiciones:[{...posicion,fuente:'CUSAT',precision_metros:null}],config:{fuente_preferida:'CUSAT'},soloPreparacion:true});assert(r.apto);assert(r.solo_preparacion);assert(r.habilitacion_pendiente);assert(!evaluarCercania({...base,cliente:{...cliente,acepta_avisos:false}}).apto);});
