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

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function numeroValido(valor) {
  const numero = Number(valor);

  return Number.isFinite(numero)
    ? numero
    : null;
}

/*
=================================
LISTADO DE CLIENTES
=================================
*/

router.get("/clientes", async (req, res) => {
  try {
    const buscar =
      String(req.query.buscar || "").trim();

    const vendedorId =
      req.query.vendedor_id || null;

    const estado =
      String(req.query.estado || "todos");

    const result = await db.query(
      `
      SELECT
        c.id,
        c.codigo_cliente,
        c.nombre,
        c.direccion,
        c.localidad,
        c.latitud,
        c.longitud,
        c.radio_geocerca,
        c.activo,

        r.id AS ruta_id,
        r.nombre AS ruta,

        COALESCE(
          uv.id,
          ur.id
        ) AS vendedor_id,

        COALESCE(
          uv.nombre || ' ' || uv.apellido,
          ur.nombre || ' ' || ur.apellido
        ) AS vendedor,

        ultima.fecha_hora
          AS ultima_localizacion,

        ultima.precision_metros
          AS ultima_precision,

        CASE
          WHEN ultima.id IS NULL
          THEN false
          ELSE true
        END AS localizado

      FROM clientes c

      LEFT JOIN rutas r
        ON r.id = c.ruta_id

      LEFT JOIN usuarios uv
        ON uv.id = c.vendedor_id

      LEFT JOIN usuarios ur
        ON ur.id = r.vendedor_id

      LEFT JOIN LATERAL (
        SELECT
          l.id,
          l.fecha_hora,
          l.precision_metros
        FROM localizaciones_clientes l
        WHERE l.cliente_id = c.id
        ORDER BY l.fecha_hora DESC
        LIMIT 1
      ) ultima ON true

      WHERE c.deleted_at IS NULL
        AND c.activo = true

        AND (
          $1::text = ''
          OR c.codigo_cliente ILIKE '%' || $1 || '%'
          OR c.nombre ILIKE '%' || $1 || '%'
          OR c.direccion ILIKE '%' || $1 || '%'
          OR c.localidad ILIKE '%' || $1 || '%'
        )

        AND (
          $2::uuid IS NULL
          OR c.vendedor_id = $2
          OR r.vendedor_id = $2
        )

        AND (
          $3 = 'todos'
          OR (
            $3 = 'pendientes'
            AND ultima.id IS NULL
          )
          OR (
            $3 = 'localizados'
            AND ultima.id IS NOT NULL
          )
        )

      ORDER BY
        COALESCE(
          uv.nombre,
          ur.nombre,
          ''
        ),
        c.nombre
      `,
      [
        buscar,
        vendedorId,
        estado
      ]
    );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error:
        "Error al obtener clientes para localizar",

      detalle:
        error.message
    });
  }
});

/*
=================================
GUARDAR NUEVA LOCALIZACIÓN
=================================
*/

