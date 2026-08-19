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

function numeroValido(valor) {
  const numero = Number(valor);

  return Number.isFinite(numero)
    ? numero
    : null;
}

/*
=================================
OBTENER O CREAR SESIÓN ACTIVA

Normalmente la sesión se crea desde
login-vendedor.html.

Si no existe, se crea una de respaldo
para no perder el seguimiento.
=================================
*/

async function obtenerOCrearSesionActiva(
  vendedorId,
  latitud,
  longitud
) {
  const sesionAbierta = await db.query(
    `
    SELECT *
    FROM sesiones_vendedores
    WHERE vendedor_id = $1
      AND estado = 'ACTIVA'
    ORDER BY inicio_sesion DESC
    LIMIT 1
    `,
    [vendedorId]
  );

  if (sesionAbierta.rows.length > 0) {
    return sesionAbierta.rows[0];
  }

  const nuevaSesion = await db.query(
    `
    INSERT INTO sesiones_vendedores (
      vendedor_id,
      fecha,
      inicio_sesion,
      estado,
      latitud_inicio,
      longitud_inicio,
      ultima_latitud,
      ultima_longitud
    )
    VALUES (
      $1,
      CURRENT_DATE,
      NOW(),
      'ACTIVA',
      $2,
      $3,
      $2,
      $3
    )
    RETURNING *
    `,
    [
      vendedorId,
      latitud,
      longitud
    ]
  );

  return nuevaSesion.rows[0];
}

/*
=================================
ACTUALIZAR SESIÓN CON GPS
=================================
*/

async function actualizarSesionGps(
  vendedorId,
  latitud,
  longitud,
  velocidad
) {
  const sesion =
    await obtenerOCrearSesionActiva(
      vendedorId,
      latitud,
      longitud
    );

  const velocidadNumero =
    numeroValido(velocidad) || 0;

  await db.query(
    `
    UPDATE sesiones_vendedores
    SET
      primer_gps =
        COALESCE(
          primer_gps,
          NOW()
        ),

      primer_movimiento =
        CASE
          WHEN primer_movimiento IS NULL
            AND $4::numeric > 1
          THEN NOW()

          ELSE primer_movimiento
        END,

      ultimo_gps = NOW(),
      ultima_latitud = $2,
      ultima_longitud = $3,
      updated_at = NOW()

    WHERE id = $1
    `,
    [
      sesion.id,
      latitud,
      longitud,
      velocidadNumero
    ]
  );

  return sesion.id;
}

/*
=================================
MARCAR PRIMER CLIENTE
=================================
*/

