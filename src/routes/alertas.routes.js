const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
GET ALERTAS DEL DÍA
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        a.*,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM alertas a
      LEFT JOIN usuarios u ON u.id = a.vendedor_id
      WHERE DATE(a.fecha_hora) = CURRENT_DATE
      ORDER BY a.fecha_hora DESC
    `);

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener alertas",
      detalle: error.message
    });
  }
});

/*
=================================
POST ALERTA
=================================
*/

router.post("/", async (req, res) => {
  try {
    const {
      vendedor_id,
      cliente_id,
      visita_id,
      tipo,
      prioridad,
      descripcion,
      latitud,
      longitud
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO alertas (
        vendedor_id,
        cliente_id,
        visita_id,
        tipo,
        prioridad,
        descripcion,
        latitud,
        longitud,
        fecha_hora
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      RETURNING *
      `,
      [
        vendedor_id || null,
        cliente_id || null,
        visita_id || null,
        tipo || "INFO",
        prioridad || "BAJA",
        descripcion || "",
        latitud || null,
        longitud || null
      ]
    );

    res.status(201).json({
      mensaje: "Alerta creada",
      alerta: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al crear alerta",
      detalle: error.message
    });
  }
});

module.exports = router;