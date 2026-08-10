const express = require("express");
const db = require("../config/database");

const router = express.Router();

function fechaValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || "").trim());
}

function fechaConsulta(req) {
  const fecha = String(req.query.fecha || "").trim();

  if (!fecha) {
    return null;
  }

  if (!fechaValida(fecha)) {
    const error = new Error("La fecha debe tener formato AAAA-MM-DD");
    error.status = 400;
    throw error;
  }

  return fecha;
}

router.get("/", async (req, res) => {
  try {
    const fecha = fechaConsulta(req);

    const rutasResult = await db.query(
      `
      WITH parametros AS (
        SELECT COALESCE($1::date, CURRENT_DATE) AS fecha_consulta
      ),
      reemplazo_vigente AS (
        SELECT DISTINCT ON (rr.ruta_id)
          rr.ruta_id,
          rr.id AS reemplazo_id,
          rr.vendedor_reemplazo_id,
          rr.fecha_desde,
          rr.fecha_hasta,
          rr.motivo
        FROM reemplazos_ruta rr
        CROSS JOIN parametros p
        WHERE rr.activo = true
          AND p.fecha_consulta BETWEEN rr.fecha_desde AND rr.fecha_hasta
        ORDER BY rr.ruta_id, rr.created_at DESC
      ),
      clientes_totales AS (
        SELECT
          c.ruta_id,
          COUNT(*)::int AS total_clientes,
          COUNT(*) FILTER (
            WHERE c.activo = true
              AND c.deleted_at IS NULL
          )::int AS clientes_activos,
          COUNT(*) FILTER (
            WHERE c.activo = true
              AND c.deleted_at IS NULL
              AND (
                c.latitud IS NULL
                OR c.longitud IS NULL
                OR c.latitud = 0
                OR c.longitud = 0
              )
          )::int AS sin_coordenadas,
          COUNT(*) FILTER (
            WHERE c.activo = true
              AND c.deleted_at IS NULL
              AND c.frecuencia_id IS NULL
          )::int AS sin_frecuencia
        FROM clientes c
        WHERE c.ruta_id IS NOT NULL
        GROUP BY c.ruta_id
      ),
      programados_hoy AS (
        SELECT
          c.ruta_id,
          COUNT(DISTINCT c.id)::int AS programados
        FROM clientes c
        LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
        CROSS JOIN parametros p
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND c.ruta_id IS NOT NULL
          AND (
            (EXTRACT(ISODOW FROM p.fecha_consulta) = 1 AND fr.lunes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 2 AND fr.martes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 3 AND fr.miercoles = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 4 AND fr.jueves = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 5 AND fr.viernes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 6 AND fr.sabado = true)
          )
        GROUP BY c.ruta_id
      ),
      visitas_hoy AS (
        SELECT
          c.ruta_id,
          COUNT(DISTINCT v.cliente_id)::int AS visitados
        FROM visitas v
        INNER JOIN clientes c ON c.id = v.cliente_id
        CROSS JOIN parametros p
        WHERE v.fecha = p.fecha_consulta
          AND c.ruta_id IS NOT NULL
          AND c.deleted_at IS NULL
        GROUP BY c.ruta_id
      )
      SELECT
        r.id AS ruta_id,
        r.nombre AS ruta,
        r.activo,
        r.vendedor_id AS vendedor_titular_id,
        TRIM(COALESCE(ut.nombre, '') || ' ' || COALESCE(ut.apellido, '')) AS vendedor_titular,
        rv.reemplazo_id,
        rv.vendedor_reemplazo_id,
        TRIM(COALESCE(ur.nombre, '') || ' ' || COALESCE(ur.apellido, '')) AS vendedor_reemplazo,
        rv.fecha_desde,
        rv.fecha_hasta,
        rv.motivo,
        COALESCE(rv.vendedor_reemplazo_id, r.vendedor_id) AS vendedor_efectivo_id,
        CASE
          WHEN rv.reemplazo_id IS NOT NULL
          THEN TRIM(COALESCE(ur.nombre, '') || ' ' || COALESCE(ur.apellido, ''))
          ELSE TRIM(COALESCE(ut.nombre, '') || ' ' || COALESCE(ut.apellido, ''))
        END AS vendedor_efectivo,
        CASE
          WHEN rv.reemplazo_id IS NOT NULL THEN 'REEMPLAZO'
          WHEN r.vendedor_id IS NOT NULL THEN 'TITULAR'
          ELSE 'SIN_VENDEDOR'
        END AS origen_vendedor,
        COALESCE(ct.total_clientes, 0)::int AS total_clientes,
        COALESCE(ct.clientes_activos, 0)::int AS clientes_activos,
        COALESCE(ph.programados, 0)::int AS programados_hoy,
        COALESCE(vh.visitados, 0)::int AS visitados_hoy,
        GREATEST(
          COALESCE(ph.programados, 0) - COALESCE(vh.visitados, 0),
          0
        )::int AS pendientes_hoy,
        COALESCE(ct.sin_coordenadas, 0)::int AS sin_coordenadas,
        COALESCE(ct.sin_frecuencia, 0)::int AS sin_frecuencia,
        CASE WHEN r.vendedor_id IS NULL THEN true ELSE false END AS alerta_sin_vendedor,
        CASE WHEN COALESCE(ct.sin_frecuencia, 0) > 0 THEN true ELSE false END AS alerta_sin_frecuencia,
        CASE WHEN COALESCE(ct.sin_coordenadas, 0) > 0 THEN true ELSE false END AS alerta_sin_coordenadas,
        CASE
          WHEN r.activo = false AND COALESCE(ct.clientes_activos, 0) > 0
          THEN true ELSE false
        END AS alerta_ruta_inactiva,
        (
          CASE WHEN r.vendedor_id IS NULL THEN 1 ELSE 0 END
          +
          CASE WHEN COALESCE(ct.sin_frecuencia, 0) > 0 THEN 1 ELSE 0 END
          +
          CASE WHEN COALESCE(ct.sin_coordenadas, 0) > 0 THEN 1 ELSE 0 END
          +
          CASE WHEN r.activo = false AND COALESCE(ct.clientes_activos, 0) > 0 THEN 1 ELSE 0 END
        )::int AS cantidad_alertas
      FROM rutas r
      LEFT JOIN usuarios ut ON ut.id = r.vendedor_id
      LEFT JOIN reemplazo_vigente rv ON rv.ruta_id = r.id
      LEFT JOIN usuarios ur ON ur.id = rv.vendedor_reemplazo_id
      LEFT JOIN clientes_totales ct ON ct.ruta_id = r.id
      LEFT JOIN programados_hoy ph ON ph.ruta_id = r.id
      LEFT JOIN visitas_hoy vh ON vh.ruta_id = r.id
      ORDER BY
        CASE WHEN r.activo = true THEN 0 ELSE 1 END,
        r.nombre
      `,
      [fecha]
    );

    const huerfanosResult = await db.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND c.ruta_id IS NULL
        )::int AS sin_ruta,
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND c.ruta_id IS NULL
            AND c.vendedor_id IS NULL
        )::int AS sin_ruta_ni_vendedor,
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND c.frecuencia_id IS NULL
        )::int AS sin_frecuencia,
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND (
              c.latitud IS NULL
              OR c.longitud IS NULL
              OR c.latitud = 0
              OR c.longitud = 0
            )
        )::int AS sin_coordenadas,
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND c.ruta_id IS NOT NULL
            AND r.id IS NOT NULL
            AND r.activo = false
        )::int AS en_ruta_inactiva,
        COUNT(DISTINCT r.id) FILTER (
          WHERE r.id IS NOT NULL
            AND r.activo = true
            AND r.vendedor_id IS NULL
        )::int AS rutas_sin_vendedor,
        COUNT(*) FILTER (
          WHERE c.deleted_at IS NULL
            AND c.activo = true
            AND r.id IS NOT NULL
            AND r.activo = true
            AND r.vendedor_id IS NULL
        )::int AS clientes_en_rutas_sin_vendedor,
        COUNT(DISTINCT r.id) FILTER (
          WHERE r.id IS NOT NULL
            AND r.activo = false
            AND c.deleted_at IS NULL
            AND c.activo = true
        )::int AS rutas_inactivas_con_clientes
      FROM clientes c
      LEFT JOIN rutas r ON r.id = c.ruta_id
      `
    );

    res.json({
      fecha: fecha || new Date().toISOString().slice(0, 10),
      resumen_global: huerfanosResult.rows[0],
      rutas: rutasResult.rows
    });

  } catch (error) {
    console.error("ERROR DIAGNOSTICO RUTAS:", error);

    res.status(error.status || 500).json({
      error: error.status ? error.message : "Error al obtener diagnóstico de rutas",
      detalle: error.message
    });
  }
});

router.get("/ruta/:rutaId", async (req, res) => {
  try {
    const fecha = fechaConsulta(req);
    const { rutaId } = req.params;

    const rutaResult = await db.query(
      `
      WITH parametros AS (
        SELECT COALESCE($2::date, CURRENT_DATE) AS fecha_consulta
      ),
      reemplazo AS (
        SELECT rr.*
        FROM reemplazos_ruta rr
        CROSS JOIN parametros p
        WHERE rr.ruta_id = $1
          AND rr.activo = true
          AND p.fecha_consulta BETWEEN rr.fecha_desde AND rr.fecha_hasta
        ORDER BY rr.created_at DESC
        LIMIT 1
      )
      SELECT
        r.id AS ruta_id,
        r.nombre AS ruta,
        r.activo,
        r.vendedor_id AS vendedor_titular_id,
        TRIM(COALESCE(ut.nombre, '') || ' ' || COALESCE(ut.apellido, '')) AS vendedor_titular,
        re.id AS reemplazo_id,
        re.vendedor_reemplazo_id,
        TRIM(COALESCE(ur.nombre, '') || ' ' || COALESCE(ur.apellido, '')) AS vendedor_reemplazo,
        re.fecha_desde,
        re.fecha_hasta,
        re.motivo,
        COALESCE(re.vendedor_reemplazo_id, r.vendedor_id) AS vendedor_efectivo_id,
        CASE
          WHEN re.id IS NOT NULL THEN 'REEMPLAZO'
          WHEN r.vendedor_id IS NOT NULL THEN 'TITULAR'
          ELSE 'SIN_VENDEDOR'
        END AS origen_vendedor
      FROM rutas r
      LEFT JOIN usuarios ut ON ut.id = r.vendedor_id
      LEFT JOIN reemplazo re ON true
      LEFT JOIN usuarios ur ON ur.id = re.vendedor_reemplazo_id
      WHERE r.id = $1
      LIMIT 1
      `,
      [rutaId, fecha]
    );

    if (rutaResult.rows.length === 0) {
      return res.status(404).json({ error: "Ruta no encontrada" });
    }

    const clientesResult = await db.query(
      `
      WITH parametros AS (
        SELECT COALESCE($2::date, CURRENT_DATE) AS fecha_consulta
      )
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.activo,
        c.ruta_id,
        c.vendedor_id AS vendedor_directo_id,
        c.frecuencia_id,
        fr.nombre AS frecuencia,
        c.latitud,
        c.longitud,
        CASE WHEN c.frecuencia_id IS NULL THEN true ELSE false END AS sin_frecuencia,
        CASE
          WHEN c.latitud IS NULL
            OR c.longitud IS NULL
            OR c.latitud = 0
            OR c.longitud = 0
          THEN true ELSE false
        END AS sin_coordenadas,
        CASE
          WHEN (
            (EXTRACT(ISODOW FROM p.fecha_consulta) = 1 AND fr.lunes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 2 AND fr.martes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 3 AND fr.miercoles = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 4 AND fr.jueves = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 5 AND fr.viernes = true)
            OR (EXTRACT(ISODOW FROM p.fecha_consulta) = 6 AND fr.sabado = true)
          )
          THEN true ELSE false
        END AS corresponde_fecha,
        EXISTS (
          SELECT 1
          FROM visitas v
          WHERE v.cliente_id = c.id
            AND v.fecha = p.fecha_consulta
        ) AS visitado_fecha
      FROM clientes c
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      CROSS JOIN parametros p
      WHERE c.deleted_at IS NULL
        AND c.ruta_id = $1
      ORDER BY
        CASE WHEN c.activo = true THEN 0 ELSE 1 END,
        c.nombre
      `,
      [rutaId, fecha]
    );

    res.json({
      fecha: fecha || new Date().toISOString().slice(0, 10),
      ruta: rutaResult.rows[0],
      clientes: clientesResult.rows
    });

  } catch (error) {
    console.error("ERROR DETALLE DIAGNOSTICO RUTA:", error);

    res.status(error.status || 500).json({
      error: error.status ? error.message : "Error al obtener detalle de la ruta",
      detalle: error.message
    });
  }
});

router.get("/clientes-problema/listado", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.activo,
        c.ruta_id,
        r.nombre AS ruta,
        r.activo AS ruta_activa,
        r.vendedor_id AS vendedor_ruta_id,
        c.vendedor_id AS vendedor_directo_id,
        TRIM(COALESCE(ud.nombre, '') || ' ' || COALESCE(ud.apellido, '')) AS vendedor_directo,
        TRIM(COALESCE(ur.nombre, '') || ' ' || COALESCE(ur.apellido, '')) AS vendedor_ruta,
        c.frecuencia_id,
        fr.nombre AS frecuencia,
        CASE
          WHEN c.ruta_id IS NULL AND c.vendedor_id IS NULL THEN 'SIN_RUTA_NI_VENDEDOR'
          WHEN c.ruta_id IS NULL THEN 'SIN_RUTA'
          WHEN r.id IS NOT NULL AND r.vendedor_id IS NULL THEN 'RUTA_SIN_VENDEDOR'
          WHEN r.id IS NOT NULL AND r.activo = false THEN 'RUTA_INACTIVA'
          WHEN c.frecuencia_id IS NULL THEN 'SIN_FRECUENCIA'
          WHEN c.latitud IS NULL
            OR c.longitud IS NULL
            OR c.latitud = 0
            OR c.longitud = 0
          THEN 'SIN_COORDENADAS'
          ELSE 'REVISAR'
        END AS problema
      FROM clientes c
      LEFT JOIN rutas r ON r.id = c.ruta_id
      LEFT JOIN usuarios ud ON ud.id = c.vendedor_id
      LEFT JOIN usuarios ur ON ur.id = r.vendedor_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      WHERE c.deleted_at IS NULL
        AND c.activo = true
        AND (
          c.ruta_id IS NULL
          OR (r.id IS NOT NULL AND r.vendedor_id IS NULL)
          OR (r.id IS NOT NULL AND r.activo = false)
          OR c.frecuencia_id IS NULL
          OR c.latitud IS NULL
          OR c.longitud IS NULL
          OR c.latitud = 0
          OR c.longitud = 0
        )
      ORDER BY
        CASE
          WHEN c.ruta_id IS NULL AND c.vendedor_id IS NULL THEN 1
          WHEN c.ruta_id IS NULL THEN 2
          WHEN r.vendedor_id IS NULL THEN 3
          WHEN r.activo = false THEN 4
          WHEN c.frecuencia_id IS NULL THEN 5
          ELSE 6
        END,
        c.nombre
      `
    );

    res.json(result.rows);

  } catch (error) {
    console.error("ERROR CLIENTES PROBLEMA:", error);

    res.status(500).json({
      error: "Error al obtener clientes con problemas",
      detalle: error.message
    });
  }
});

