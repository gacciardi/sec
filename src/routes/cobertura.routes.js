const express = require("express");
const db = require("../config/database");

const router = express.Router();

console.log("RUTA COBERTURA CARGADA");

router.get("/hoy", async (req, res) => {
  try {
    const result = await db.query(`
      WITH clientes_programados AS (
        SELECT DISTINCT
          asig.cliente_id AS id
        FROM clientes_asignaciones asig
        INNER JOIN clientes c
          ON c.id = asig.cliente_id
        INNER JOIN frecuencias f
          ON f.id = asig.frecuencia_id
        INNER JOIN modalidades_atencion ma
          ON ma.codigo = asig.modalidad
         AND ma.activo = true
         AND ma.enviar_apk = true
        LEFT JOIN rutas r
          ON r.id = asig.ruta_id
         AND r.activo = true
        WHERE asig.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true

          -- Cobertura física:
          -- incluye rutas PRESENCIALES y asignaciones directas sin ruta.
          -- excluye TELEVENTAS.
          AND (
            asig.ruta_id IS NULL
            OR r.tipo_atencion = 'PRESENCIAL'
          )

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
        (
          SELECT COUNT(*)
          FROM clientes_programados cp
          INNER JOIN visitas_hoy vh
            ON vh.cliente_id = cp.id
        ) AS visitados
    `);

    const datos = result.rows[0];

    const programados = Number(datos.programados);
    const visitados = Number(datos.visitados);
    const pendientes = Math.max(programados - visitados, 0);

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
    console.error("ERROR COBERTURA HOY:", error);

    res.status(500).json({
      error: "Error al obtener cobertura",
      detalle: error.message
    });
  }
});

module.exports = router;