async function marcarPrimerCliente(
  vendedorId
) {
  await db.query(
    `
    UPDATE sesiones_vendedores
    SET
      primer_cliente =
        COALESCE(
          primer_cliente,
          NOW()
        ),

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
    [vendedorId]
  );
}

/*
=================================
CLIENTES ASIGNADOS
=================================
*/

async function obtenerClientesAsignados(
  vendedorId
) {
  /*
  =================================
  TIPO DE USUARIO
  =================================
  La geocerca debe trabajar con el
  mismo conjunto de clientes que el
  plan diario del vendedor.
  =================================
  */

  const usuarioResult = await db.query(
    `
    SELECT id, rol
    FROM usuarios
    WHERE id = $1
      AND activo = true
    LIMIT 1
    `,
    [vendedorId]
  );

  if (usuarioResult.rows.length === 0) {
    return [];
  }

  const rolUsuario =
    String(
      usuarioResult.rows[0].rol || ""
    ).trim().toUpperCase();

  /*
  =================================
  TRADE COMO REEMPLAZO COMERCIAL
  =================================
  Si Trade está reemplazando una ruta
  hoy, trabaja como vendedor comercial
  y NO con trade_visit_plan.
  =================================
  */

  let tieneReemplazoComercial = false;

  if (rolUsuario === "TRADE_MARKETING") {
    const reemplazoResult = await db.query(
      `
      SELECT rr.id
      FROM reemplazos_ruta rr
      INNER JOIN rutas r
        ON r.id = rr.ruta_id
      WHERE rr.vendedor_reemplazo_id = $1
        AND rr.activo = true
        AND r.activo = true
        AND CURRENT_DATE
            BETWEEN rr.fecha_desde
                AND rr.fecha_hasta
      LIMIT 1
      `,
      [vendedorId]
    );

    tieneReemplazoComercial =
      reemplazoResult.rows.length > 0;
  }

  /*
  =================================
  TRADE MARKETING
  =================================
  Usa exclusivamente el Plan Trade
  correspondiente al día y semana.
  =================================
  */

  if (
    rolUsuario === "TRADE_MARKETING" &&
    !tieneReemplazoComercial
  ) {
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

        COALESCE(
          c.radio_geocerca,
          30
        ) AS radio_geocerca

      FROM trade_visit_plan tvp

      INNER JOIN clientes c
        ON c.id = tvp.cliente_id

      LEFT JOIN frecuencias fr_trade
        ON fr_trade.id = tvp.frecuencia_id

      LEFT JOIN rutas r_trade
        ON r_trade.id = tvp.ruta_trade_id

      WHERE tvp.trade_id = $1
        AND tvp.activo = true

        AND c.deleted_at IS NULL
        AND c.activo = true

        AND c.latitud IS NOT NULL
        AND c.longitud IS NOT NULL
        AND c.latitud <> 0
        AND c.longitud <> 0

        AND (
          r_trade.id IS NULL
          OR r_trade.activo = true
        )

        AND tvp.semana =
          (
            (
              EXTRACT(
                DAY FROM CURRENT_DATE
              )::int - 1
            ) / 7
          ) + 1

        AND (
          (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 1
            AND fr_trade.lunes = true
          )

          OR (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 2
            AND fr_trade.martes = true
          )

          OR (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 3
            AND fr_trade.miercoles = true
          )

          OR (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 4
            AND fr_trade.jueves = true
          )

          OR (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 5
            AND fr_trade.viernes = true
          )

          OR (
            EXTRACT(
              ISODOW FROM CURRENT_DATE
            ) = 6
            AND fr_trade.sabado = true
          )
        )

      ORDER BY
        c.nombre ASC
      `,
      [vendedorId]
    );

    return result.rows;
  }

  /*
  =================================
  VENDEDOR NORMAL / REEMPLAZANTE
  =================================
  Calcula primero quién es el vendedor
  efectivo de cada ruta. Si existe un
  reemplazo vigente, manda el reemplazo.
  Luego aplica semana y frecuencia del
  día igual que el plan comercial.
  =================================
  */

  const result = await db.query(
    `
    WITH rutas_efectivas AS (

      SELECT
        r.id AS ruta_id,

        COALESCE(
          reemplazo.vendedor_reemplazo_id,
          r.vendedor_id
        ) AS vendedor_efectivo_id

      FROM rutas r

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

      ) reemplazo
        ON true

      WHERE r.activo = true
    )

    SELECT DISTINCT
      c.id,
      c.codigo_cliente,
      c.nombre,
      c.direccion,
      c.localidad,
      c.latitud,
      c.longitud,

      COALESCE(
        c.radio_geocerca,
        30
      ) AS radio_geocerca

    FROM clientes c

    LEFT JOIN rutas_efectivas re
      ON re.ruta_id = c.ruta_id

    LEFT JOIN frecuencias fr
      ON fr.id = c.frecuencia_id

    WHERE c.deleted_at IS NULL
      AND c.activo = true

      AND c.latitud IS NOT NULL
      AND c.longitud IS NOT NULL
      AND c.latitud <> 0
      AND c.longitud <> 0

      AND (
        (
          c.ruta_id IS NOT NULL
          AND re.vendedor_efectivo_id = $1
        )

        OR (
          c.ruta_id IS NULL
          AND c.vendedor_id = $1
        )
      )

      AND (
        c.es_ejecucion = false

        OR (
          c.es_ejecucion = true
          AND c.semana_ejecucion IS NOT NULL
          AND c.semana_ejecucion =
            (
              (
                EXTRACT(
                  DAY FROM CURRENT_DATE
                )::int - 1
              ) / 7
            ) + 1
        )
      )

      AND (
        (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 1
          AND fr.lunes = true
        )

        OR (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 2
          AND fr.martes = true
        )

        OR (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 3
          AND fr.miercoles = true
        )

        OR (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 4
          AND fr.jueves = true
        )

        OR (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 5
          AND fr.viernes = true
        )

        OR (
          EXTRACT(
            ISODOW FROM CURRENT_DATE
          ) = 6
          AND fr.sabado = true
        )
      )

    ORDER BY
      c.nombre ASC
    `,
    [vendedorId]
  );

  return result.rows;
}

/*
=================================
CLIENTES DENTRO DE GEOCERCA
=================================
*/

