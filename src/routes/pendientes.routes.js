const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/hoy", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        ca.nombre AS canal,
        fr.nombre AS frecuencia,
        c.latitud,
        c.longitud
      FROM clientes c
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      WHERE c.deleted_at IS NULL
      AND c.activo = true
      AND c.id NOT IN (
        SELECT DISTINCT cliente_id
        FROM visitas
        WHERE fecha = CURRENT_DATE
      )
      AND (
        (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND fr.lunes=true)
        OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND fr.martes=true)
        OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND fr.miercoles=true)
        OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND fr.jueves=true)
        OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND fr.viernes=true)
        OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND fr.sabado=true)
      )
      ORDER BY c.nombre
    `);

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener pendientes",
      detalle: error.message
    });
  }
});

module.exports = router;