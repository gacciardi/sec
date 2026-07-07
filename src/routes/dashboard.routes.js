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
      WHERE u.rol = 'VENDEDOR'
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
      WHERE u.rol = 'VENDEDOR'
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
      SELECT id, nombre, apellido, legajo
      FROM usuarios
      WHERE id = $1
      `,
      [id]
    );

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
          NULL::text AS motivo,
          1 AS prioridad_origen
        FROM clientes c
        LEFT JOIN canales ca
          ON ca.id = c.canal_id
        LEFT JOIN frecuencias f
          ON f.id = c.frecuencia_id
        LEFT JOIN rutas r
          ON r.id = c.ruta_id
          AND r.activo = true
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND (
            r.vendedor_id = $1
            OR c.vendedor_id = $1
          )
          AND ${DIA_SQL}

        UNION ALL

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

      ),
      unificados AS (
        SELECT DISTINCT ON (id)
          *
        FROM clientes_dia
        ORDER BY id, prioridad_origen
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
        COALESCE(v.latitud_llegada, c.latitud) AS latitud_llegada,
        COALESCE(v.longitud_llegada, c.longitud) AS longitud_llegada
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

    const pendientes = clientesDiaResult.rows.filter(c =>
      !visitadosIds.has(String(c.id))
    );

    res.json({
      vendedor: vendedorResult.rows[0] || null,
      ultimo_gps: gpsResult.rows[0] || null,
      pendientes,
      visitas: visitasResult.rows
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al obtener detalle del vendedor",
      detalle: error.message
    });
  }
});

module.exports = router;