function obtenerCandidatos(
  clientes,
  latActual,
  lngActual
) {
  return clientes
    .map(cliente => {
      const latCliente =
        numeroValido(cliente.latitud);

      const lngCliente =
        numeroValido(cliente.longitud);

      if (
        latCliente === null ||
        lngCliente === null
      ) {
        return null;
      }

      const distancia =
        distanciaMetros(
          latActual,
          lngActual,
          latCliente,
          lngCliente
        );

      const radioGeocerca =
        numeroValido(
          cliente.radio_geocerca
        ) || 30;

      if (
        distancia >
        radioGeocerca
      ) {
        return null;
      }

      return {
        id:
          cliente.id,

        codigo_cliente:
          cliente.codigo_cliente,

        nombre:
          cliente.nombre,

        direccion:
          cliente.direccion,

        localidad:
          cliente.localidad,

        latitud:
          latCliente,

        longitud:
          lngCliente,

        distancia_metros:
          Math.round(distancia),

        radio_geocerca:
          radioGeocerca
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.distancia_metros -
        b.distancia_metros
    );
}

/*
=================================
VISITA ABIERTA
=================================
*/

async function obtenerVisitaAbierta(
  vendedorId
) {
  const result = await db.query(
    `
    SELECT
      v.id,
      v.cliente_id,
      v.hora_llegada,

      c.nombre AS cliente,
      c.latitud,
      c.longitud,

      COALESCE(
        c.radio_geocerca,
        30
      ) AS radio_geocerca

    FROM visitas v

    INNER JOIN clientes c
      ON c.id = v.cliente_id

    WHERE v.vendedor_id = $1
      AND v.fecha = CURRENT_DATE
      AND v.hora_salida IS NULL

    ORDER BY
      v.hora_llegada DESC

    LIMIT 1
    `,
    [vendedorId]
  );

  return result.rows[0] || null;
}

/*
=================================
CERRAR VISITA
=================================
*/

async function cerrarVisita(
  visitaId,
  latitud,
  longitud
) {
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
              NOW() -
              hora_llegada
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
      visitaId,
      latitud,
      longitud
    ]
  );

  return result.rows[0] || null;
}

/*
=================================
ABRIR VISITA
=================================
*/

async function abrirVisita(
  vendedorId,
  clienteId,
  latitud,
  longitud
) {
  const existente =
    await db.query(
      `
      SELECT *
      FROM visitas
      WHERE vendedor_id = $1
        AND cliente_id = $2
        AND fecha = CURRENT_DATE
        AND hora_salida IS NULL
      LIMIT 1
      `,
      [
        vendedorId,
        clienteId
      ]
    );

  if (
    existente.rows.length > 0
  ) {
    await marcarPrimerCliente(
      vendedorId
    );

    return existente.rows[0];
  }

  const result =
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
        clienteId,
        vendedorId,
        latitud,
        longitud
      ]
    );

  await marcarPrimerCliente(
    vendedorId
  );

  return result.rows[0];
}

/*
=================================
GET ÚLTIMOS 100 GPS
=================================
*/

