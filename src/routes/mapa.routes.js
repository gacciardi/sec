const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/clientes-estado", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.latitud,
        c.longitud,
        c.radio_geocerca,
        ca.nombre AS canal,
        fr.nombre AS frecuencia,
        CASE
          WHEN v.cliente_id IS NOT NULL THEN 'VISITADO'
          WHEN (
            (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND fr.lunes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND fr.martes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND fr.miercoles=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND fr.jueves=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND fr.viernes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND fr.sabado=true)
          ) THEN 'PENDIENTE'
          ELSE 'NO_PROGRAMADO'
        END AS estado
      FROM clientes c
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      LEFT JOIN (
        SELECT DISTINCT cliente_id
        FROM visitas
        WHERE fecha = CURRENT_DATE
      ) v ON v.cliente_id = c.id
      WHERE c.deleted_at IS NULL
        AND c.activo = true
        AND c.latitud IS NOT NULL
        AND c.longitud IS NOT NULL
      ORDER BY c.nombre
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener mapa inteligente",
      detalle: error.message
    });
  }
});

module.exports = router;