router.get("/catalogos/opciones", async (req, res) => {
  try {
    const [rutas, vendedores, frecuencias] = await Promise.all([
      db.query(`
        SELECT id, nombre, activo, vendedor_id
        FROM rutas
        ORDER BY nombre
      `),
      db.query(`
        SELECT
          id,
          nombre,
          apellido,
          legajo,
          TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS nombre_completo
        FROM usuarios
        WHERE UPPER(TRIM(rol)) = 'VENDEDOR'
          AND activo = true
        ORDER BY apellido, nombre
      `),
      db.query(`
        SELECT id, nombre
        FROM frecuencias
        ORDER BY nombre
      `)
    ]);

    res.json({
      rutas: rutas.rows,
      vendedores: vendedores.rows,
      frecuencias: frecuencias.rows
    });

  } catch (error) {
    console.error("ERROR CATALOGOS DIAGNOSTICO:", error);

    res.status(500).json({
      error: "Error al obtener opciones de corrección",
      detalle: error.message
    });
  }
});

router.put("/ruta/:rutaId/vendedor", async (req, res) => {
  try {
    const { rutaId } = req.params;
    const vendedorId = req.body.vendedor_id || null;

    if (!vendedorId) {
      return res.status(400).json({ error: "Debe seleccionar un vendedor" });
    }

    const vendedor = await db.query(
      `
      SELECT id
      FROM usuarios
      WHERE id = $1
        AND UPPER(TRIM(rol)) = 'VENDEDOR'
        AND activo = true
      LIMIT 1
      `,
      [vendedorId]
    );

    if (vendedor.rows.length === 0) {
      return res.status(400).json({ error: "El vendedor seleccionado no es válido" });
    }

    const result = await db.query(
      `
      UPDATE rutas
      SET vendedor_id = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [vendedorId, rutaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ruta no encontrada" });
    }

    res.json({
      mensaje: "Vendedor asignado a la ruta correctamente",
      ruta: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR ASIGNANDO VENDEDOR A RUTA:", error);

    res.status(500).json({
      error: "Error al asignar vendedor a la ruta",
      detalle: error.message
    });
  }
});

router.put("/cliente/:clienteId/ruta", async (req, res) => {
  try {
    const { clienteId } = req.params;
    const rutaId = req.body.ruta_id || null;

    if (!rutaId) {
      return res.status(400).json({ error: "Debe seleccionar una ruta" });
    }

    const ruta = await db.query(
      `SELECT id FROM rutas WHERE id = $1 LIMIT 1`,
      [rutaId]
    );

    if (ruta.rows.length === 0) {
      return res.status(400).json({ error: "La ruta seleccionada no existe" });
    }

    const result = await db.query(
      `
      UPDATE clientes
      SET ruta_id = $1, updated_at = NOW()
      WHERE id = $2
        AND deleted_at IS NULL
      RETURNING *
      `,
      [rutaId, clienteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({
      mensaje: "Ruta asignada al cliente correctamente",
      cliente: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR ASIGNANDO RUTA A CLIENTE:", error);

    res.status(500).json({
      error: "Error al asignar ruta al cliente",
      detalle: error.message
    });
  }
});

router.put("/cliente/:clienteId/frecuencia", async (req, res) => {
  try {
    const { clienteId } = req.params;
    const frecuenciaId = req.body.frecuencia_id || null;

    if (!frecuenciaId) {
      return res.status(400).json({ error: "Debe seleccionar una frecuencia" });
    }

    const frecuencia = await db.query(
      `SELECT id FROM frecuencias WHERE id = $1 LIMIT 1`,
      [frecuenciaId]
    );

    if (frecuencia.rows.length === 0) {
      return res.status(400).json({ error: "La frecuencia seleccionada no existe" });
    }

    const result = await db.query(
      `
      UPDATE clientes
      SET frecuencia_id = $1, updated_at = NOW()
      WHERE id = $2
        AND deleted_at IS NULL
      RETURNING *
      `,
      [frecuenciaId, clienteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({
      mensaje: "Frecuencia asignada correctamente",
      cliente: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR ASIGNANDO FRECUENCIA:", error);

    res.status(500).json({
      error: "Error al asignar frecuencia",
      detalle: error.message
    });
  }
});

router.patch("/ruta/:rutaId/activar", async (req, res) => {
  try {
    const result = await db.query(
      `
      UPDATE rutas
      SET activo = true, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [req.params.rutaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ruta no encontrada" });
    }

    res.json({
      mensaje: "Ruta activada correctamente",
      ruta: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR ACTIVANDO RUTA:", error);

    res.status(500).json({
      error: "Error al activar la ruta",
      detalle: error.message
    });
  }
});

module.exports = router;