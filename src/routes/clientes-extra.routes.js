const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const {
      cliente_id,
      vendedor_id,
      ruta_id,
      fecha,
      motivo
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO clientes_extra_dia (
        cliente_id,
        vendedor_id,
        ruta_id,
        fecha,
        motivo,
        activo
      )
      VALUES ($1,$2,$3,$4,$5,true)
      RETURNING *
      `,
      [
        cliente_id,
        vendedor_id,
        ruta_id || null,
        fecha || new Date().toISOString().slice(0,10),
        motivo || "EJECUCION"
      ]
    );

    res.status(201).json({
      mensaje: "Cliente extra asignado",
      extra: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al asignar cliente extra",
      detalle: error.message
    });
  }
});

router.get("/hoy/:vendedor_id", async (req, res) => {
  try {
    const { vendedor_id } = req.params;

    const result = await db.query(
      `
      SELECT
        e.id AS extra_id,
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.latitud,
        c.longitud,
        ca.nombre AS canal,
        fr.nombre AS frecuencia,
        r.nombre AS ruta,
        e.motivo
      FROM clientes_extra_dia e
      JOIN clientes c ON c.id = e.cliente_id
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      LEFT JOIN rutas r ON r.id = e.ruta_id
      WHERE e.vendedor_id = $1
        AND e.fecha = CURRENT_DATE
        AND e.activo = true
        AND c.deleted_at IS NULL
        AND c.activo = true
      ORDER BY c.nombre
      `,
      [vendedor_id]
    );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener clientes extra",
      detalle: error.message
    });
  }
});

console.log("RUTA CLIENTES EXTRA CARGADA");

module.exports = router;