const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
FUNCIONES GENERALES
=================================
*/

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(dLon / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function fechaValida(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(fecha || "")
  );
}

function obtenerFiltrosFecha(req) {
  const hoy = new Date()
    .toISOString()
    .slice(0, 10);

  const desde = fechaValida(req.query.desde)
    ? req.query.desde
    : hoy;

  const hasta = fechaValida(req.query.hasta)
    ? req.query.hasta
    : desde;

  if (desde > hasta) {
    const error = new Error(
      "La fecha desde no puede ser posterior a la fecha hasta"
    );

    error.status = 400;
    throw error;
  }

  return {
    desde,
    hasta
  };
}

/*
=================================
GET VISITAS RESUMIDAS

Filtros disponibles:

?desde=2026-07-01
&hasta=2026-07-31
&vendedor_id=UUID

Un renglón por:
fecha + vendedor + cliente
=================================
*/

router.get("/", async (req, res) => {
  try {
    const { desde, hasta } =
      obtenerFiltrosFecha(req);

    const vendedorId =
      req.query.vendedor_id || null;

    const result = await db.query(
      `
      SELECT
        v.fecha,

        c.id AS cliente_id,
        c.codigo_cliente,
        c.nombre AS cliente,
        c.direccion,
        c.localidad,
        c.categoria,

        ca.nombre AS canal,
        r.nombre AS ruta,

        u.id AS vendedor_id,
        u.nombre || ' ' || u.apellido
          AS vendedor,

        MIN(v.hora_llegada)
          AS primera_llegada,

        MAX(v.hora_salida)
          AS ultima_salida,

        SUM(
          COALESCE(
            v.permanencia_segundos,
            CASE
              WHEN v.hora_salida IS NULL
              THEN EXTRACT(
                EPOCH FROM (
                  NOW() - v.hora_llegada
                )
              )::INTEGER
              ELSE 0
            END
          )
        ) AS permanencia_segundos,

        ROUND(
          SUM(
            COALESCE(
              v.permanencia_segundos,
              CASE
                WHEN v.hora_salida IS NULL
                THEN EXTRACT(
                  EPOCH FROM (
                    NOW() - v.hora_llegada
                  )
                )::INTEGER
                ELSE 0
              END
            )
          ) / 60.0,
          1
        ) AS permanencia_minutos,

        COUNT(*) AS registros,

        BOOL_OR(
          v.hora_salida IS NULL
        ) AS visita_abierta

      FROM visitas v

      LEFT JOIN clientes c
        ON c.id = v.cliente_id

      LEFT JOIN usuarios u
        ON u.id = v.vendedor_id

      LEFT JOIN rutas r
        ON r.id = c.ruta_id

      LEFT JOIN canales ca
        ON ca.id = c.canal_id

      WHERE v.fecha BETWEEN $1 AND $2

        AND (
          $3::uuid IS NULL
          OR v.vendedor_id = $3
        )

      GROUP BY
        v.fecha,

        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.categoria,

        ca.nombre,
        r.nombre,

        u.id,
        u.nombre,
        u.apellido

      ORDER BY
        v.fecha DESC,
        primera_llegada DESC
      `,
      [
        desde,
        hasta,
        vendedorId
      ]
    );

    res.json({
      desde,
      hasta,
      cantidad: result.rows.length,
      visitas: result.rows
    });

  } catch (error) {
    res
      .status(error.status || 500)
      .json({
        error:
          error.status === 400
            ? error.message
            : "Error al obtener visitas",

        detalle:
          error.status === 400
            ? undefined
            : error.message
      });
  }
});

/*
=================================
RESUMEN POR VENDEDOR

?desde=YYYY-MM-DD
&hasta=YYYY-MM-DD
&vendedor_id=UUID
=================================
*/

