const express = require("express");
const db = require("../config/database");

const router = express.Router();

const DIA_SQL = `
  (
    (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND f.lunes=true)
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND f.martes=true)
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND f.miercoles=true)
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND f.jueves=true)
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND f.viernes=true)
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND f.sabado=true)
  )
`;

/*
=================================
DASHBOARD GENERAL VENDEDORES
=================================
*/

router.get("/vendedores", async (req, res) => {
  try {
    const result = await db.query(`
      WITH clientes_dia AS (

        SELECT DISTINCT
          COALESCE(r.vendedor_id, c.vendedor_id) AS vendedor_id,
          c.id AS cliente_id
        FROM clientes c
        LEFT JOIN rutas r
          ON r.id = c.ruta_id
          AND r.activo = true
        LEFT JOIN frecuencias f
          ON f.id = c.frecuencia_id
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND COALESCE(r.vendedor_id, c.vendedor_id) IS NOT NULL
          AND ${DIA_SQL}

        UNION

        SELECT DISTINCT
          e.vendedor_id,
          e.cliente_id
        FROM clientes_extra_dia e
        JOIN clientes c
          ON c.id = e.cliente_id
        WHERE e.fecha = CURRENT_DATE
          AND e.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true

        UNION

        SELECT DISTINCT
          tvp.trade_id AS vendedor_id,
          tvp.cliente_id
        FROM trade_visit_plan tvp
        JOIN frecuencias f
          ON f.id = tvp.frecuencia_id
        JOIN clientes c
          ON c.id = tvp.cliente_id
        WHERE tvp.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true
          AND tvp.semana =
              LEAST(
                CEIL(
                  EXTRACT(DAY FROM CURRENT_DATE) / 7.0
                )::int,
                5
              )
          AND ${DIA_SQL}
          AND NOT EXISTS (
            SELECT 1
            FROM reemplazos_ruta rr
            JOIN rutas r2
              ON r2.id = rr.ruta_id
             AND r2.activo = true
            WHERE rr.vendedor_reemplazo_id = tvp.trade_id
              AND rr.activo = true
              AND CURRENT_DATE
                  BETWEEN rr.fecha_desde AND rr.fecha_hasta
          )

      ),
      programados AS (
        SELECT
          vendedor_id,
          COUNT(DISTINCT cliente_id) AS programados
        FROM clientes_dia
        GROUP BY vendedor_id
      ),
      visitados AS (
        SELECT
          vendedor_id,
          COUNT(DISTINCT cliente_id) AS visitados
        FROM visitas
        WHERE fecha = CURRENT_DATE
        GROUP BY vendedor_id
      )
      SELECT
        u.id AS vendedor_id,
        u.nombre || ' ' || u.apellido AS vendedor,
        u.legajo,
        COALESCE(p.programados,0) AS programados,
        COALESCE(v.visitados,0) AS visitados,
        lg.fecha_hora AS ultimo_gps,
        va.hora_llegada AS llegada_actual,
        va.cliente_actual
      FROM usuarios u
      LEFT JOIN programados p
        ON p.vendedor_id = u.id
      LEFT JOIN visitados v
        ON v.vendedor_id = u.id
      LEFT JOIN LATERAL (
        SELECT fecha_hora
        FROM gps_logs
        WHERE vendedor_id = u.id
          AND DATE(fecha_hora) = CURRENT_DATE
        ORDER BY fecha_hora DESC
        LIMIT 1
      ) lg ON true
      LEFT JOIN LATERAL (
        SELECT
          vi.hora_llegada,
          c.nombre AS cliente_actual
        FROM visitas vi
        LEFT JOIN clientes c
          ON c.id = vi.cliente_id
        WHERE vi.vendedor_id = u.id
          AND vi.fecha = CURRENT_DATE
          AND vi.hora_salida IS NULL
        ORDER BY vi.hora_llegada DESC
        LIMIT 1
      ) va ON true
      WHERE UPPER(TRIM(u.rol)) IN ('VENDEDOR', 'TRADE_MARKETING')
        AND u.deleted_at IS NULL
        AND u.activo = true
      ORDER BY u.apellido, u.nombre
    `);

    const datos = result.rows.map(r => {
      const programados = Number(r.programados || 0);
      const visitados = Number(r.visitados || 0);
      const pendientes = Math.max(programados - visitados, 0);

      return {
        vendedor_id: r.vendedor_id,
        vendedor: r.vendedor,
        legajo: r.legajo,
        programados,
        visitados,
        pendientes,
        cobertura: programados > 0
          ? Number(Math.min((visitados / programados) * 100, 100).toFixed(2))
          : 0,
        ultimo_gps: r.ultimo_gps,
        llegada_actual: r.llegada_actual,
        cliente_actual: r.cliente_actual
      };
    });

    res.json(datos);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener dashboard vendedores",
      detalle: error.message
    });
  }
});

