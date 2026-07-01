const express = require("express");
const db = require("../config/database");

const router = express.Router();

/*
=================================
GET VISITAS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        v.id,
        v.fecha,
        v.hora_llegada,
        v.hora_salida,
        v.permanencia_segundos,
        v.latitud_llegada,
        v.longitud_llegada,
        c.nombre AS cliente,
        u.nombre || ' ' || u.apellido AS vendedor
      FROM visitas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN usuarios u ON u.id = v.vendedor_id
      WHERE v.fecha = CURRENT_DATE
ORDER BY v.hora_llegada DESC
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
        latitud,
        longitud
      ]
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
          EXTRACT(
            EPOCH FROM (
              NOW() - hora_llegada
            )
          )::INTEGER
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
=================================
*/

router.post("/entrada-manual", async (req, res) => {
  try {
    const {
      vendedor_id,
      latitud,
      longitud
    } = req.body;

    const cliente = await db.query(
      `
      SELECT
        id,
        nombre,
        latitud,
        longitud
      FROM clientes
      WHERE vendedor_id = $1
        AND activo = true
        AND deleted_at IS NULL
      `,
      [vendedor_id]
    );

    if (cliente.rows.length === 0) {
      return res.status(404).json({
        error: "No hay clientes"
      });
    }

    function distanciaMetros(
      lat1,
      lon1,
      lat2,
      lon2
    ) {
      const R = 6371000;
      const rad = Math.PI / 180;

      const dLat =
        (lat2 - lat1) * rad;

      const dLon =
        (lon2 - lon1) * rad;

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

    let clienteMasCercano = null;
    let menor = 999999999;

    for (const c of cliente.rows) {

      if (
        !c.latitud ||
        !c.longitud
      ) continue;

      const d =
        distanciaMetros(
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
        error:
          "No se encontró un cliente cercano"
      });
    }

   /*
=================================
VALIDAR DISTANCIA MÁXIMA
=================================
*/

if (menor > 100) {
  return res.status(400).json({
    error:
      `No se encontró un cliente cercano. El más próximo está a ${Math.round(menor)} metros.`
  });
}

    const visita =
      await db.query(
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
          latitud,
          longitud
        ]
      );

    /*
    ===============================
    CORREGIR GEOREFERENCIA
    ===============================
    */

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

    /*
    ===============================
    ALERTA
    ===============================
    */

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

    res.json({
      mensaje:
        "Entrada manual registrada",
      cliente:
        clienteMasCercano.nombre,
      visita:
        visita.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      error:
        "Error al registrar entrada manual",
      detalle:
        error.message
    });
  }
});

module.exports = router;