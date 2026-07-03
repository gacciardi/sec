const express = require("express");
const db = require("../config/database");

const router = express.Router();

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
GET VISITAS RESUMIDAS
1 renglón por vendedor + cliente
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        v.fecha,
        c.nombre AS cliente,
        u.nombre || ' ' || u.apellido AS vendedor,
        MIN(v.hora_llegada) AS primera_llegada,
        MAX(v.hora_salida) AS ultima_salida,
        SUM(COALESCE(v.permanencia_segundos,0)) AS permanencia_segundos,
        ROUND(SUM(COALESCE(v.permanencia_segundos,0)) / 60.0, 1) AS permanencia_minutos,
        COUNT(*) AS registros
      FROM visitas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN usuarios u ON u.id = v.vendedor_id
      WHERE v.fecha = CURRENT_DATE
      GROUP BY v.fecha, c.nombre, u.nombre, u.apellido
      ORDER BY primera_llegada DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener visitas",
      detalle: error.message
    });
  }
});

/*
=================================
ACTIVIDAD DETALLADA POR VENDEDOR
=================================
*/

router.get("/actividad/:vendedor_id", async (req, res) => {
  try {
    const { vendedor_id } = req.params;

    const result = await db.query(
      `
      SELECT
        v.fecha,
        c.codigo_cliente,
        c.nombre AS cliente,
        c.direccion,
        v.hora_llegada,
        v.hora_salida,
        v.permanencia_segundos,
        ROUND(COALESCE(v.permanencia_segundos,0) / 60.0, 1) AS permanencia_minutos,
        v.latitud_llegada,
        v.longitud_llegada
      FROM visitas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.vendedor_id = $1
        AND v.fecha = CURRENT_DATE
      ORDER BY v.hora_llegada ASC
      `,
      [vendedor_id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error al obtener actividad del vendedor",
      detalle: error.message
    });
  }
});

/*
=================================
LLEGADA
=================================
*/

router.post("/llegada", async (req, res) => {
  try {
    const { cliente_id, vendedor_id, latitud, longitud } = req.body;

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
      [cliente_id, vendedor_id, latitud, longitud]
    );

    res.status(201).json({
      mensaje: "Llegada registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al registrar llegada",
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
    const { visita_id } = req.body;

    const result = await db.query(
      `
      UPDATE visitas
      SET
        hora_salida = NOW(),
        permanencia_segundos =
          EXTRACT(EPOCH FROM (NOW() - hora_llegada))::INTEGER
      WHERE id = $1
      RETURNING *
      `,
      [visita_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Visita no encontrada"
      });
    }

    res.json({
      mensaje: "Salida registrada",
      visita: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al registrar salida",
      detalle: error.message
    });
  }
});

/*
=================================
ENTRADA MANUAL + CORRECCIÓN GPS
usa rutas o vendedor directo
=================================
*/

router.post("/entrada-manual", async (req, res) => {
  try {
    const { vendedor_id, latitud, longitud } = req.body;

    const cliente = await db.query(
      `
      SELECT
        c.id,
        c.nombre,
        c.latitud,
        c.longitud
      FROM clientes c
      WHERE c.activo = true
        AND c.deleted_at IS NULL
        AND (
          c.vendedor_id = $1
          OR c.ruta_id IN (
            SELECT r.id
            FROM rutas r
            WHERE r.vendedor_id = $1
              AND r.activo = true
          )
        )
      `,
      [vendedor_id]
    );

    if (cliente.rows.length === 0) {
      return res.status(404).json({
        error: "No hay clientes asignados al vendedor"
      });
    }

    let clienteMasCercano = null;
    let menor = 999999999;

    for (const c of cliente.rows) {
      if (!c.latitud || !c.longitud) continue;

      const d = distanciaMetros(
        Number(latitud),
        Number(longitud),
        Number(c.latitud),
        Number(c.longitud)
      );

      if (d < menor) {
        menor = d;
        clienteMasCercano = c;
      }
    }

    if (!clienteMasCercano) {
      return res.status(404).json({
        error: "No se encontró un cliente cercano"
      });
    }

    if (menor > 100) {
      return res.status(400).json({
        error: `No se encontró un cliente cercano. El más próximo está a ${Math.round(menor)} metros.`
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
      VALUES ($1,$2,CURRENT_DATE,NOW(),$3,$4)
      RETURNING *
      `,
      [
        clienteMasCercano.id,
        vendedor_id,
        latitud,
        longitud
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
        latitud,
        longitud,
        clienteMasCercano.id
      ]
    );

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
      VALUES ($1,$2,$3,'GEOREFERENCIA','MEDIA',$4)
      `,
      [
        vendedor_id,
        clienteMasCercano.id,
        visita.rows[0].id,
        `Se actualizó la georreferencia de ${clienteMasCercano.nombre}`
      ]
    );

    res.json({
      mensaje: "Entrada manual registrada",
      cliente: clienteMasCercano.nombre,
      visita: visita.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error: "Error al registrar entrada manual",
      detalle: error.message
    });
  }
});

module.exports = router;