/*
=================================
ALERTAS OPERATIVAS
=================================
*/

router.get("/alertas-operativas", async (req, res) => {
  try {
    const result = await db.query(`
      WITH clientes_dia AS (

        SELECT DISTINCT
          COALESCE(r.vendedor_id, c.vendedor_id) AS vendedor_id,
          c.id AS cliente_id
        FROM clientes c
        LEFT JOIN rutas r
          ON r.id = c.ruta_id
          AND r.activo = true
        LEFT JOIN frecuencias f
          ON f.id = c.frecuencia_id
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND COALESCE(r.vendedor_id, c.vendedor_id) IS NOT NULL
          AND ${DIA_SQL}

        UNION

        SELECT DISTINCT
          e.vendedor_id,
          e.cliente_id
        FROM clientes_extra_dia e
        JOIN clientes c
          ON c.id = e.cliente_id
        WHERE e.fecha = CURRENT_DATE
          AND e.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true

        UNION

        SELECT DISTINCT
          tvp.trade_id AS vendedor_id,
          tvp.cliente_id
        FROM trade_visit_plan tvp
        JOIN frecuencias f
          ON f.id = tvp.frecuencia_id
        JOIN clientes c
          ON c.id = tvp.cliente_id
        WHERE tvp.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true
          AND tvp.semana =
              LEAST(
                CEIL(
                  EXTRACT(DAY FROM CURRENT_DATE) / 7.0
                )::int,
                5
              )
          AND ${DIA_SQL}
          AND NOT EXISTS (
            SELECT 1
            FROM reemplazos_ruta rr
            JOIN rutas r2
              ON r2.id = rr.ruta_id
             AND r2.activo = true
            WHERE rr.vendedor_reemplazo_id = tvp.trade_id
              AND rr.activo = true
              AND CURRENT_DATE
                  BETWEEN rr.fecha_desde AND rr.fecha_hasta
          )

      ),
      programados AS (
        SELECT
          vendedor_id,
          COUNT(DISTINCT cliente_id) AS programados
        FROM clientes_dia
        GROUP BY vendedor_id
      ),
      visitados AS (
        SELECT
          vendedor_id,
          COUNT(DISTINCT cliente_id) AS visitados
        FROM visitas
        WHERE fecha = CURRENT_DATE
        GROUP BY vendedor_id
      )
      SELECT
        u.id AS vendedor_id,
        u.nombre || ' ' || u.apellido AS vendedor,
        u.legajo,
        COALESCE(p.programados,0) AS programados,
        COALESCE(v.visitados,0) AS visitados,
        lg.fecha_hora AS ultimo_gps,
        va.hora_llegada,
        va.cliente_actual
      FROM usuarios u
      LEFT JOIN programados p
        ON p.vendedor_id = u.id
      LEFT JOIN visitados v
        ON v.vendedor_id = u.id
      LEFT JOIN LATERAL (
        SELECT fecha_hora
        FROM gps_logs
        WHERE vendedor_id = u.id
          AND DATE(fecha_hora) = CURRENT_DATE
        ORDER BY fecha_hora DESC
        LIMIT 1
      ) lg ON true
      LEFT JOIN LATERAL (
        SELECT
          vi.hora_llegada,
          c.nombre AS cliente_actual
        FROM visitas vi
        LEFT JOIN clientes c
          ON c.id = vi.cliente_id
        WHERE vi.vendedor_id = u.id
          AND vi.fecha = CURRENT_DATE
          AND vi.hora_salida IS NULL
        ORDER BY vi.hora_llegada DESC
        LIMIT 1
      ) va ON true
      WHERE UPPER(TRIM(u.rol)) IN ('VENDEDOR', 'TRADE_MARKETING')
        AND u.deleted_at IS NULL
        AND u.activo = true
    `);

    const ahora = new Date();
    const alertas = [];

    result.rows.forEach(r => {
      const vendedor = `${r.vendedor} - Legajo ${r.legajo || ""}`;
      const programados = Number(r.programados || 0);
      const visitados = Number(r.visitados || 0);
      const cobertura = programados > 0
        ? (visitados / programados) * 100
        : 0;

      if (!r.ultimo_gps) {
        alertas.push({
          tipo: "SIN_GPS",
          prioridad: "ALTA",
          descripcion: `${vendedor} no reportó GPS hoy`
        });
      } else {
        const minGps = Math.floor((ahora - new Date(r.ultimo_gps)) / 60000);

        if (minGps > 15) {
          alertas.push({
            tipo: "GPS_DEMORADO",
            prioridad: "ALTA",
            descripcion: `${vendedor} no reporta GPS hace ${minGps} minutos`
          });
        }
      }

      if (r.hora_llegada) {
        const minCliente = Math.floor((ahora - new Date(r.hora_llegada)) / 60000);

        if (minCliente > 60) {
          alertas.push({
            tipo: "MUCHO_TIEMPO_CLIENTE",
            prioridad: "MEDIA",
            descripcion: `${vendedor} lleva ${minCliente} minutos en ${r.cliente_actual}`
          });
        }
      }

      if (programados > 0 && visitados === 0) {
        alertas.push({
          tipo: "SIN_VISITAS",
          prioridad: "MEDIA",
          descripcion: `${vendedor} todavía no registró visitas`
        });
      }

      if (ahora.getHours() >= 14 && programados > 0 && cobertura < 30) {
        alertas.push({
          tipo: "BAJA_COBERTURA",
          prioridad: "ALTA",
          descripcion: `${vendedor} tiene cobertura baja: ${cobertura.toFixed(1)}%`
        });
      }
    });

    res.json(alertas);

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener alertas operativas",
      detalle: error.message
    });
  }
});