router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT *
      FROM gps_logs
      ORDER BY fecha_hora DESC
      LIMIT 100
      `
    );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error:
        "Error al obtener gps logs",

      detalle:
        error.message
    });
  }
});

/*
=================================
GET ÚLTIMO GPS POR VENDEDOR

Se conserva para compatibilidad con
otras pantallas.

El nuevo mapa usará principalmente:
usuarios/estados-vendedores
=================================
*/

router.get(
  "/ultimos",
  async (req, res) => {
    try {
      const result =
        await db.query(
          `
          SELECT DISTINCT ON (
            g.vendedor_id
          )
            g.id,
            g.vendedor_id,

            TRIM(
              COALESCE(u.nombre, '') ||
              ' ' ||
              COALESCE(u.apellido, '')
            ) AS vendedor,

            g.latitud,
            g.longitud,
            g.precision_metros,
            g.velocidad,
            g.fecha_hora,

            FLOOR(
              EXTRACT(
                EPOCH FROM (
                  NOW() -
                  g.fecha_hora
                )
              ) / 60
            )::INTEGER
              AS minutos_sin_gps

          FROM gps_logs g

          LEFT JOIN usuarios u
            ON u.id = g.vendedor_id

          ORDER BY
            g.vendedor_id,
            g.fecha_hora DESC
          `
        );

      res.json(result.rows);

    } catch (error) {
      res.status(500).json({
        error:
          "Error al obtener últimos GPS",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
RECORRIDO DEL VENDEDOR HOY
=================================
*/

router.get(
  "/vendedor/:id/hoy",
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const result =
        await db.query(
          `
          SELECT
            latitud,
            longitud,
            fecha_hora
          FROM gps_logs
          WHERE vendedor_id = $1
            AND DATE(fecha_hora) =
              CURRENT_DATE

            AND latitud IS NOT NULL
            AND longitud IS NOT NULL
            AND latitud <> 0
            AND longitud <> 0

          ORDER BY
            fecha_hora ASC
          `,
          [id]
        );

      res.json(result.rows);

    } catch (error) {
      res.status(500).json({
        error:
          "Error al obtener recorrido GPS",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
POST GPS MANUAL
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

    const latActual =
      numeroValido(latitud);

    const lngActual =
      numeroValido(longitud);

    if (
      !vendedor_id ||
      latActual === null ||
      lngActual === null ||
      latActual === 0 ||
      lngActual === 0
    ) {
      return res.status(400).json({
        error:
          "Datos GPS inválidos"
      });
    }

    const result =
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NOW()
        )
        RETURNING *
        `,
        [
          vendedor_id,
          latActual,
          lngActual,
          precision_metros || null,
          velocidad || 0
        ]
      );

    await actualizarSesionGps(
      vendedor_id,
      latActual,
      lngActual,
      velocidad
    );

    res.status(201).json({
      mensaje:
        "GPS registrado",

      gps:
        result.rows[0]
    });

  } catch (error) {
    console.error(
      "ERROR GPS MANUAL:",
      error
    );

    res.status(500).json({
      error:
        "Error al registrar GPS",

      detalle:
        error.message
    });
  }
});

/*
=================================
CONFIRMAR CLIENTE ENTRE VARIOS
=================================
*/

router.post(
  "/automatico/confirmar-cliente",
  async (req, res) => {
    try {
      const {
        vendedor_id,
        cliente_id,
        latitud,
        longitud
      } = req.body;

      const latActual =
        numeroValido(latitud);

      const lngActual =
        numeroValido(longitud);

      if (
        !vendedor_id ||
        !cliente_id ||
        latActual === null ||
        lngActual === null ||
        latActual === 0 ||
        lngActual === 0
      ) {
        return res.status(400).json({
          error:
            "Datos inválidos para confirmar el cliente"
        });
      }

      await actualizarSesionGps(
        vendedor_id,
        latActual,
        lngActual,
        0
      );

      const clientes =
        await obtenerClientesAsignados(
          vendedor_id
        );

      const cliente =
        clientes.find(
          item =>
            item.id === cliente_id
        );

      if (!cliente) {
        return res.status(404).json({
          error:
            "El cliente no está activo o no pertenece al vendedor"
        });
      }

      const distancia =
        distanciaMetros(
          latActual,
          lngActual,
          Number(cliente.latitud),
          Number(cliente.longitud)
        );

      const radioGeocerca =
        numeroValido(
          cliente.radio_geocerca
        ) || 30;

      const toleranciaConfirmacion =
        Math.max(
          radioGeocerca,
          50
        );

      if (
        distancia >
        toleranciaConfirmacion
      ) {
        return res.status(400).json({
          error:
            "El cliente seleccionado está demasiado lejos",

          distancia_metros:
            Math.round(distancia),

          radio_permitido:
            toleranciaConfirmacion
        });
      }

      const visitaAbierta =
        await obtenerVisitaAbierta(
          vendedor_id
        );

      if (
        visitaAbierta &&
        visitaAbierta.cliente_id !==
          cliente_id
      ) {
        await cerrarVisita(
          visitaAbierta.id,
          latActual,
          lngActual
        );
      }

      const visita =
        await abrirVisita(
          vendedor_id,
          cliente_id,
          latActual,
          lngActual
        );

      res.json({
        mensaje:
          "Cliente confirmado. Visita iniciada.",

        estado:
          "DENTRO",

        cliente:
          cliente.nombre,

        cliente_id:
          cliente.id,

        distancia_metros:
          Math.round(distancia),

        radio_geocerca:
          radioGeocerca,

        visita_id:
          visita.id,

        visita
      });

    } catch (error) {
      console.error(
        "ERROR CONFIRMANDO CLIENTE:",
        error
      );

      res.status(500).json({
        error:
          "Error al confirmar cliente cercano",

        detalle:
          error.message
      });
    }
  }
);

