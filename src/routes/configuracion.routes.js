const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        id,
        nombre_empresa,
        logo_base64,
        color_principal,
        updated_at
      FROM configuracion_sistema
      WHERE id = 1
    `);

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener configuración",
      detalle: error.message
    });
  }
});

router.put("/", async (req, res) => {
  try {
    const {
      nombre_empresa,
      logo_base64,
      color_principal
    } = req.body;

    const result = await db.query(
      `
      UPDATE configuracion_sistema
      SET
        nombre_empresa = COALESCE($1, nombre_empresa),
        logo_base64 = COALESCE($2, logo_base64),
        color_principal = COALESCE($3, color_principal),
        updated_at = NOW()
      WHERE id = 1
      RETURNING *
      `,
      [
        nombre_empresa || null,
        logo_base64 || null,
        color_principal || null
      ]
    );

    res.json({
      mensaje: "Configuración actualizada",
      configuracion: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al actualizar configuración",
      detalle: error.message
    });
  }
});

module.exports = router;