const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
FUNCIONES
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

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/*
=================================
GET GPS LOGS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT *
      FROM gps_logs
      ORDER BY fecha_hora DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener gps logs",
      detalle: error.message
    });
  }
});

/*
=================================
GET ÚLTIMO GPS POR VENDEDOR
=================================
*/

router.get("/ultimos", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT ON (g.vendedor_id)
        g.id,
        g.vendedor_id,
        u.nombre || ' ' || u.apellido AS vendedor,
        g.latitud,
        g.longitud,
        g.precision_metros,
        g.velocidad,
        g.fecha_hora
      FROM gps_logs g
      LEFT JOIN usuarios u ON u.id = g.vendedor_id
      ORDER BY g.vendedor_id, g.fecha_hora DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener últimos GPS",
      detalle: error.message
    });
  }
});

/*
=================================
GET RECORRIDO DEL VENDEDOR HOY
=================================
*/

router.get("/vendedor/:id/hoy", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      SELECT
        latitud,
        longitud,
        fecha_hora
      FROM gps_logs
      WHERE vendedor_id = $1
        AND DATE(fecha_hora) = CURRENT_DATE
        AND latitud IS NOT NULL
        AND longitud IS NOT NULL
        AND latitud <> 0
        AND longitud <> 0
      ORDER BY fecha_hora ASC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener recorrido GPS",
      detalle: error.message
    });
  }
});

/*
=================================
POST GPS LOG MANUAL
=================================
*/

