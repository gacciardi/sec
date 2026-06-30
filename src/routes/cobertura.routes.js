const express = require("express");
const db = require("../config/database");
const router = express.Router();
console.log("RUTA COBERTURA CARGADA");

router.get("/hoy", async (req, res) => {
  try {
    const result = await db.query(`
      WITH clientes_programados AS (
        SELECT c.id
        FROM clientes c
        JOIN frecuencias f ON f.id = c.frecuencia_id
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND (
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 1 AND f.lunes = true) OR
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 2 AND f.martes = true) OR
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 3 AND f.miercoles = true) OR
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 4 AND f.jueves = true) OR
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 5 AND f.viernes = true) OR
            (EXTRACT(ISODOW FROM CURRENT_DATE) = 6 AND f.sabado = true)
          )
      ),
      visitas_hoy AS (
        SELECT DISTINCT cliente_id
        FROM visitas
        WHERE fecha = CURRENT_DATE
      )
      SELECT
        CURRENT_DATE AS fecha,
        (SELECT COUNT(*) FROM clientes_programados) AS programados,
        (SELECT COUNT(*) FROM clientes_programados cp JOIN visitas_hoy vh ON vh.cliente_id = cp.id) AS visitados
    `);

    const datos = result.rows[0];

    const programados = Number(datos.programados);
    const visitados = Number(datos.visitados);
    const pendientes = programados - visitados;
    const cobertura = programados > 0
      ? Number(((visitados / programados) * 100).toFixed(2))
      : 0;

    res.json({
      fecha: datos.fecha,
      programados,
      visitados,
      pendientes,
      cobertura
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener cobertura",
      detalle: error.message
    });
  }
});

module.exports = router;