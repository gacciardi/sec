'use strict';
const crypto=require('node:crypto');
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
const clave=s=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(s,salt,64).toString('hex');};
const verifica=(s,h)=>{try{const [salt,v]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(s,salt,64),Buffer.from(v,'hex'));}catch{return false;}};
const fallo=(mensaje,status=400)=>Object.assign(Error(mensaje),{status});
function validar(b,nuevo){
 if(!b||typeof b!=='object'||Array.isArray(b))throw fallo('Datos de acceso inválidos');
 if(typeof b.usuario!=='string'||!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(b.usuario))throw fallo('Usuario: 3 a 40 letras minúsculas, números, punto, guion o guion bajo');
 if(!['ADMIN','SUPERVISOR'].includes(b.perfil)||typeof b.activo!=='boolean')throw fallo('Perfil o estado inválido');
 if(!Array.isArray(b.sectores)||!b.sectores.length||b.sectores.some(s=>!['COMERCIAL','DISTRIBUCION'].includes(s))||new Set(b.sectores).size!==b.sectores.length)throw fallo('Seleccionar sectores válidos');
 if((nuevo||b.clave)&& (typeof b.clave!=='string'||b.clave.length<10||b.clave.length>128))throw fallo('Contraseña: entre 10 y 128 caracteres');
 if(b.clave!==undefined&&typeof b.clave!=='string')throw fallo('Contraseña inválida');
 if(nuevo&&(typeof b.persona_id!=='string'||!(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.persona_id))))throw fallo('Seleccionar una persona existente');
 return {...b,sectores:b.perfil==='ADMIN'?['COMERCIAL','DISTRIBUCION']:b.sectores};
}
module.exports={hash,clave,verifica,fallo,validar};
