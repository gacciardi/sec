const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        r.id,
        r.nombre,
        r.vendedor_id,
        r.activo,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM rutas r
      LEFT JOIN usuarios u ON u.id = r.vendedor_id
      ORDER BY r.nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener rutas",
      detalle: error.message
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { vendedor_id, activo } = req.body;

    const result = await db.query(
      `
      UPDATE rutas
      SET
        vendedor_id = $1,
        activo = COALESCE($2::boolean, activo),
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [vendedor_id || null, activo === undefined ? null : activo, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: "Error al actualizar ruta",
      detalle: error.message
    });
  }
});

module.exports = router;