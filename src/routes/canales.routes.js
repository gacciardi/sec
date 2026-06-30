const express = require("express");
const db = require("../config/database");

const router = express.Router();

console.log("RUTA CANALES CARGADA");

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, nombre, permanencia_minima, activo
      FROM canales
      WHERE deleted_at IS NULL
      ORDER BY nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener canales",
      detalle: error.message
    });
  }
});

module.exports = router;