router.get("/resumen", async (req, res) => {
  try {
    const { desde, hasta } =
      obtenerFiltrosFecha(req);

    const vendedorId =
      req.query.vendedor_id || null;

    const result = await db.query(
      `
      SELECT
        u.id AS vendedor_id,

        u.nombre || ' ' || u.apellido
          AS vendedor,

        COUNT(
          DISTINCT v.cliente_id
        ) AS clientes_visitados,

        COUNT(*) AS registros,

        SUM(
          COALESCE(
            v.permanencia_segundos,
            CASE
              WHEN v.hora_salida IS NULL
              THEN EXTRACT(
                EPOCH FROM (
                  NOW() - v.hora_llegada
                )
              )::INTEGER
              ELSE 0
            END
          )
        ) AS permanencia_segundos,

        ROUND(
          SUM(
            COALESCE(
              v.permanencia_segundos,
              CASE
                WHEN v.hora_salida IS NULL
                THEN EXTRACT(
                  EPOCH FROM (
                    NOW() - v.hora_llegada
                  )
                )::INTEGER
                ELSE 0
              END
            )
          ) / 60.0,
          1
        ) AS permanencia_total_minutos,

        ROUND(
          SUM(
            COALESCE(
              v.permanencia_segundos,
              CASE
                WHEN v.hora_salida IS NULL
                THEN EXTRACT(
                  EPOCH FROM (
                    NOW() - v.hora_llegada
                  )
                )::INTEGER
                ELSE 0
              END
            )
          ) /
          NULLIF(
            COUNT(
              DISTINCT v.cliente_id
            ),
            0
          ) /
          60.0,
          1
        ) AS promedio_minutos_cliente,

        MIN(v.hora_llegada)
          AS primera_visita,

        MAX(
          COALESCE(
            v.hora_salida,
            v.hora_llegada
          )
        ) AS ultima_actividad,

        COUNT(
          DISTINCT v.fecha
        ) AS dias_con_actividad

      FROM visitas v

      INNER JOIN usuarios u
        ON u.id = v.vendedor_id

      WHERE v.fecha BETWEEN $1 AND $2

        AND (
          $3::uuid IS NULL
          OR v.vendedor_id = $3
        )

      GROUP BY
        u.id,
        u.nombre,
        u.apellido

      ORDER BY
        clientes_visitados DESC,
        vendedor ASC
      `,
      [
        desde,
        hasta,
        vendedorId
      ]
    );

    res.json({
      desde,
      hasta,
      resumen: result.rows
    });

  } catch (error) {
    res
      .status(error.status || 500)
      .json({
        error:
          error.status === 400
            ? error.message
            : "Error al obtener resumen",

        detalle:
          error.status === 400
            ? undefined
            : error.message
      });
  }
});

/*
=================================
ACTIVIDAD DETALLADA POR VENDEDOR

?desde=YYYY-MM-DD
&hasta=YYYY-MM-DD
=================================
*/

router.get(
  "/actividad/:vendedor_id",
  async (req, res) => {
    try {
      const { vendedor_id } =
        req.params;

      const { desde, hasta } =
        obtenerFiltrosFecha(req);

      const result = await db.query(
        `
        SELECT
          v.id AS visita_id,
          v.fecha,

          c.id AS cliente_id,
          c.codigo_cliente,
          c.nombre AS cliente,
          c.direccion,
          c.localidad,
          c.categoria,

          ca.nombre AS canal,
          r.nombre AS ruta,

          v.hora_llegada,
          v.hora_salida,

          COALESCE(
            v.permanencia_segundos,
            CASE
              WHEN v.hora_salida IS NULL
              THEN EXTRACT(
                EPOCH FROM (
                  NOW() - v.hora_llegada
                )
              )::INTEGER
              ELSE 0
            END
          ) AS permanencia_segundos,

          ROUND(
            COALESCE(
              v.permanencia_segundos,
              CASE
                WHEN v.hora_salida IS NULL
                THEN EXTRACT(
                  EPOCH FROM (
                    NOW() - v.hora_llegada
                  )
                )::INTEGER
                ELSE 0
              END
            ) / 60.0,
            1
          ) AS permanencia_minutos,

          v.latitud_llegada,
          v.longitud_llegada,

          v.latitud_salida,
          v.longitud_salida

        FROM visitas v

        LEFT JOIN clientes c
          ON c.id = v.cliente_id

        LEFT JOIN rutas r
          ON r.id = c.ruta_id

        LEFT JOIN canales ca
          ON ca.id = c.canal_id

        WHERE v.vendedor_id = $1
          AND v.fecha BETWEEN $2 AND $3

        ORDER BY
          v.fecha ASC,
          v.hora_llegada ASC
        `,
        [
          vendedor_id,
          desde,
          hasta
        ]
      );

      res.json({
        vendedor_id,
        desde,
        hasta,
        actividad: result.rows
      });

    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          error:
            error.status === 400
              ? error.message
              : "Error al obtener actividad del vendedor",

          detalle:
            error.status === 400
              ? undefined
              : error.message
        });
    }
  }
);