router.post("/", async (req, res) => {
  try {
    const {
      vendedor_id,
      latitud,
      longitud,
      precision_metros,
      velocidad
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO gps_logs (
        vendedor_id,
        latitud,
        longitud,
        precision_metros,
        velocidad,
        fecha_hora
      )
      VALUES ($1,$2,$3,$4,$5,NOW())
      RETURNING *
      `,
      [
        vendedor_id,
        latitud,
        longitud,
        precision_metros || null,
        velocidad || 0
      ]
    );

    res.status(201).json({
      mensaje: "GPS registrado",
      gps: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Error al registrar GPS",
      detalle: error.message
    });
  }
});

/*
=================================
POST GPS AUTOMÁTICO + GEOCERCA
=================================
*/

router.post("/automatico", async (req, res) => {
  try {
    const { vendedor_id, latitud, longitud, precision_metros, velocidad } = req.body;

    const latActual = Number(latitud);
    const lngActual = Number(longitud);

    if (
      !vendedor_id ||
      isNaN(latActual) ||
      isNaN(lngActual) ||
      latActual === 0 ||
      lngActual === 0
    ) {
      return res.status(400).json({
        error: "Datos GPS inválidos"
      });
    }

    await db.query(
      `
      INSERT INTO gps_logs (
        vendedor_id,
        latitud,
        longitud,
        precision_metros,
        velocidad,
        fecha_hora
      )
      VALUES ($1,$2,$3,$4,$5,NOW())
      `,
      [
        vendedor_id,
        latActual,
        lngActual,
        precision_metros || 8,
        velocidad || 0
      ]
    );

    const clientesResult = await db.query(
      `
      SELECT
        id,
        nombre,
        latitud,
        longitud,
        radio_geocerca
      FROM clientes
      WHERE vendedor_id = $1
        AND deleted_at IS NULL
        AND activo = true
        AND latitud IS NOT NULL
        AND longitud IS NOT NULL
        AND latitud <> 0
        AND longitud <> 0
      `,
      [vendedor_id]
    );

    let clienteDentro = null;
    let menorDistancia = 999999999;

    for (const c of clientesResult.rows) {
      const latCliente = Number(c.latitud);
      const lngCliente = Number(c.longitud);

      if (isNaN(latCliente) || isNaN(lngCliente)) {
        continue;
      }

      const distancia = distanciaMetros(
        latActual,
        lngActual,
        latCliente,
        lngCliente
      );

      const radioCliente = Number(c.radio_geocerca || 50);
      const radioMinimo = 50;
      const radioFinal = Math.max(radioCliente, radioMinimo);

      if (distancia <= radioFinal && distancia < menorDistancia) {
        menorDistancia = distancia;
        clienteDentro = {
          ...c,
          distancia,
          radioFinal
        };
      }
    }

    /*
    ===============================
    SI ESTÁ DENTRO DE UN CLIENTE
    ===============================
    */

    if (clienteDentro) {
      const visitaAbiertaMismoCliente = await db.query(
        `
        SELECT id
        FROM visitas
        WHERE vendedor_id = $1
          AND cliente_id = $2
          AND fecha = CURRENT_DATE
          AND hora_salida IS NULL
        LIMIT 1
        `,
        [vendedor_id, clienteDentro.id]
      );

      if (visitaAbiertaMismoCliente.rows.length > 0) {
        return res.json({
          mensaje: "GPS recibido. Vendedor sigue dentro del cliente.",
          estado: "DENTRO",
          cliente: clienteDentro.nombre,
          cliente_id: clienteDentro.id,
          distancia_metros: Math.round(clienteDentro.distancia),
          radio_geocerca: clienteDentro.radioFinal,
          visita_id: visitaAbiertaMismoCliente.rows[0].id
        });
      }

      const visitaAbiertaOtroCliente = await db.query(
        `
        SELECT id
        FROM visitas
        WHERE vendedor_id = $1
          AND fecha = CURRENT_DATE
          AND hora_salida IS NULL
        ORDER BY hora_llegada DESC
        LIMIT 1
        `,
        [vendedor_id]
      );

      if (visitaAbiertaOtroCliente.rows.length > 0) {
        await db.query(
          `
          UPDATE visitas
          SET
            hora_salida = NOW(),
            permanencia_segundos =
              EXTRACT(EPOCH FROM (NOW() - hora_llegada))::INTEGER
          WHERE id = $1
          `,
          [visitaAbiertaOtroCliente.rows[0].id]
        );
      }

      const nuevaVisita = await db.query(
        `
        INSERT INTO visitas (
          cliente_id,
          vendedor_id,
          fecha,
          hora_llegada,
          latitud_llegada,
          longitud_llegada
        )
        VALUES ($1,$2,CURRENT_DATE,NOW(),$3,$4)
        RETURNING *
        `,
        [
          clienteDentro.id,
          vendedor_id,
          latActual,
          lngActual
        ]
      );

      return res.json({
        mensaje: "GPS recibido. Llegada automática registrada.",
        estado: "DENTRO",
        cliente: clienteDentro.nombre,
        cliente_id: clienteDentro.id,
        distancia_metros: Math.round(clienteDentro.distancia),
        radio_geocerca: clienteDentro.radioFinal,
        visita: nuevaVisita.rows[0]
      });
    }

    /*
    ===============================
    SI ESTÁ FUERA DE CLIENTES
    ===============================
    */

    const visitaAbierta = await db.query(
      `
      SELECT id
      FROM visitas
      WHERE vendedor_id = $1
        AND fecha = CURRENT_DATE
        AND hora_salida IS NULL
      ORDER BY hora_llegada DESC
      LIMIT 1
      `,
      [vendedor_id]
    );

    if (visitaAbierta.rows.length > 0) {
      const cerrar = await db.query(
        `
        UPDATE visitas
        SET
          hora_salida = NOW(),
          permanencia_segundos =
            EXTRACT(EPOCH FROM (NOW() - hora_llegada))::INTEGER
        WHERE id = $1
        RETURNING *
        `,
        [visitaAbierta.rows[0].id]
      );

      return res.json({
        mensaje: "GPS recibido. Salida automática registrada.",
        estado: "FUERA",
        visita: cerrar.rows[0]
      });
    }

    res.json({
      mensaje: "GPS recibido. Fuera de clientes.",
      estado: "FUERA"
    });

  } catch (error) {
    res.status(500).json({
      error: "Error en GPS automático",
      detalle: error.message
    });
  }
});

module.exports = router;