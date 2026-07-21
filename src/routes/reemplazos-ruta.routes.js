const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/rutas", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        r.id,
        r.nombre,
        r.activo,
        r.vendedor_id AS vendedor_titular_id,
        TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido,'')) AS vendedor_titular
      FROM rutas r
      LEFT JOIN usuarios u ON u.id = r.vendedor_id
      WHERE r.activo = true
      ORDER BY r.nombre
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR LISTANDO RUTAS:", error);
    res.status(500).json({ error: "Error al listar rutas", detalle: error.message });
  }
});

router.get("/vendedores", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        id,
        nombre,
        apellido,
        legajo,
        TRIM(COALESCE(nombre,'') || ' ' || COALESCE(apellido,'')) AS nombre_completo
      FROM usuarios
      WHERE UPPER(TRIM(rol)) = 'VENDEDOR'
        AND activo = true
      ORDER BY nombre, apellido
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR LISTANDO VENDEDORES:", error);
    res.status(500).json({ error: "Error al listar vendedores", detalle: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        rr.id,
        rr.ruta_id,
        r.nombre AS ruta,
        r.vendedor_id AS vendedor_titular_id,
        TRIM(COALESCE(ut.nombre,'') || ' ' || COALESCE(ut.apellido,'')) AS vendedor_titular,
        rr.vendedor_reemplazo_id,
        TRIM(COALESCE(ur.nombre,'') || ' ' || COALESCE(ur.apellido,'')) AS vendedor_reemplazo,
        rr.fecha_desde,
        rr.fecha_hasta,
        rr.motivo,
        rr.activo,
        CASE
          WHEN rr.activo = true
           AND CURRENT_DATE BETWEEN rr.fecha_desde AND rr.fecha_hasta
          THEN true
          ELSE false
        END AS vigente_hoy
      FROM reemplazos_ruta rr
      INNER JOIN rutas r ON r.id = rr.ruta_id
      LEFT JOIN usuarios ut ON ut.id = r.vendedor_id
      INNER JOIN usuarios ur ON ur.id = rr.vendedor_reemplazo_id
      ORDER BY rr.fecha_desde DESC, r.nombre
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR LISTANDO REEMPLAZOS:", error);
    res.status(500).json({ error: "Error al listar reemplazos", detalle: error.message });
  }
});

router.post("/", async (req, res) => {
  const client = await db.connect();

  try {
    const {
      ruta_id,
      vendedor_reemplazo_id,
      fecha_desde,
      fecha_hasta,
      motivo
    } = req.body;

    if (!ruta_id || !vendedor_reemplazo_id || !fecha_desde || !fecha_hasta) {
      return res.status(400).json({
        error: "Debe indicar ruta, vendedor reemplazante, fecha desde y fecha hasta"
      });
    }

    if (fecha_hasta < fecha_desde) {
      return res.status(400).json({
        error: "La fecha hasta no puede ser anterior a la fecha desde"
      });
    }

    await client.query("BEGIN");

    const ruta = await client.query(
      `SELECT id, nombre, vendedor_id
       FROM rutas
       WHERE id = $1 AND activo = true
       LIMIT 1`,
      [ruta_id]
    );

    if (ruta.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No se encontró la ruta indicada" });
    }

    if (ruta.rows[0].vendedor_id === vendedor_reemplazo_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "El reemplazante no puede ser el mismo vendedor titular"
      });
    }

    const superpuesto = await client.query(
      `SELECT id
       FROM reemplazos_ruta
       WHERE ruta_id = $1
         AND activo = true
         AND daterange(fecha_desde, fecha_hasta, '[]')
             && daterange($2::date, $3::date, '[]')
       LIMIT 1`,
      [ruta_id, fecha_desde, fecha_hasta]
    );

    if (superpuesto.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "La ruta ya tiene un reemplazo activo que se superpone con esas fechas"
      });
    }

    const nuevo = await client.query(
      `INSERT INTO reemplazos_ruta (
         ruta_id,
         vendedor_reemplazo_id,
         fecha_desde,
         fecha_hasta,
         motivo,
         activo
       )
       VALUES ($1,$2,$3,$4,$5,true)
       RETURNING *`,
      [ruta_id, vendedor_reemplazo_id, fecha_desde, fecha_hasta, motivo || null]
    );

    await client.query("COMMIT");

    res.status(201).json({
      mensaje: "Reemplazo creado correctamente",
      reemplazo: nuevo.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR CREANDO REEMPLAZO:", error);
    res.status(500).json({ error: "Error al crear el reemplazo", detalle: error.message });
  } finally {
    client.release();
  }
});

router.patch("/:id/finalizar", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE reemplazos_ruta
       SET activo = false, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No se encontró el reemplazo" });
    }

    res.json({
      mensaje: "Reemplazo finalizado correctamente",
      reemplazo: result.rows[0]
    });

  } catch (error) {
    console.error("ERROR FINALIZANDO REEMPLAZO:", error);
    res.status(500).json({ error: "Error al finalizar el reemplazo", detalle: error.message });
  }
});

router.get("/ruta/:rutaId/vendedor-efectivo", async (req, res) => {
  try {
    const fecha = String(req.query.fecha || "").trim();

    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({
        error: "La fecha debe tener formato AAAA-MM-DD"
      });
    }

    const result = await db.query(
      `SELECT
         r.id AS ruta_id,
         r.nombre AS ruta,
         r.vendedor_id AS vendedor_titular_id,
         TRIM(COALESCE(ut.nombre,'') || ' ' || COALESCE(ut.apellido,'')) AS vendedor_titular,
         rr.id AS reemplazo_id,
         rr.vendedor_reemplazo_id,
         TRIM(COALESCE(ur.nombre,'') || ' ' || COALESCE(ur.apellido,'')) AS vendedor_reemplazo,
         rr.fecha_desde,
         rr.fecha_hasta,
         rr.motivo,
         COALESCE(rr.vendedor_reemplazo_id, r.vendedor_id) AS vendedor_efectivo_id,
         CASE
           WHEN rr.id IS NOT NULL
           THEN TRIM(COALESCE(ur.nombre,'') || ' ' || COALESCE(ur.apellido,''))
           ELSE TRIM(COALESCE(ut.nombre,'') || ' ' || COALESCE(ut.apellido,''))
         END AS vendedor_efectivo,
         CASE WHEN rr.id IS NOT NULL THEN 'REEMPLAZO' ELSE 'TITULAR' END AS origen
       FROM rutas r
       LEFT JOIN usuarios ut ON ut.id = r.vendedor_id
       LEFT JOIN LATERAL (
         SELECT rr1.*
         FROM reemplazos_ruta rr1
         WHERE rr1.ruta_id = r.id
           AND rr1.activo = true
           AND COALESCE($2::date, CURRENT_DATE)
               BETWEEN rr1.fecha_desde AND rr1.fecha_hasta
         ORDER BY rr1.created_at DESC
         LIMIT 1
       ) rr ON true
       LEFT JOIN usuarios ur ON ur.id = rr.vendedor_reemplazo_id
       WHERE r.id = $1
       LIMIT 1`,
      [req.params.rutaId, fecha || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No se encontró la ruta" });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error("ERROR OBTENIENDO VENDEDOR EFECTIVO:", error);
    res.status(500).json({
      error: "Error al obtener el vendedor efectivo",
      detalle: error.message
    });
  }
});

module.exports = router;