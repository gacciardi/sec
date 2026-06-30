const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, nombre, lunes, martes, miercoles, jueves, viernes, sabado, activo
      FROM frecuencias
      WHERE deleted_at IS NULL
      ORDER BY nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener frecuencias",
      detalle: error.message
    });
  }
});

module.exports = router;