/*
=================================
DETALLE INDIVIDUAL VENDEDOR
=================================
*/

router.get("/vendedores/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const vendedorResult = await db.query(
      `
      SELECT
        id,
        nombre,
        apellido,
        legajo,
        UPPER(TRIM(rol)) AS rol
      FROM usuarios
      WHERE id = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [id]
    );

    if (vendedorResult.rows.length === 0) {
      return res.status(404).json({
        error: "Vendedor no encontrado"
      });
    }

    const gpsResult = await db.query(
      `
      SELECT
        latitud,
        longitud,
        fecha_hora
      FROM gps_logs
      WHERE vendedor_id = $1
        AND DATE(fecha_hora) = CURRENT_DATE
      ORDER BY fecha_hora DESC
      LIMIT 1
      `,
      [id]
    );

    const clientesDiaResult = await db.query(
      `
      WITH clientes_dia AS (

        /*
        =================================
        1. PLAN COMERCIAL TRADICIONAL
        =================================
        Incluye al titular normal y también
        al reemplazante vigente de la ruta.
        */

        SELECT DISTINCT ON (c.id)
          c.id,
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,

          ca.nombre AS canal,
          f.nombre AS frecuencia,
          r.nombre AS ruta,

          c.es_ejecucion
            AS programa_ejecucion,

          c.semana_ejecucion,

          CASE
            WHEN reemplazo.vendedor_reemplazo_id IS NOT NULL
            THEN 'REEMPLAZO DE RUTA'
            ELSE NULL
          END::text AS motivo,

          2 AS prioridad_origen

        FROM clientes c

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        LEFT JOIN frecuencias f
          ON f.id = c.frecuencia_id

        LEFT JOIN rutas r
          ON r.id = c.ruta_id
         AND r.activo = true

        LEFT JOIN LATERAL (
          SELECT
            rr.vendedor_reemplazo_id
          FROM reemplazos_ruta rr
          WHERE rr.ruta_id = r.id
            AND rr.activo = true
            AND CURRENT_DATE
                BETWEEN rr.fecha_desde
                    AND rr.fecha_hasta
          ORDER BY rr.created_at DESC
          LIMIT 1
        ) reemplazo ON true

        WHERE c.deleted_at IS NULL
          AND c.activo = true

          AND COALESCE(
                reemplazo.vendedor_reemplazo_id,
                r.vendedor_id,
                c.vendedor_id
              ) = $1

          AND ${DIA_SQL}

          /*
          =================================
          FILTRO SEMANA DE EJECUCIÓN
          =================================
          Un cliente tradicional entra todos
          los días que marque su frecuencia.

          Si además es cliente de Ejecución,
          sólo debe entrar en la semana que
          tiene asignada, exactamente igual
          que en Plan de Trabajo.
          */
          AND (
            COALESCE(c.es_ejecucion, false) = false

            OR (
              c.es_ejecucion = true
              AND c.semana_ejecucion IS NOT NULL
              AND c.semana_ejecucion =
                LEAST(
                  CEIL(
                    EXTRACT(
                      DAY FROM CURRENT_DATE
                    ) / 7.0
                  )::int,
                  5
                )
            )
          )

        UNION ALL

        /*
        =================================
        2. CLIENTES EXTRA DEL DÍA
        =================================
        */

        SELECT DISTINCT ON (c.id)
          c.id,
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,

          ca.nombre AS canal,
          f.nombre AS frecuencia,
          r.nombre AS ruta,

          c.es_ejecucion
            AS programa_ejecucion,

          c.semana_ejecucion,

          e.motivo,
          0 AS prioridad_origen

        FROM clientes_extra_dia e

        JOIN clientes c
          ON c.id = e.cliente_id

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        LEFT JOIN frecuencias f
          ON f.id = c.frecuencia_id

        LEFT JOIN rutas r
          ON r.id = e.ruta_id

        WHERE e.vendedor_id = $1
          AND e.fecha = CURRENT_DATE
          AND e.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true

        UNION ALL

        /*
        =================================
        3. PLAN TRADE MARKETING
        =================================
        Usa la frecuencia y la ruta propias
        del Plan Trade.

        "Todas las semanas" funciona porque
        internamente se guarda una asignación
        para cada semana del 1 al 5.
        */

        SELECT DISTINCT ON (c.id)
          c.id,
          c.codigo_cliente,
          c.nombre,
          c.direccion,
          c.localidad,
          c.latitud,
          c.longitud,

          ca.nombre AS canal,
          f.nombre AS frecuencia,
          r_trade.nombre AS ruta,

          c.es_ejecucion
            AS programa_ejecucion,

          c.semana_ejecucion,

          'PLAN TRADE'::text AS motivo,
          1 AS prioridad_origen

        FROM trade_visit_plan tvp

        JOIN clientes c
          ON c.id = tvp.cliente_id

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        JOIN frecuencias f
          ON f.id = tvp.frecuencia_id

        LEFT JOIN rutas r_trade
          ON r_trade.id = tvp.ruta_trade_id

        WHERE tvp.trade_id = $1
          AND tvp.activo = true
          AND c.deleted_at IS NULL
          AND c.activo = true

          AND tvp.semana =
              LEAST(
                CEIL(
                  EXTRACT(
                    DAY FROM CURRENT_DATE
                  ) / 7.0
                )::int,
                5
              )

          AND ${DIA_SQL}

          /*
          Si el Trade hoy está cubriendo una
          ruta comercial, no se suma además
          su recorrido Trade.
          */
          AND NOT EXISTS (
            SELECT 1

            FROM reemplazos_ruta rr

            JOIN rutas r2
              ON r2.id = rr.ruta_id
             AND r2.activo = true

            WHERE
              rr.vendedor_reemplazo_id =
                tvp.trade_id

              AND rr.activo = true

              AND CURRENT_DATE
                  BETWEEN rr.fecha_desde
                      AND rr.fecha_hasta
          )

      ),

      /*
      =================================
      UNIFICACIÓN
      =================================
      Si el mismo cliente entra por más de
      un origen, se muestra una sola vez.

      Prioridad:
      0 = Extra del día
      1 = Trade
      2 = Tradicional
      */

      unificados AS (
        SELECT DISTINCT ON (id)
          *
        FROM clientes_dia
        ORDER BY
          id,
          prioridad_origen
      )

      SELECT *
      FROM unificados
      ORDER BY nombre
      `,
      [id]
    );

    const visitasResult = await db.query(
      `
      SELECT
        v.id,
        c.id AS cliente_id,
        c.codigo_cliente,
        c.nombre AS cliente,
        c.direccion,
        c.localidad,
        v.hora_llegada,
        v.hora_salida,
        v.permanencia_segundos,
        COALESCE(
          v.latitud_llegada,
          c.latitud
        ) AS latitud_llegada,
        COALESCE(
          v.longitud_llegada,
          c.longitud
        ) AS longitud_llegada
      FROM visitas v
      LEFT JOIN clientes c
        ON c.id = v.cliente_id
      WHERE v.vendedor_id = $1
        AND v.fecha = CURRENT_DATE
      ORDER BY v.hora_llegada DESC
      `,
      [id]
    );

    const visitadosIds = new Set(
      visitasResult.rows
        .filter(v => v.cliente_id)
        .map(v => String(v.cliente_id))
    );

    const pendientes =
      clientesDiaResult.rows.filter(
        c =>
          !visitadosIds.has(
            String(c.id)
          )
      );

    res.json({
      vendedor:
        vendedorResult.rows[0],

      ultimo_gps:
        gpsResult.rows[0] || null,

      pendientes,

      visitas:
        visitasResult.rows
    });

  } catch (error) {

    console.error(
      "ERROR DETALLE VENDEDOR:",
      error
    );

    res.status(500).json({
      error:
        "Error al obtener detalle del vendedor",

      detalle:
        error.message
    });
  }
});

module.exports = router;