router.post(
  "/clientes/:cliente_id/localizar",
  async (req, res) => {
    const conexion =
      await db.connect();

    try {
      const { cliente_id } =
        req.params;

      const {
        vendedor_id,
        latitud,
        longitud,
        precision_metros,
        confirmar_precision_baja
      } = req.body;

      const latNueva =
        numeroValido(latitud);

      const lngNueva =
        numeroValido(longitud);

      const precision =
        numeroValido(precision_metros);

      if (
        latNueva === null ||
        lngNueva === null ||
        latNueva === 0 ||
        lngNueva === 0
      ) {
        return res.status(400).json({
          error:
            "La ubicación GPS recibida no es válida"
        });
      }

      if (
        latNueva < -90 ||
        latNueva > 90 ||
        lngNueva < -180 ||
        lngNueva > 180
      ) {
        return res.status(400).json({
          error:
            "Las coordenadas están fuera de rango"
        });
      }

      /*
      La precisión del celular no se compara con
      la coordenada vieja.

      Si supera 40 metros, se pide una confirmación
      especial, pero nunca se impide corregir una
      coordenada anterior que estuviera muy lejos.
      */

      if (
        precision !== null &&
        precision > 40 &&
        confirmar_precision_baja !== true
      ) {
        return res.status(409).json({
          requiere_confirmacion: true,

          error:
            `La precisión GPS actual es de ` +
            `${Math.round(precision)} metros.`,

          mensaje:
            "Podés esperar mejor señal o confirmar igualmente."
        });
      }

      await conexion.query("BEGIN");

      const clienteResult =
        await conexion.query(
          `
          SELECT
            id,
            codigo_cliente,
            nombre,
            latitud,
            longitud
          FROM clientes
          WHERE id = $1
            AND deleted_at IS NULL
          FOR UPDATE
          `,
          [cliente_id]
        );

      if (
        clienteResult.rows.length === 0
      ) {
        await conexion.query("ROLLBACK");

        return res.status(404).json({
          error:
            "Cliente no encontrado"
        });
      }

      const cliente =
        clienteResult.rows[0];

      const latAnterior =
        numeroValido(cliente.latitud);

      const lngAnterior =
        numeroValido(cliente.longitud);

      let distanciaCambio = null;

      if (
        latAnterior !== null &&
        lngAnterior !== null
      ) {
        distanciaCambio =
          distanciaMetros(
            latAnterior,
            lngAnterior,
            latNueva,
            lngNueva
          );
      }

      const historial =
        await conexion.query(
          `
          INSERT INTO localizaciones_clientes (
            cliente_id,
            vendedor_id,
            latitud_anterior,
            longitud_anterior,
            latitud_nueva,
            longitud_nueva,
            precision_metros,
            distancia_cambio_metros,
            fecha_hora
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NOW()
          )
          RETURNING *
          `,
          [
            cliente_id,
            vendedor_id || null,
            latAnterior,
            lngAnterior,
            latNueva,
            lngNueva,
            precision,
            distanciaCambio
          ]
        );

      await conexion.query(
        `
        UPDATE clientes
        SET
          latitud = $1,
          longitud = $2,
          updated_at = NOW()
        WHERE id = $3
        `,
        [
          latNueva,
          lngNueva,
          cliente_id
        ]
      );

      await conexion.query("COMMIT");

      res.json({
        mensaje:
          "Cliente localizado correctamente",

        cliente: {
          id:
            cliente.id,

          codigo_cliente:
            cliente.codigo_cliente,

          nombre:
            cliente.nombre
        },

        coordenada_anterior: {
          latitud:
            latAnterior,

          longitud:
            lngAnterior
        },

        coordenada_nueva: {
          latitud:
            latNueva,

          longitud:
            lngNueva
        },

        precision_metros:
          precision,

        distancia_cambio_metros:
          distanciaCambio === null
            ? null
            : Math.round(distanciaCambio),

        localizacion:
          historial.rows[0]
      });

    } catch (error) {
      await conexion.query("ROLLBACK");

      res.status(500).json({
        error:
          "Error al guardar la localización",

        detalle:
          error.message
      });

    } finally {
      conexion.release();
    }
  }
);

/*
=================================
HISTORIAL DE UN CLIENTE
=================================
*/

router.get(
  "/clientes/:cliente_id/historial",
  async (req, res) => {
    try {
      const { cliente_id } =
        req.params;

      const result = await db.query(
        `
        SELECT
          l.*,

          u.nombre || ' ' || u.apellido
            AS vendedor

        FROM localizaciones_clientes l

        LEFT JOIN usuarios u
          ON u.id = l.vendedor_id

        WHERE l.cliente_id = $1

        ORDER BY l.fecha_hora DESC
        `,
        [cliente_id]
      );

      res.json(result.rows);

    } catch (error) {
      res.status(500).json({
        error:
          "Error al obtener historial de localización",

        detalle:
          error.message
      });
    }
  }
);

module.exports = router;