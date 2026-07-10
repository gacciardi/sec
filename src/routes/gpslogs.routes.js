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

function numeroValido(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

async function obtenerClientesAsignados(vendedorId) {
  const result = await db.query(
    `
    SELECT DISTINCT
      c.id,
      c.codigo_cliente,
      c.nombre,
      c.direccion,
      c.localidad,
      c.latitud,
      c.longitud,
      COALESCE(c.radio_geocerca, 30) AS radio_geocerca
    FROM clientes c
    LEFT JOIN rutas r ON r.id = c.ruta_id
    WHERE c.deleted_at IS NULL
      AND c.activo = true
      AND c.latitud IS NOT NULL
      AND c.longitud IS NOT NULL
      AND c.latitud <> 0
      AND c.longitud <> 0
      AND (
        c.vendedor_id = $1
        OR (
          r.vendedor_id = $1
          AND r.activo = true
        )
      )
    `,
    [vendedorId]
  );

  return result.rows;
}

function obtenerCandidatos(clientes, latActual, lngActual) {
  return clientes
    .map(cliente => {
      const latCliente = numeroValido(cliente.latitud);
      const lngCliente = numeroValido(cliente.longitud);

      if (latCliente === null || lngCliente === null) {
        return null;
      }

      const distancia = distanciaMetros(
        latActual,
        lngActual,
        latCliente,
        lngCliente
      );

      const radioGeocerca =
        numeroValido(cliente.radio_geocerca) || 30;

      if (distancia > radioGeocerca) {
        return null;
      }

      return {
        id: cliente.id,
        codigo_cliente: cliente.codigo_cliente,
        nombre: cliente.nombre,
        direccion: cliente.direccion,
        localidad: cliente.localidad,
        latitud: latCliente,
        longitud: lngCliente,
        distancia_metros: Math.round(distancia),
        radio_geocerca: radioGeocerca
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distancia_metros - b.distancia_metros);
}

async function obtenerVisitaAbierta(vendedorId) {
  const result = await db.query(
    `
    SELECT
      v.id,
      v.cliente_id,
      v.hora_llegada,
      c.nombre AS cliente,
      c.latitud,
      c.longitud,
      COALESCE(c.radio_geocerca, 30) AS radio_geocerca
    FROM visitas v
    INNER JOIN clientes c ON c.id = v.cliente_id
    WHERE v.vendedor_id = $1
      AND v.fecha = CURRENT_DATE
      AND v.hora_salida IS NULL
    ORDER BY v.hora_llegada DESC
    LIMIT 1
    `,
    [vendedorId]
  );

  return result.rows[0] || null;
}

async function cerrarVisita(visitaId, latitud, longitud) {
  const result = await db.query(
    `
    UPDATE visitas
    SET
      hora_salida = NOW(),
      permanencia_segundos =
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (NOW() - hora_llegada))::INTEGER
        ),
      latitud_salida = COALESCE($2, latitud_salida),
      longitud_salida = COALESCE($3, longitud_salida)
    WHERE id = $1
      AND hora_salida IS NULL
    RETURNING *
    `,
    [visitaId, latitud, longitud]
  );

  return result.rows[0] || null;
}

async function abrirVisita(
  vendedorId,
  clienteId,
  latitud,
  longitud
) {
  const existente = await db.query(
    `
    SELECT *
    FROM visitas
    WHERE vendedor_id = $1
      AND cliente_id = $2
      AND fecha = CURRENT_DATE
      AND hora_salida IS NULL
    LIMIT 1
    `,
    [vendedorId, clienteId]
  );

  if (existente.rows.length > 0) {
    return existente.rows[0];
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
    VALUES ($1,$2,CURRENT_DATE,NOW(),$3,$4)
    RETURNING *
    `,
    [clienteId, vendedorId, latitud, longitud]
  );

  return result.rows[0];
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
CONFIRMAR CLIENTE ENTRE VARIOS
=================================
*/

router.post("/automatico/confirmar-cliente", async (req, res) => {
  try {
    const {
      vendedor_id,
      cliente_id,
      latitud,
      longitud
    } = req.body;

    const latActual = numeroValido(latitud);
    const lngActual = numeroValido(longitud);

    if (
      !vendedor_id ||
      !cliente_id ||
      latActual === null ||
      lngActual === null ||
      latActual === 0 ||
      lngActual === 0
    ) {
      return res.status(400).json({
        error: "Datos inválidos para confirmar el cliente"
      });
    }

    const clientes = await obtenerClientesAsignados(vendedor_id);
    const cliente = clientes.find(c => c.id === cliente_id);

    if (!cliente) {
      return res.status(404).json({
        error: "El cliente no está activo o no pertenece al vendedor"
      });
    }

    const distancia = distanciaMetros(
      latActual,
      lngActual,
      Number(cliente.latitud),
      Number(cliente.longitud)
    );

    const radioGeocerca =
      numeroValido(cliente.radio_geocerca) || 30;

    const toleranciaConfirmacion = Math.max(
      radioGeocerca,
      50
    );

    if (distancia > toleranciaConfirmacion) {
      return res.status(400).json({
        error: "El cliente seleccionado está demasiado lejos",
        distancia_metros: Math.round(distancia),
        radio_permitido: toleranciaConfirmacion
      });
    }

    const visitaAbierta = await obtenerVisitaAbierta(vendedor_id);

    if (
      visitaAbierta &&
      visitaAbierta.cliente_id !== cliente_id
    ) {
      await cerrarVisita(
        visitaAbierta.id,
        latActual,
        lngActual
      );
    }

    const visita = await abrirVisita(
      vendedor_id,
      cliente_id,
      latActual,
      lngActual
    );

    return res.json({
      mensaje: "Cliente confirmado. Visita iniciada.",
      estado: "DENTRO",
      cliente: cliente.nombre,
      cliente_id: cliente.id,
      distancia_metros: Math.round(distancia),
      radio_geocerca: radioGeocerca,
      visita_id: visita.id,
      visita
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al confirmar cliente cercano",
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
    const {
      vendedor_id,
      latitud,
      longitud,
      precision_metros,
      velocidad
    } = req.body;

    const latActual = numeroValido(latitud);
    const lngActual = numeroValido(longitud);

    if (
      !vendedor_id ||
      latActual === null ||
      lngActual === null ||
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

    const clientes = await obtenerClientesAsignados(vendedor_id);

    const candidatos = obtenerCandidatos(
      clientes,
      latActual,
      lngActual
    );

    const visitaAbierta = await obtenerVisitaAbierta(vendedor_id);

    /*
    =================================
    SI YA HAY UNA VISITA ABIERTA
    =================================
    */

    if (visitaAbierta) {
      const latCliente = numeroValido(visitaAbierta.latitud);
      const lngCliente = numeroValido(visitaAbierta.longitud);

      const radioGeocerca =
        numeroValido(visitaAbierta.radio_geocerca) || 30;

      const distanciaCliente =
        latCliente !== null && lngCliente !== null
          ? distanciaMetros(
              latActual,
              lngActual,
              latCliente,
              lngCliente
            )
          : Number.POSITIVE_INFINITY;

      if (distanciaCliente <= radioGeocerca) {
        return res.json({
          mensaje: "GPS recibido. Vendedor sigue dentro del cliente.",
          estado: "DENTRO",
          cliente: visitaAbierta.cliente,
          cliente_id: visitaAbierta.cliente_id,
          distancia_metros: Math.round(distanciaCliente),
          radio_geocerca: radioGeocerca,
          visita_id: visitaAbierta.id
        });
      }

      const visitaCerrada = await cerrarVisita(
        visitaAbierta.id,
        latActual,
        lngActual
      );

      return res.json({
        mensaje: "GPS recibido. Salida automática registrada.",
        estado: "FUERA",
        visita: visitaCerrada,
        clientes_cercanos: candidatos
      });
    }

    /*
    =================================
    MÁS DE UN CLIENTE CERCANO
    =================================
    */

    if (candidatos.length > 1) {
      return res.json({
        mensaje: "Hay varios clientes dentro de la geocerca.",
        estado: "MULTIPLES_CLIENTES",
        clientes: candidatos
      });
    }

    /*
    =================================
    UN SOLO CLIENTE CERCANO
    =================================
    */

    if (candidatos.length === 1) {
      const clienteDentro = candidatos[0];

      const visita = await abrirVisita(
        vendedor_id,
        clienteDentro.id,
        latActual,
        lngActual
      );

      return res.json({
        mensaje: "GPS recibido. Llegada automática registrada.",
        estado: "DENTRO",
        cliente: clienteDentro.nombre,
        cliente_id: clienteDentro.id,
        distancia_metros: clienteDentro.distancia_metros,
        radio_geocerca: clienteDentro.radio_geocerca,
        visita_id: visita.id,
        visita
      });
    }

    /*
    =================================
    FUERA DE TODOS LOS CLIENTES
    =================================
    */

    return res.json({
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