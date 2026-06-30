const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
GET VISITAS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        v.id,
        v.fecha,
        v.hora_llegada,
        v.hora_salida,
        v.permanencia_segundos,
        v.latitud_llegada,
        v.longitud_llegada,
        c.nombre AS cliente,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM visitas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN usuarios u ON u.id = v.vendedor_id
      ORDER BY v.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener visitas",
      detalle: error.message
    });
  }
});
/*
=================================
LLEGADA
=================================
*/

router.post("/llegada", async (req, res) => {
  try {
    const {
      cliente_id,
      vendedor_id,
      latitud,
      longitud
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO visitas (
        cliente_id,
        vendedor_id,
        fecha,
        hora_llegada,
        latitud_llegada,
        longitud_llegada
      )
      VALUES (
        $1,
        $2,
        CURRENT_DATE,
        NOW(),
        $3,
        $4
      )
      RETURNING *
      `,
      [
        cliente_id,
        vendedor_id,
        latitud,
        longitud
      ]
    );

    res.status(201).json({
      mensaje: "Llegada registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al registrar llegada",
      detalle: error.message
    });
  }
});

/*
=================================
SALIDA
=================================
*/

router.post("/salida", async (req, res) => {
  try {
    const { visita_id } = req.body;

    const result = await db.query(
      `
      UPDATE visitas
      SET
        hora_salida = NOW(),
        permanencia_segundos =
          EXTRACT(
            EPOCH FROM (
              NOW() - hora_llegada
            )
          )::INTEGER
      WHERE id = $1
      RETURNING *
      `,
      [visita_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Visita no encontrada"
      });
    }

    res.json({
      mensaje: "Salida registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al registrar salida",
      detalle: error.message
    });
  }
});

module.exports = router;