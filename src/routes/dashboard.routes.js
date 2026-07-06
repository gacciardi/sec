const express = require("express");
const db = require("../config/database");

const router = express.Router();

router.get("/vendedores", async (req, res) => {
  try {
    const result = await db.query(`
      WITH programados AS (
        SELECT c.vendedor_id, COUNT(*) AS programados
        FROM clientes c
        JOIN frecuencias f ON f.id = c.frecuencia_id
        WHERE c.deleted_at IS NULL
          AND c.activo = true
          AND c.vendedor_id IS NOT NULL
          AND (
            (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND f.lunes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND f.martes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND f.miercoles=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND f.jueves=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND f.viernes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND f.sabado=true)
          )
        GROUP BY c.vendedor_id
      ),
      visitados AS (
        SELECT vendedor_id, COUNT(DISTINCT cliente_id) AS visitados
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
        COALESCE(p.programados,0) - COALESCE(v.visitados,0) AS pendientes,
        lg.fecha_hora AS ultimo_gps,
        va.hora_llegada AS llegada_actual,
        va.cliente_actual
      FROM usuarios u
      LEFT JOIN programados p ON p.vendedor_id = u.id
      LEFT JOIN visitados v ON v.vendedor_id = u.id
      LEFT JOIN LATERAL (
        SELECT fecha_hora
        FROM gps_logs
        WHERE vendedor_id = u.id
          AND DATE(fecha_hora) = CURRENT_DATE
        ORDER BY fecha_hora DESC
        LIMIT 1
      ) lg ON true
      LEFT JOIN LATERAL (
        SELECT v.hora_llegada, c.nombre AS cliente_actual
        FROM visitas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE v.vendedor_id = u.id
          AND v.fecha = CURRENT_DATE
          AND v.hora_salida IS NULL
        ORDER BY v.hora_llegada DESC
        LIMIT 1
      ) va ON true
      WHERE u.rol = 'VENDEDOR'
        AND u.deleted_at IS NULL
        AND u.activo = true
      ORDER BY u.apellido, u.nombre
    `);

    const datos = result.rows.map(r => {
      const programados = Number(r.programados);
      const visitados = Number(r.visitados);

      return {
        vendedor_id: r.vendedor_id,
        vendedor: r.vendedor,
        legajo: r.legajo,
        programados,
        visitados,
        pendientes: Number(r.pendientes),
        cobertura: programados > 0
          ? Number(((visitados / programados) * 100).toFixed(2))
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

router.get("/alertas-operativas", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        u.id,
        u.nombre || ' ' || u.apellido AS vendedor,
        u.legajo,
        lg.fecha_hora AS ultimo_gps,
        va.hora_llegada,
        va.cliente_actual,
        COALESCE(p.programados,0) AS programados,
        COALESCE(v.visitados,0) AS visitados
      FROM usuarios u
      LEFT JOIN LATERAL (
        SELECT fecha_hora
        FROM gps_logs
        WHERE vendedor_id = u.id
          AND DATE(fecha_hora) = CURRENT_DATE
        ORDER BY fecha_hora DESC
        LIMIT 1
      ) lg ON true
      LEFT JOIN LATERAL (
        SELECT v.hora_llegada, c.nombre AS cliente_actual
        FROM visitas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE v.vendedor_id = u.id
          AND v.fecha = CURRENT_DATE
          AND v.hora_salida IS NULL
        ORDER BY v.hora_llegada DESC
        LIMIT 1
      ) va ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS programados
        FROM clientes c
        JOIN frecuencias f ON f.id = c.frecuencia_id
        WHERE c.vendedor_id = u.id
          AND c.deleted_at IS NULL
          AND c.activo = true
          AND (
            (EXTRACT(ISODOW FROM CURRENT_DATE)=1 AND f.lunes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=2 AND f.martes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=3 AND f.miercoles=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=4 AND f.jueves=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=5 AND f.viernes=true)
            OR (EXTRACT(ISODOW FROM CURRENT_DATE)=6 AND f.sabado=true)
          )
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT cliente_id) AS visitados
        FROM visitas
        WHERE vendedor_id = u.id
          AND fecha = CURRENT_DATE
      ) v ON true
      WHERE u.rol = 'VENDEDOR'
        AND u.deleted_at IS NULL
        AND u.activo = true
    `);

    const ahora = new Date();
    const alertas = [];

    result.rows.forEach(r => {
      const vendedor = `${r.vendedor} - Legajo ${r.legajo || ""}`;
      const programados = Number(r.programados);
      const visitados = Number(r.visitados);
      const cobertura = programados > 0 ? (visitados / programados) * 100 : 0;

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

      const horaActual = ahora.getHours();

      if (horaActual >= 14 && programados > 0 && cobertura < 30) {
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
      SELECT latitud, longitud, fecha_hora
      FROM gps_logs
      WHERE vendedor_id = $1
        AND DATE(fecha_hora) = CURRENT_DATE
      ORDER BY fecha_hora DESC
      LIMIT 1
      `,
      [id]
    );

    const pendientesResult = await db.query(
      `
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.latitud,
        c.longitud,
        ca.nombre AS canal,
        fr.nombre AS frecuencia
      FROM clientes c
      LEFT JOIN canales ca ON ca.id = c.canal_id
      LEFT JOIN frecuencias fr ON fr.id = c.frecuencia_id
      WHERE c.vendedor_id = $1
        AND c.deleted_at IS NULL
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
      `,
      [id]
    );

    
    res.json({
      vendedor: vendedorResult.rows[0],
      ultimo_gps: gpsResult.rows[0] || null,
      pendientes: pendientesResult.rows,
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