/*
=================================
LLEGADA
=================================
*/

router.post("/llegada", async (req, res) => {
  try {
    const {
      cliente_id,
      vendedor_id,
      latitud,
      longitud
    } = req.body;

    if (
      !cliente_id ||
      !vendedor_id
    ) {
      return res.status(400).json({
        error:
          "Faltan cliente_id o vendedor_id"
      });
    }

    const visitaAbierta =
      await db.query(
        `
        SELECT id
        FROM visitas
        WHERE cliente_id = $1
          AND vendedor_id = $2
          AND fecha = CURRENT_DATE
          AND hora_salida IS NULL
        LIMIT 1
        `,
        [
          cliente_id,
          vendedor_id
        ]
      );

    if (
      visitaAbierta.rows.length > 0
    ) {
      return res.json({
        mensaje:
          "La visita ya se encuentra abierta",

        visita: visitaAbierta.rows[0]
      });
    }

    const result = await db.query(
      `
      INSERT INTO visitas (
        cliente_id,
        vendedor_id,
        fecha,
        hora_llegada,
        latitud_llegada,
        longitud_llegada
      )
      VALUES (
        $1,
        $2,
        CURRENT_DATE,
        NOW(),
        $3,
        $4
      )
      RETURNING *
      `,
      [
        cliente_id,
        vendedor_id,
        latitud || null,
        longitud || null
      ]
    );

    res.status(201).json({
      mensaje: "Llegada registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al registrar llegada",

      detalle: error.message
    });
  }
});

/*
=================================
SALIDA
=================================
*/

router.post("/salida", async (req, res) => {
  try {
    const {
      visita_id,
      latitud,
      longitud
    } = req.body;

    if (!visita_id) {
      return res.status(400).json({
        error: "Falta visita_id"
      });
    }

    const result = await db.query(
      `
      UPDATE visitas
      SET
        hora_salida = NOW(),

        permanencia_segundos =
          GREATEST(
            0,
            EXTRACT(
              EPOCH FROM (
                NOW() - hora_llegada
              )
            )::INTEGER
          ),

        latitud_salida =
          COALESCE(
            $2,
            latitud_salida
          ),

        longitud_salida =
          COALESCE(
            $3,
            longitud_salida
          )

      WHERE id = $1
        AND hora_salida IS NULL

      RETURNING *
      `,
      [
        visita_id,
        latitud || null,
        longitud || null
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error:
          "Visita no encontrada o ya cerrada"
      });
    }

    res.json({
      mensaje: "Salida registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al registrar salida",

      detalle: error.message
    });
  }
});

/*
=================================
ENTRADA MANUAL + CORRECCIÓN GPS

Usa rutas o vendedor directo.
=================================
*/

