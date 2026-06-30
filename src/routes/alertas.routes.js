const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
GET ALERTAS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT *
      FROM alertas
      ORDER BY fecha_hora DESC
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
      descripcion
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO alertas (
        vendedor_id,
        cliente_id,
        visita_id,
        tipo,
        prioridad,
        descripcion
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        vendedor_id || null,
        cliente_id || null,
        visita_id || null,
        tipo,
        prioridad,
        descripcion
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