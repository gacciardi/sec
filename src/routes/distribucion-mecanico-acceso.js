'use strict';
function permitido(method,path){if((['GET','POST'].includes(method)&&path==='/lavados')||(method==='PUT'&&/^\/lavados\/[a-f0-9-]{36}$/i.test(path)))return true;if((['GET','POST'].includes(method)&&path==='/mantenimiento/preventivo')||(method==='PUT'&&/^\/mantenimiento\/preventivo\/[a-f0-9-]{36}$/i.test(path)))return true;const p=String(path).replace(/\/+$/,'')||'/';return (method==='GET'&&['/me','/vehiculos','/mantenimiento/trabajos','/combustible/cargas','/anomalias-vehiculo'].includes(p))||(method==='POST'&&['/logout','/vehiculos','/vehiculos/importar','/mantenimiento/trabajos','/combustible/cargas'].includes(p))||(method==='PUT'&&/^\/vehiculos\/[a-f0-9-]{36}$/i.test(p))||(method==='PATCH'&&/^\/anomalias-vehiculo\/[a-f0-9-]{36}$/i.test(p));}
function restringir(req,res,next){if(req.actor?.rol!=='MECANICO'||permitido(req.method,req.path))return next();return next(Object.assign(new Error('El perfil Mecánico solo puede acceder a Vehículos, Mantenimiento, Combustible y Lavados.'),{status:403}));}
async function prepararPerfil(c){await c.query(`DO $$ DECLARE expr text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid='distribucion.miembros'::regclass AND conname='miembros_rol_check';
 IF expr IS NOT NULL AND position('MECANICO' in expr)=0 THEN ALTER TABLE distribucion.miembros DROP CONSTRAINT miembros_rol_check; EXECUTE 'ALTER TABLE distribucion.miembros ADD CONSTRAINT miembros_rol_check CHECK (('||expr||') OR rol = ''MECANICO'')'; END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid='public.usuarios'::regclass AND conname='usuarios_rol_check';
 IF expr IS NOT NULL AND position('MECANICO' in expr)=0 THEN ALTER TABLE public.usuarios DROP CONSTRAINT usuarios_rol_check; EXECUTE 'ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_rol_check CHECK (('||expr||') OR rol = ''MECANICO'')'; END IF;
 END $$`);}
module.exports={permitido,restringir,prepararPerfil};