/*
=================================
GPS AUTOMÁTICO + GEOCERCA
=================================
*/

router.post(
  "/automatico",
  async (req, res) => {
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
      const velocidadActual = numeroValido(velocidad) || 0;

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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NOW()
        )
        `,
        [
          vendedor_id,
          latActual,
          lngActual,
          precision_metros || 8,
          velocidadActual
        ]
      );

      await actualizarSesionGps(
        vendedor_id,
        latActual,
        lngActual,
        velocidadActual
      );

      const visitaAbierta =
        await obtenerVisitaAbierta(vendedor_id);

      /*
      ===============================
      YA HAY UNA VISITA ABIERTA
      ===============================
      */

      if (visitaAbierta) {
        const latCliente =
          numeroValido(visitaAbierta.latitud);

        const lngCliente =
          numeroValido(visitaAbierta.longitud);

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
          await marcarPrimerCliente(vendedor_id);

          return res.json({
            mensaje:
              "GPS recibido. Vendedor sigue dentro del cliente.",
            estado: "DENTRO",
            cliente: visitaAbierta.cliente,
            cliente_id: visitaAbierta.cliente_id,
            distancia_metros: Math.round(distanciaCliente),
            radio_geocerca: radioGeocerca,
            visita_id: visitaAbierta.id
          });
        }

        const visitaCerrada =
          await cerrarVisita(
            visitaAbierta.id,
            latActual,
            lngActual
          );

        /*
        Tras cerrar la visita, se comprueba en el mismo
        GPS si el vendedor ya entró en otro cliente.
        */

        const clientes =
          await obtenerClientesAsignados(vendedor_id);

        const candidatos =
          obtenerCandidatos(
            clientes,
            latActual,
            lngActual
          ).filter(
            cliente =>
              String(cliente.id) !==
              String(visitaAbierta.cliente_id)
          );

        if (candidatos.length === 1) {
          const clienteDentro = candidatos[0];

          const nuevaVisita =
            await abrirVisita(
              vendedor_id,
              clienteDentro.id,
              latActual,
              lngActual
            );

          return res.json({
            mensaje:
              "Salida registrada y nueva llegada detectada.",
            estado: "DENTRO",
            cliente: clienteDentro.nombre,
            cliente_id: clienteDentro.id,
            distancia_metros:
              clienteDentro.distancia_metros,
            radio_geocerca:
              clienteDentro.radio_geocerca,
            visita_id: nuevaVisita.id,
            visita: nuevaVisita,
            visita_anterior: visitaCerrada
          });
        }

        if (candidatos.length > 1) {
          return res.json({
            mensaje:
              "Salida registrada. Hay varios clientes cercanos.",
            estado: "MULTIPLES_CLIENTES",
            clientes: candidatos,
            visita_anterior: visitaCerrada
          });
        }

        return res.json({
          mensaje:
            "GPS recibido. Salida automática registrada.",
          estado: "FUERA",
          visita: visitaCerrada,
          clientes_cercanos: []
        });
      }

      /*
      ===============================
      NO HAY VISITA ABIERTA
      ===============================
      */

      const clientes =
        await obtenerClientesAsignados(vendedor_id);

      const candidatos =
        obtenerCandidatos(
          clientes,
          latActual,
          lngActual
        );

      if (candidatos.length > 1) {
        return res.json({
          mensaje:
            "Hay varios clientes dentro de la geocerca.",
          estado: "MULTIPLES_CLIENTES",
          clientes: candidatos
        });
      }

      if (candidatos.length === 1) {
        const clienteDentro = candidatos[0];

        const visita =
          await abrirVisita(
            vendedor_id,
            clienteDentro.id,
            latActual,
            lngActual
          );

        return res.json({
          mensaje:
            "GPS recibido. Llegada automática registrada.",
          estado: "DENTRO",
          cliente: clienteDentro.nombre,
          cliente_id: clienteDentro.id,
          distancia_metros:
            clienteDentro.distancia_metros,
          radio_geocerca:
            clienteDentro.radio_geocerca,
          visita_id: visita.id,
          visita
        });
      }

      res.json({
        mensaje:
          "GPS recibido. Fuera de clientes.",
        estado: "FUERA"
      });

    } catch (error) {
      console.error(
        "ERROR GPS AUTOMÁTICO:",
        error
      );

      res.status(500).json({
        error: "Error en GPS automático",
        detalle: error.message
      });
    }
  }
);

module.exports = router;