router.post(
  "/entrada-manual",
  async (req, res) => {
    try {
      const {
        vendedor_id,
        latitud,
        longitud
      } = req.body;

      const latActual =
        Number(latitud);

      const lngActual =
        Number(longitud);

      if (
        !vendedor_id ||
        !Number.isFinite(latActual) ||
        !Number.isFinite(lngActual)
      ) {
        return res.status(400).json({
          error:
            "Datos de entrada inválidos"
        });
      }

      const clientesResult =
        await db.query(
          `
          SELECT DISTINCT
            c.id,
            c.nombre,
            c.latitud,
            c.longitud

          FROM clientes c

          LEFT JOIN rutas r
            ON r.id = c.ruta_id

          WHERE c.activo = true
            AND c.deleted_at IS NULL
            AND c.latitud IS NOT NULL
            AND c.longitud IS NOT NULL

            AND (
              c.vendedor_id = $1

              OR (
                r.vendedor_id = $1
                AND r.activo = true
              )
            )
          `,
          [vendedor_id]
        );

      if (
        clientesResult.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "No hay clientes asignados al vendedor"
        });
      }

      let clienteMasCercano = null;
      let menor =
        Number.POSITIVE_INFINITY;

      for (
        const cliente
        of clientesResult.rows
      ) {
        const latCliente =
          Number(cliente.latitud);

        const lngCliente =
          Number(cliente.longitud);

        if (
          !Number.isFinite(latCliente) ||
          !Number.isFinite(lngCliente)
        ) {
          continue;
        }

        const distancia =
          distanciaMetros(
            latActual,
            lngActual,
            latCliente,
            lngCliente
          );

        if (distancia < menor) {
          menor = distancia;
          clienteMasCercano =
            cliente;
        }
      }

      if (!clienteMasCercano) {
        return res.status(404).json({
          error:
            "No se encontró un cliente cercano"
        });
      }

      if (menor > 100) {
        return res.status(400).json({
          error:
            `No se encontró un cliente cercano. ` +
            `El más próximo está a ` +
            `${Math.round(menor)} metros.`
        });
      }

      const visitaAbierta =
        await db.query(
          `
          SELECT id
          FROM visitas
          WHERE vendedor_id = $1
            AND cliente_id = $2
            AND fecha = CURRENT_DATE
            AND hora_salida IS NULL
          LIMIT 1
          `,
          [
            vendedor_id,
            clienteMasCercano.id
          ]
        );

      if (
        visitaAbierta.rows.length > 0
      ) {
        return res.json({
          mensaje:
            "La visita ya estaba abierta",

          cliente:
            clienteMasCercano.nombre,

          visita:
            visitaAbierta.rows[0]
        });
      }

      const visita = await db.query(
        `
        INSERT INTO visitas (
          cliente_id,
          vendedor_id,
          fecha,
          hora_llegada,
          latitud_llegada,
          longitud_llegada
        )
        VALUES (
          $1,
          $2,
          CURRENT_DATE,
          NOW(),
          $3,
          $4
        )
        RETURNING *
        `,
        [
          clienteMasCercano.id,
          vendedor_id,
          latActual,
          lngActual
        ]
      );

      await db.query(
        `
        UPDATE clientes
        SET
          latitud = $1,
          longitud = $2,
          updated_at = NOW()
        WHERE id = $3
        `,
        [
          latActual,
          lngActual,
          clienteMasCercano.id
        ]
      );

      try {
        await db.query(
          `
          INSERT INTO alertas (
            vendedor_id,
            cliente_id,
            visita_id,
            tipo,
            prioridad,
            descripcion
          )
          VALUES (
            $1,
            $2,
            $3,
            'GEOREFERENCIA',
            'MEDIA',
            $4
          )
          `,
          [
            vendedor_id,
            clienteMasCercano.id,
            visita.rows[0].id,
            `Se actualizó la georreferencia de ${clienteMasCercano.nombre}`
          ]
        );
      } catch (errorAlerta) {
        console.error(
          "No se pudo generar alerta de georreferencia:",
          errorAlerta.message
        );
      }

      res.json({
        mensaje:
          "Entrada manual registrada",

        cliente:
          clienteMasCercano.nombre,

        distancia_metros:
          Math.round(menor),

        visita:
          visita.rows[0]
      });

    } catch (error) {
      res.status(500).json({
        error:
          "Error al registrar entrada manual",

        detalle: error.message
      });
    }
  }
);

module.exports = router;