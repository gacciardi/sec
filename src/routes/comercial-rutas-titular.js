'use strict';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
module.exports = function(db, actor) {
  const router = require('express').Router();
  const fail = (message,status=400) => Object.assign(Error(message),{status});
  const wrap = fn => (q,s,n) => Promise.resolve(fn(q,s)).catch(n);
  let ready;
  async function contexto(q) {
    const a=await actor(q);
    if(!['ADMIN','SUPERVISOR','OPERADOR'].includes(a.rol)||!a.sectores?.includes('COMERCIAL')) throw fail('Solo oficina de Comercial puede cambiar el titular de una ruta',403);
    const e=await db.query('SELECT id FROM public.empresas WHERE lower(codigo)=lower($1) AND activo=true',[a.empresa_codigo||a.empresa]);
    if(e.rowCount!==1) throw fail('Empresa no disponible',403);
    return {...a,empresa_publica_id:e.rows[0].id};
  }
  async function preparar() {
    if(!ready) ready=db.query(`CREATE TABLE IF NOT EXISTS public.rutas_cambios_titular_sec(
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      empresa_id uuid NOT NULL REFERENCES public.empresas(id), ruta_id uuid NOT NULL REFERENCES public.rutas(id),
      vendedor_anterior_id uuid, vendedor_nuevo_id uuid NOT NULL, actor_id uuid NOT NULL,
      cambiado_en timestamptz NOT NULL DEFAULT now(), clientes integer NOT NULL, asignaciones integer NOT NULL
    )`).catch(e=>{ready=null;throw e;});
    await ready;
  }
  router.get('/acceso/rutas-titulares',wrap(async(q,s)=>{
    const a=await contexto(q);
    const rutas=await db.query(`SELECT r.id,r.nombre,r.vendedor_id,r.tipo_atencion,
      trim(coalesce(u.nombre,'')||' '||coalesce(u.apellido,'')) AS vendedor,
      (SELECT count(*)::int FROM public.clientes c WHERE c.ruta_id=r.id AND c.deleted_at IS NULL) AS clientes,
      EXISTS(SELECT 1 FROM public.reemplazos_ruta rr WHERE rr.ruta_id=r.id AND rr.activo AND rr.fecha_hasta>=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS tiene_reemplazo
      FROM public.rutas r JOIN public.usuarios u ON u.id=r.vendedor_id
      WHERE r.activo AND u.empresa_id=$1 ORDER BY length(r.nombre),r.nombre`,[a.empresa_publica_id]);
    const vendedores=await db.query(`SELECT id,legajo,nombre,apellido FROM public.usuarios
      WHERE empresa_id=$1 AND rol='VENDEDOR' AND activo AND deleted_at IS NULL ORDER BY apellido,nombre`,[a.empresa_publica_id]);
    s.set('Cache-Control','no-store').json({rutas:rutas.rows,vendedores:vendedores.rows});
  }));
  router.put('/acceso/rutas/:id/titular',wrap(async(q,s)=>{
    const a=await contexto(q),b=q.body||{};
    if(!uuid.test(q.params.id)||!uuid.test(b.vendedor_id||'')||!uuid.test(b.vendedor_anterior_id||'')||b.confirmar!==true) throw fail('Seleccioná ruta, vendedor y confirmá el cambio');
    await preparar();const c=await db.connect();
    try {
      await c.query('BEGIN');
      const r=await c.query(`SELECT r.id,r.nombre,r.vendedor_id FROM public.rutas r
        JOIN public.usuarios u ON u.id=r.vendedor_id WHERE r.id=$1 AND r.activo AND u.empresa_id=$2 FOR UPDATE OF r`,[q.params.id,a.empresa_publica_id]);
      if(r.rowCount!==1) throw fail('Ruta no disponible en esta empresa',404);
      const anterior=r.rows[0];
      if(anterior.vendedor_id!==b.vendedor_anterior_id) throw fail('El titular cambió en otra PC. Actualizá antes de guardar.',409);
      const nuevo=await c.query(`SELECT id,legajo,nombre,apellido FROM public.usuarios WHERE id=$1 AND empresa_id=$2 AND rol='VENDEDOR' AND activo AND deleted_at IS NULL FOR SHARE`,[b.vendedor_id,a.empresa_publica_id]);
      if(nuevo.rowCount!==1) throw fail('El vendedor debe estar activo en esta empresa',400);
      if(anterior.vendedor_id===b.vendedor_id) throw fail('Ese vendedor ya es titular de la ruta');
      const reemplazos=await c.query(`SELECT id FROM public.reemplazos_ruta WHERE ruta_id=$1 AND activo AND fecha_hasta>=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date FOR UPDATE`,[q.params.id]);
      if(reemplazos.rowCount) throw fail('La ruta tiene un reemplazo vigente o futuro. Finalizalo en Reemplazos de Ruta antes de cambiar su titular.',409);
      await c.query('UPDATE public.rutas SET vendedor_id=$2,updated_at=now() WHERE id=$1',[q.params.id,b.vendedor_id]);
      const clientes=await c.query(`UPDATE public.clientes SET vendedor_id=$2,updated_at=now() WHERE ruta_id=$1 AND deleted_at IS NULL`,[q.params.id,b.vendedor_id]);
      const asignaciones=await c.query(`UPDATE public.clientes_asignaciones SET vendedor_id=$2,updated_at=now() WHERE ruta_id=$1 AND activo=true`,[q.params.id,b.vendedor_id]);
      await c.query(`INSERT INTO public.rutas_cambios_titular_sec(empresa_id,ruta_id,vendedor_anterior_id,vendedor_nuevo_id,actor_id,clientes,asignaciones) VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.empresa_publica_id,q.params.id,anterior.vendedor_id,b.vendedor_id,a.usuario_id||a.id,clientes.rowCount,asignaciones.rowCount]);
      await c.query('COMMIT');
      s.json({ruta:anterior.nombre,vendedor:nuevo.rows[0],clientes:clientes.rowCount,asignaciones:asignaciones.rowCount});
    } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
  }));
  return router;
};
