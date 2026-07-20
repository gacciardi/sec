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
    console.error(
      "ERROR OBTENIENDO CLIENTES PARA LOCALIZAR:",
      error
    );

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
GUARDAR LOCALIZACIÓN Y VISITA
=================================
*/

router.post(
  "/clientes/:cliente_id/localizar",
  async (req, res) => {
    const conexion =
      await db.connect();

    let transaccionIniciada = false;

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

      if (!vendedor_id) {
        return res.status(400).json({
          error:
            "Debe indicar el vendedor que está localizando el cliente"
        });
      }

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
      Si la precisión supera los 40 metros,
      se solicita confirmación antes de guardar.
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
      transaccionIniciada = true;

      /*
      =================================
      BUSCAR Y BLOQUEAR CLIENTE
      =================================
      */

      const clienteResult =
        await conexion.query(
          `
          SELECT
            c.id,
            c.codigo_cliente,
            c.nombre,
            c.latitud,
            c.longitud,
            c.vendedor_id
              AS vendedor_directo_id,

            r.vendedor_id
              AS vendedor_ruta_id

          FROM clientes c

          LEFT JOIN rutas r
            ON r.id = c.ruta_id

          WHERE c.id = $1
            AND c.deleted_at IS NULL
            AND c.activo = true

          FOR UPDATE OF c
          `,
          [cliente_id]
        );

      if (
        clienteResult.rows.length === 0
      ) {
        await conexion.query("ROLLBACK");
        transaccionIniciada = false;

        return res.status(404).json({
          error:
            "Cliente no encontrado o inactivo"
        });
      }

      const cliente =
        clienteResult.rows[0];

      /*
      =================================
      VALIDAR VENDEDOR ASIGNADO
      =================================
      */

      const vendedorAsignado =
        cliente.vendedor_directo_id ||
        cliente.vendedor_ruta_id;

      if (
        !vendedorAsignado ||
        String(vendedorAsignado) !==
          String(vendedor_id)
      ) {
        await conexion.query("ROLLBACK");
        transaccionIniciada = false;

        return res.status(403).json({
          error:
            "El cliente no pertenece al vendedor seleccionado"
        });
      }

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

      /*
      =================================
      GUARDAR HISTORIAL
      =================================
      */

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
            vendedor_id,
            latAnterior,
            lngAnterior,
            latNueva,
            lngNueva,
            precision,
            distanciaCambio
          ]
        );

      /*
      =================================
      ACTUALIZAR SOLO COORDENADAS
      =================================
      */

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

      /*
      =================================
      CERRAR OTRA VISITA ABIERTA

      Si existía una visita abierta para
      otro cliente, se la cierra antes de
      iniciar la visita actual.
      =================================
      */

      const visitasCerradas =
        await conexion.query(
          `
          UPDATE visitas
          SET
            hora_salida = NOW(),

            permanencia_segundos =
              GREATEST(
                0,
                EXTRACT(
                  EPOCH FROM (
                    NOW() -
                    hora_llegada
                  )
                )::INTEGER
              ),

            latitud_salida = $2,
            longitud_salida = $3

          WHERE vendedor_id = $1
            AND fecha = CURRENT_DATE
            AND hora_salida IS NULL
            AND cliente_id <> $4

          RETURNING *
          `,
          [
            vendedor_id,
            latNueva,
            lngNueva,
            cliente_id
          ]
        );

      /*
      =================================
      BUSCAR VISITA ABIERTA DEL CLIENTE
      =================================
      */

      const visitaAbiertaResult =
        await conexion.query(
          `
          SELECT *
          FROM visitas

          WHERE vendedor_id = $1
            AND cliente_id = $2
            AND fecha = CURRENT_DATE
            AND hora_salida IS NULL

          ORDER BY hora_llegada DESC
          LIMIT 1
          `,
          [
            vendedor_id,
            cliente_id
          ]
        );

      let visita;
      let visitaCreada = false;

      /*
      Si ya estaba abierta, no se duplica.
      Si no existía, se crea inmediatamente.
      */

      if (
        visitaAbiertaResult.rows.length > 0
      ) {
        visita =
          visitaAbiertaResult.rows[0];

      } else {
        const nuevaVisita =
          await conexion.query(
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
              latNueva,
              lngNueva
            ]
          );

        visita =
          nuevaVisita.rows[0];

        visitaCreada = true;
      }

      /*
      =================================
      MARCAR PRIMER CLIENTE DE LA SESIÓN
      =================================
      */

      await conexion.query(
        `
        UPDATE sesiones_vendedores
        SET
          primer_cliente =
            COALESCE(
              primer_cliente,
              NOW()
            ),

          ultima_latitud = $2,
          ultima_longitud = $3,
          ultimo_gps = NOW(),
          updated_at = NOW()

        WHERE id = (
          SELECT id
          FROM sesiones_vendedores
          WHERE vendedor_id = $1
            AND estado = 'ACTIVA'
          ORDER BY inicio_sesion DESC
          LIMIT 1
        )
        `,
        [
          vendedor_id,
          latNueva,
          lngNueva
        ]
      );

      await conexion.query("COMMIT");
      transaccionIniciada = false;

      res.json({
        mensaje:
          "Cliente localizado y marcado como visitado",

        estado:
          "DENTRO",

        cliente_visitado:
          true,

        visita_creada:
          visitaCreada,

        cliente: {
          id:
            cliente.id,

          codigo_cliente:
            cliente.codigo_cliente,

          nombre:
            cliente.nombre
        },

        cliente_id:
          cliente.id,

        visita_id:
          visita.id,

        visita,

        visitas_anteriores_cerradas:
          visitasCerradas.rows.length,

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
      if (transaccionIniciada) {
        try {
          await conexion.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "ERROR HACIENDO ROLLBACK:",
            rollbackError
          );
        }
      }

      console.error(
        "ERROR GUARDANDO LOCALIZACIÓN Y VISITA:",
        error
      );

      res.status(500).json({
        error:
          "Error al guardar la localización y registrar la visita",

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
      console.error(
        "ERROR OBTENIENDO HISTORIAL:",
        error
      );

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